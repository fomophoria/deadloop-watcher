/**
 * src/backfill.ts
 * Backfill burns: ERC20 Transfer from REWARD_RECIPIENT -> DEAD_ADDRESS
 * Batches in 10-block windows for Alchemy free tier.
 */

import "dotenv/config";
import { ethers } from "ethers";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// --- ENV ---
const RPC_HTTP = process.env.RPC_HTTP!;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS!;
const REWARD_RECIPIENT = process.env.REWARD_RECIPIENT!.toLowerCase();
const DEAD_ADDRESS = process.env.DEAD_ADDRESS!.toLowerCase();
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS ?? "18");

// --- PROVIDER / CONTRACT ---
const provider = new ethers.JsonRpcProvider(RPC_HTTP);
const abi = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const iface = new ethers.Interface(abi);

// Start at token deployment block (you said 36,841,703)
const START_BLOCK = 36841703;
// Alchemy free plan: 10-block eth_getLogs limit
const STEP = 10;

// Build a narrow topics filter so the node returns only relevant logs
const burnTopics = [
    ethers.id("Transfer(address,address,uint256)"),
    ethers.zeroPadValue(REWARD_RECIPIENT, 32), // indexed "from"
    ethers.zeroPadValue(DEAD_ADDRESS, 32),     // indexed "to"
];

async function main() {
    console.log("Fetching historical burns…");
    const latestBlock = await provider.getBlockNumber();
    console.log(
        `Scanning Transfer(from=${REWARD_RECIPIENT}, to=${DEAD_ADDRESS}) from block ${START_BLOCK} to ${latestBlock}`
    );

    let burnCount = 0;
    let totalHuman = new Prisma.Decimal(0);

    for (let fromBlock = START_BLOCK; fromBlock <= latestBlock; fromBlock += STEP) {
        const toBlock = Math.min(fromBlock + STEP - 1, latestBlock);

        try {
            const logs = await provider.getLogs({
                address: TOKEN_ADDRESS,
                topics: burnTopics,
                fromBlock,
                toBlock,
            });

            if (logs.length > 0) {
                console.log(`📦 ${logs.length} burn logs from blocks ${fromBlock}–${toBlock}`);
            }

            for (const l of logs) {
                // parseLog can throw or be incompatible at type-level; protect it.
                let parsed: ReturnType<typeof iface.parseLog> | null = null;
                try {
                    parsed = iface.parseLog({ topics: l.topics, data: l.data });
                } catch {
                    // Not a matching log; skip defensively
                    continue;
                }
                if (!parsed) continue;

                const args = parsed.args as unknown as { from: string; to: string; value: bigint };
                const from = args.from.toLowerCase();
                const to = args.to.toLowerCase();
                const value = args.value;

                // Double-check the pair (defensive)
                if (from !== REWARD_RECIPIENT || to !== DEAD_ADDRESS) continue;

                const humanStr = ethers.formatUnits(value, TOKEN_DECIMALS); // string
                const amountHuman = new Prisma.Decimal(humanStr);

                burnCount += 1;
                totalHuman = totalHuman.add(amountHuman);

                console.log(
                    `🔥 Burn found: ${humanStr} tokens — ${from} → ${to} | tx=${l.transactionHash}`
                );

                await prisma.burn.upsert({
                    where: { txHash: l.transactionHash },
                    update: {},
                    create: {
                        txHash: l.transactionHash,
                        fromAddress: from,
                        toAddress: to,
                        tokenAddress: TOKEN_ADDRESS,
                        amountRaw: value.toString(),
                        amountHuman, // Decimal (exact)
                    },
                });
            }
        } catch (err) {
            const msg = (err as Error)?.message ?? String(err);
            console.error(`⚠️  Error fetching ${fromBlock}–${toBlock}: ${msg}`);
            // brief cooldown to avoid provider throttling
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    console.log("Backfill complete ✅");
    console.log(`🔥 Total burns recorded: ${burnCount}`);
    console.log(`💰 Total tokens burned: ${totalHuman.toString()} units`);

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error("Fatal error in backfill:", err);
    await prisma.$disconnect();
});
