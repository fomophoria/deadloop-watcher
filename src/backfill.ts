/**
 * src/backfill.ts
 * Backfill burns: ERC20 Transfer from REWARD_RECIPIENT -> DEAD_ADDRESS
 * Batches in 10-block windows for Alchemy free tier.
 */

import "dotenv/config";
import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// --- ENV ---
const RPC_HTTP = process.env.RPC_HTTP!;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS!;
const REWARD_RECIPIENT = process.env.REWARD_RECIPIENT!.toLowerCase();
const DEAD_ADDRESS = process.env.DEAD_ADDRESS!.toLowerCase();
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS ?? "18");

// --- PROVIDER / CONTRACT ---
const provider = new ethers.JsonRpcProvider(RPC_HTTP);
const token = new ethers.Contract(
    TOKEN_ADDRESS,
    ["event Transfer(address indexed from, address indexed to, uint256 value)"],
    provider
);

// Start at token deployment block (you said 36,841,703)
const START_BLOCK = 36841703;
// Alchemy free plan: 10-block eth_getLogs limit
const STEP = 10;

async function main() {
    console.log("Fetching historical burns…");
    const latestBlock = await provider.getBlockNumber();
    console.log(
        `Scanning Transfer(from=${REWARD_RECIPIENT}, to=${DEAD_ADDRESS}) from block ${START_BLOCK} to ${latestBlock}`
    );

    // Ethers v6: build an indexed filter to only fetch matching from/to
    // This dramatically reduces logs returned.
    const burnFilter = {
        address: TOKEN_ADDRESS,
        topics: [
            ethers.id("Transfer(address,address,uint256)"),
            ethers.zeroPadValue(REWARD_RECIPIENT, 32), // indexed "from"
            ethers.zeroPadValue(DEAD_ADDRESS, 32),     // indexed "to"
        ],
    };

    let burnCount = 0;
    let totalHuman = 0;

    for (let fromBlock = START_BLOCK; fromBlock <= latestBlock; fromBlock += STEP) {
        const toBlock = Math.min(fromBlock + STEP - 1, latestBlock);

        try {
            // Query only the logs matching from/to using provider.getLogs
            const logs = await provider.getLogs({ ...burnFilter, fromBlock, toBlock });

            if (logs.length > 0) {
                console.log(`📦 ${logs.length} burn logs from blocks ${fromBlock}–${toBlock}`);
            }

            for (const l of logs) {
                // Parse the log with the contract interface to extract args
                const parsed = token.interface.parseLog({ topics: l.topics, data: l.data });
                const { from, to, value } = parsed.args as unknown as {
                    from: string;
                    to: string;
                    value: bigint;
                };

                const txHash = l.transactionHash;
                const fromLc = from.toLowerCase();
                const toLc = to.toLowerCase();

                // Double-check (defensive) the from/to pair matches what we expect
                if (fromLc !== REWARD_RECIPIENT || toLc !== DEAD_ADDRESS) continue;

                const amountHuman = Number(ethers.formatUnits(value, TOKEN_DECIMALS));
                burnCount += 1;
                totalHuman += amountHuman;

                console.log(
                    `🔥 Burn found: ${amountHuman} tokens — ${fromLc} → ${toLc} | tx=${txHash}`
                );

                await prisma.burn.upsert({
                    where: { txHash },
                    update: {},
                    create: {
                        txHash,
                        fromAddress: fromLc,
                        toAddress: toLc,
                        tokenAddress: TOKEN_ADDRESS,
                        amountRaw: value.toString(),
                        amountHuman, // Prisma Decimal in schema; JS Number OK for typical human amounts
                    },
                });
            }
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.error(`⚠️  Error fetching ${fromBlock}–${toBlock}: ${msg}`);
            // brief cooldown to avoid provider throttling
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    console.log("Backfill complete ✅");
    console.log(`🔥 Total burns recorded: ${burnCount}`);
    console.log(`💰 Total tokens burned: ${totalHuman.toLocaleString()} units`);

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error("Fatal error in backfill:", err);
    await prisma.$disconnect();
});
