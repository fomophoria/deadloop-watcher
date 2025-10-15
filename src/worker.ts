# Base Token Burner — Full Rewrite

Below are ** complete replacements ** for your three files.They switch from WebSocket subscriptions(unreliable on Base) to ** HTTP polling with block cursors **, add ** idempotency ** (no duplicate burns), and include a ** checkpoint ** so the worker resumes where it left off. 

---

## `schema.prisma`
    ```prisma
// schema.prisma
// Prisma 5.x
// Adds a Cursor table for last processed block and strengthens Burn uniqueness.

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = env("DATABASE_PROVIDER") // e.g. "postgresql" or "sqlite"
  url      = env("DATABASE_URL")
}

model Burn {
  id           String   @id @default(cuid())
  txHash       String
  logIndex     Int
  blockNumber  Int
  tokenAddress String
  from         String
  to           String
  value        String   // store raw uint256 as decimal string
  timestamp    DateTime
  createdAt    DateTime @default(now())

  @@unique([txHash, logIndex])
  @@index([blockNumber])
  @@index([timestamp])
  @@index([tokenAddress])
}

model Cursor {
  // One row per token address
  tokenAddress String @id
  lastBlock    Int
  updatedAt    DateTime @updatedAt
}
```

    > After editing the schema, run:
> - `npx prisma generate`
    > - If you use migrations: `npx prisma migrate dev -n "add_burn_cursor"`

---

## `src/worker.ts`
    ```ts
// src/worker.ts
import "dotenv/config";
import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";

/**
 * Reliable Base listener using HTTP polling.
 * - Queries Transfer(to == BURN_ADDRESS) logs in block batches.
 * - Persists a Cursor per token so we never reprocess.
 * - Idempotent via unique (txHash, logIndex).
 */

// ==== Env ==== //
function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${ name } `);
  return v;
}

const RPC_HTTP = must("RPC_HTTP");              // e.g. https://mainnet.base.org
const TOKEN_ADDRESS = must("TOKEN_ADDRESS");    // ERC20 address to watch
const BURN_ADDRESS  = must("BURN_ADDRESS");     // address receiving tokens to be treated as burned
const START_BLOCK   = Number(process.env.START_BLOCK || 0); // fallback if no cursor
const BATCH_SIZE    = Number(process.env.BATCH_SIZE || 2000);
const POLL_MS       = Number(process.env.POLL_INTERVAL_MS || 6000);

const provider = new ethers.JsonRpcProvider(RPC_HTTP);
const prisma = new PrismaClient();

// Minimal ERC20 ABI
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, provider);

async function getCursor(): Promise<number> {
  const row = await prisma.cursor.findUnique({ where: { tokenAddress: TOKEN_ADDRESS.toLowerCase() } });
  if (!row) return START_BLOCK || (await provider.getBlockNumber());
  return row.lastBlock;
}

async function setCursor(block: number) {
  await prisma.cursor.upsert({
    where: { tokenAddress: TOKEN_ADDRESS.toLowerCase() },
    create: { tokenAddress: TOKEN_ADDRESS.toLowerCase(), lastBlock: block },
    update: { lastBlock: block },
  });
}

async function processRange(fromBlock: number, toBlock: number) {
  if (toBlock < fromBlock) return;
  // Filter: Transfer(any, BURN_ADDRESS)
  const filter = token.filters.Transfer(null, BURN_ADDRESS);
  const logs = await token.queryFilter(filter, fromBlock, toBlock);

  if (logs.length === 0) {
    console.log(`No burns between blocks ${ fromBlock } -${ toBlock } `);
    return;
  }

  console.log(`Found ${ logs.length } burn transfers between ${ fromBlock } -${ toBlock } `);

  for (const log of logs) {
    const { transactionHash, index, blockNumber, args } = log as unknown as {
      transactionHash: string;
      index: number; // logIndex in ethers v6
      blockNumber: number;
      args: { from: string; to: string; value: bigint };
    };

    if (!args) continue;
    const from = (args.from as string).toLowerCase();
    const to = (args.to as string).toLowerCase();
    if (to !== BURN_ADDRESS.toLowerCase()) continue; // double guard

    const block = await provider.getBlock(blockNumber);
    const ts = new Date(Number(block.timestamp) * 1000);

    try {
      await prisma.burn.create({
        data: {
          txHash: transactionHash.toLowerCase(),
          logIndex: index,
          blockNumber,
          tokenAddress: TOKEN_ADDRESS.toLowerCase(),
          from,
          to,
          value: args.value.toString(),
          timestamp: ts,
        },
      });
      console.log(`✅ Recorded burn tx = ${ transactionHash } value = ${ args.value.toString() } `);
    } catch (e: any) {
      if (e.code === "P2002") {
        // Unique constraint violated -> already processed
        console.log(`↪︎ Duplicate(skipped) tx = ${ transactionHash } logIndex = ${ index } `);
      } else {
        console.error(`Error saving burn for tx = ${ transactionHash }: `, e);
      }
    }
  }
}

async function run() {
  console.log("Watcher online ✅");
  console.log(`Token: ${ TOKEN_ADDRESS } `);
  console.log(`Listening for transfers to: ${ BURN_ADDRESS } `);

  let cursor = await getCursor();
  const latestAtStart = await provider.getBlockNumber();
  if (cursor === 0) cursor = latestAtStart;

  // Initial catch-up from cursor to latest
  while (true) {
    const latest = await provider.getBlockNumber();
    if (cursor >= latest) break;

    const to = Math.min(cursor + BATCH_SIZE, latest);
    await processRange(cursor + 1, to);
    cursor = to;
    await setCursor(cursor);
  }

  console.log("🌀 Entering polling loop...");

  // Poll new blocks periodically
  setInterval(async () => {
    try {
      const latest = await provider.getBlockNumber();
      if (latest > cursor) {
        const to = latest;
        // Process in sub-batches to avoid huge queries
        let from = cursor + 1;
        while (from <= to) {
          const end = Math.min(from + BATCH_SIZE - 1, to);
          await processRange(from, end);
          cursor = end;
          await setCursor(cursor);
          from = end + 1;
        }
      }
    } catch (e) {
      console.error("Polling error:", e);
    }
  }, POLL_MS);
}

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

---

## `src/backfill.ts`
    ```ts
/**
 * src/backfill.ts
 * Backfill burns: ERC20 Transfer(from:any -> to:BURN_ADDRESS) over a historical block range.
 */
import "dotenv/config";
import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${ name } `);
  return v;
}

const RPC_HTTP = must("RPC_HTTP");
const TOKEN_ADDRESS = must("TOKEN_ADDRESS");
const BURN_ADDRESS = must("BURN_ADDRESS");
const FROM_BLOCK = Number(must("BACKFILL_FROM_BLOCK")); // explicit start
const TO_BLOCK = Number(process.env.BACKFILL_TO_BLOCK || 0); // 0 = latest
const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE || 4000);

const provider = new ethers.JsonRpcProvider(RPC_HTTP);
const prisma = new PrismaClient();

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, provider);

async function saveBurn(log: any) {
  const { transactionHash, index, blockNumber, args } = log as unknown as {
    transactionHash: string;
    index: number;
    blockNumber: number;
    args: { from: string; to: string; value: bigint };
  };

  const from = args.from.toLowerCase();
  const to = args.to.toLowerCase();
  if (to !== BURN_ADDRESS.toLowerCase()) return;

  const block = await provider.getBlock(blockNumber);
  const ts = new Date(Number(block.timestamp) * 1000);

  try {
    await prisma.burn.create({
      data: {
        txHash: transactionHash.toLowerCase(),
        logIndex: index,
        blockNumber,
        tokenAddress: TOKEN_ADDRESS.toLowerCase(),
        from,
        to,
        value: args.value.toString(),
        timestamp: ts,
      },
    });
    console.log(`✅ Backfilled tx = ${ transactionHash } `);
  } catch (e: any) {
    if (e.code === "P2002") {
      console.log(`↪︎ Duplicate(skipped) tx = ${ transactionHash } logIndex = ${ index } `);
    } else {
      console.error(`Error saving backfill tx = ${ transactionHash }: `, e);
    }
  }
}

async function main() {
  const latest = TO_BLOCK || (await provider.getBlockNumber());
  console.log(`Backfilling ${ TOKEN_ADDRESS } to ${ BURN_ADDRESS } from ${ FROM_BLOCK } to ${ latest } (batch ${ BATCH_SIZE })`);

  let from = FROM_BLOCK;
  while (from <= latest) {
    const to = Math.min(from + BATCH_SIZE - 1, latest);
    const filter = token.filters.Transfer(null, BURN_ADDRESS);
    const logs = await token.queryFilter(filter, from, to);

    if (logs.length > 0) {
      console.log(`Range ${ from } -${ to }: ${ logs.length } burns`);
      for (const log of logs) {
        await saveBurn(log);
      }
    } else {
      console.log(`Range ${ from } -${ to }: 0 burns`);
    }

    from = to + 1;
  }

  console.log("✅ Backfill complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

---

## ✅ Env checklist(Railway)
Set these in your Railway variables:
```
RPC_HTTP=https://mainnet.base.org
TOKEN_ADDRESS=0x30B7e85C723d5Fb90CCE208063e0ECbf3eA29b07
BURN_ADDRESS=0xe8bb28baba6090f35d513b41cfb25542b0be0d85
START_BLOCK=12345678              # first block after token deploy (optional but recommended)
POLL_INTERVAL_MS=6000
BATCH_SIZE=2000

# Backfill-only vars if you run src/backfill.ts
BACKFILL_FROM_BLOCK=12345678
BACKFILL_TO_BLOCK=0               # 0 = latest
BACKFILL_BATCH_SIZE=4000

# Prisma
DATABASE_PROVIDER=postgresql       # or sqlite/mysql
DATABASE_URL=postgresql://...
```

---

## 🧪 How to run
1. Generate client & (optionally) migrate
    - `npx prisma generate`
    - `npx prisma migrate deploy`(prod) or`npx prisma migrate dev`
2. Build: `tsc -p tsconfig.json`
3. Start worker: `node dist/worker.js`
4.(Optional) Backfill history: `node dist/backfill.js`

This setup should resolve the "watcher online but no burns" issue by avoiding WebSockets and ensuring logs are processed and persisted with deduplication and a reliable cursor.
