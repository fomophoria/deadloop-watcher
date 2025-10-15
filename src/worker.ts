import "dotenv/config";
import { ethers } from "ethers";
import { Prisma, PrismaClient } from "@prisma/client";

/* ────────────────────────────────────────────────────────────────────────── */
/* Env + validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const must = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var: ${k}`);
    return v;
};

const num = (k: string, def: number) => {
    const v = process.env[k];
    if (v == null || v === "") return def;
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`Env ${k} must be a number`);
    return n;
};

const assertAddress = (label: string, addr: string) => {
    if (!ethers.isAddress(addr)) throw new Error(`${label} is not a valid 0x address: ${addr}`);
};

const RPC_WSS = must("RPC_WSS");
const RPC_HTTP = must("RPC_HTTP");
const TOKEN_ADDRESS = must("TOKEN_ADDRESS");
const REWARD_RECIPIENT = must("REWARD_RECIPIENT").toLowerCase();
const DEAD_ADDRESS = must("DEAD_ADDRESS").toLowerCase();
const PRIVATE_KEY = must("PRIVATE_KEY");

const TOKEN_DECIMALS = num("TOKEN_DECIMALS", 18);
const MIN_TOKEN_TO_ACT = num("MIN_TOKEN_TO_ACT", 0);
const DELAY_MS_AFTER_EVENT = num("DELAY_MS_AFTER_EVENT", 3000);
const STARTUP_SWEEP = process.env.STARTUP_SWEEP === "1" || process.env.STARTUP_SWEEP === "true";

assertAddress("TOKEN_ADDRESS", TOKEN_ADDRESS);
assertAddress("REWARD_RECIPIENT", REWARD_RECIPIENT);
assertAddress("DEAD_ADDRESS", DEAD_ADDRESS);

/* ────────────────────────────────────────────────────────────────────────── */
/* Globals                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

const prisma = new PrismaClient();

// Include transfer/balanceOf to satisfy TS for ethers v6
const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function transfer(address to, uint256 amount) returns (bool)",
];

const providerHttp = new ethers.JsonRpcProvider(RPC_HTTP);
const providerWs = new ethers.WebSocketProvider(RPC_WSS);

const signer = new ethers.Wallet(PRIVATE_KEY, providerHttp);

// Read-only contract (HTTP) and with signer for sending tx
const contract = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, providerHttp);
const contractSigner = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, signer);

// Separate instance bound to WS for events (ethers v6)
const contractWs = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, providerWs);

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function toHumanDecimal(raw: bigint): Prisma.Decimal {
    return new Prisma.Decimal(raw.toString()).div(new Prisma.Decimal(10).pow(TOKEN_DECIMALS));
}

async function recordBurnRow(opts: {
    txHash: string;
    amount: bigint;
    blockNumber?: number | null;
}) {
    const { txHash, amount, blockNumber } = opts;

    // get a good timestamp (prefer block timestamp if available)
    let timestamp = new Date();
    if (blockNumber != null) {
        const block = await providerHttp.getBlock(blockNumber);
        if (block) timestamp = new Date(Number(block.timestamp) * 1000);
    }

    const amountHuman = toHumanDecimal(amount);

    try {
        // txHash is unique in your schema; upsert prevents duplicates if retried
        await prisma.burn.upsert({
            where: { txHash: txHash.toLowerCase() },
            update: {},
            create: {
                txHash: txHash.toLowerCase(),
                fromAddress: REWARD_RECIPIENT,              // already lowercased earlier
                toAddress: DEAD_ADDRESS,                    // already lowercased earlier
                tokenAddress: TOKEN_ADDRESS.toLowerCase(),
                amountRaw: amount.toString(),
                amountHuman,                                // Prisma.Decimal
                timestamp,
            },
        });
        console.log(`📝 Recorded burn row for tx=${txHash}`);
    } catch (e) {
        console.error("Failed to record burn row:", e);
    }
}

async function burnBalance(reason: string) {
    const bal = (await contract.balanceOf(REWARD_RECIPIENT)) as bigint;

    // Respect optional MIN_TOKEN_TO_ACT threshold if you use it
    if (MIN_TOKEN_TO_ACT > 0 && Number(bal) / 10 ** TOKEN_DECIMALS < MIN_TOKEN_TO_ACT) {
        console.log(
            `🧹 ${reason}: balance ${Number(bal) / 10 ** TOKEN_DECIMALS} < MIN_TOKEN_TO_ACT=${MIN_TOKEN_TO_ACT} — skipping`
        );
        return;
    }

    if (bal > 0n) {
        const human = Number(bal) / 10 ** TOKEN_DECIMALS;
        console.log(`🧹 ${reason}: burning ${human} tokens`);

        // Send burn tx
        const tx = await contractSigner.transfer(DEAD_ADDRESS, bal);
        console.log(`→ TX: ${tx.hash}`);

        const rcpt = await tx.wait();
        console.log(`✅ Burned ${human} tokens in block ${rcpt?.blockNumber}`);

        // Log to DB (so the dashboard sees it immediately)
        await recordBurnRow({ txHash: tx.hash, amount: bal, blockNumber: rcpt?.blockNumber ?? null });
    } else {
        console.log(`🧹 ${reason}: no tokens to burn`);
    }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Startup + Event Watching                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

async function main() {
    console.log("Watcher online ✅");
    console.log(`Token: ${TOKEN_ADDRESS}`);
    console.log(`Listening for transfers to: ${REWARD_RECIPIENT}`);
    console.log(`NOTE: TOKEN_DECIMALS=${TOKEN_DECIMALS}`);

    if (STARTUP_SWEEP) {
        await burnBalance("Startup sweep");
    }

    // In ethers v6, listen with the contract instance bound to WS
    const filter = contractWs.filters.Transfer(null, REWARD_RECIPIENT);

    contractWs.on(filter, async (from: string, _to: string, value: bigint /*, event */) => {
        const human = Number(value) / 10 ** TOKEN_DECIMALS;
        console.log(`📥 Transfer detected: ${human} tokens from ${from}`);
        await new Promise((r) => setTimeout(r, DELAY_MS_AFTER_EVENT));
        await burnBalance("Event-triggered burn");
    });

    // ethers v6: valid events include "error", "block", "network", "poll", etc.
    // (Do not add a 'close' handler; it's not a ProviderEvent in v6.)
    providerWs.on("error", (err) => {
        console.error("WebSocket provider error:", err);
    });
}

main().catch(console.error);
// build stamp
