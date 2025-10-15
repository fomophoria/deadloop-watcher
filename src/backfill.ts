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
                for (const log of logs) {
                    const parsed = iface.parseLog(log);
                    const value = parsed.args.value as bigint;
                    const human = new Prisma.Decimal(value.toString()).div(
                        new Prisma.Decimal(10).pow(TOKEN_DECIMALS)
                    );

                    await prisma.burn.upsert({
                        where: { txHash: log.transactionHash },
                        update: {},
                        create: {
                            txHash: log.transactionHash,
                            fromAddress: parsed.args.from.toLowerCase(),
                            toAddress: parsed.args.to.toLowerCase(),
                            tokenAddress: TOKEN_ADDRESS.toLowerCase(),
                            amountRaw: value.toString(),
                            amountHuman: human,
                            timestamp: new Date((await provider.getBlock(log.blockNumber)).timestamp * 1000),
                        },
                    });

                    burnCount++;
                    totalHuman = totalHuman.add(human);
                }
            }
        } catch (err) {
            console.error(`Error at block range ${fromBlock}-${toBlock}`, err);
        }
    }

    console.log(`✅ Done. ${burnCount} burns, total ${totalHuman.toString()} tokens.`);
}

main()
    .catch((err) => {
        console.error(err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
