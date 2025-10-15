import "dotenv/config";
import { ethers } from "ethers";
import { Prisma, PrismaClient } from "@prisma/client";

const must = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var: ${k}`);
    return v;
};

const RPC_HTTP = must("RPC_HTTP");
const TOKEN_ADDRESS = must("TOKEN_ADDRESS").toLowerCase();
const DEAD_ADDRESS = (process.env.DEAD_ADDRESS ?? "0x000000000000000000000000000000000000dead").toLowerCase();
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS ?? "18");

const TX_HASHES = [
    "0x477c2d08a75a2d5a3b8b1aa49f4599929d77d95077f919c907f4b58080c4db70",
    "0x7ab312567f7d78e90007ecf238d3901640bbbf255beb17bdf51e0121cbd67f19",
];

const provider = new ethers.JsonRpcProvider(RPC_HTTP);
const prisma = new PrismaClient();

const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const iface = new ethers.Interface(ERC20_ABI);

async function upsertBurn(txHash: string) {
    const rec = await provider.getTransactionReceipt(txHash);
    if (!rec) { console.warn(`No receipt for ${txHash}`); return; }

    const transferTopic = ethers.id("Transfer(address,address,uint256)").toLowerCase();
    const logs = rec.logs.filter(
        (l) => (l.address ?? "").toLowerCase() === TOKEN_ADDRESS
            && l.topics?.[0]?.toLowerCase() === transferTopic
    );
    if (logs.length === 0) { console.warn(`No Transfer logs for token in ${txHash}`); return; }

    let chosen: any | undefined;
    for (const l of logs) {
        const parsed = iface.parseLog(l);
        if (!parsed) continue;
        if ((parsed.args.to as string).toLowerCase() === DEAD_ADDRESS) {
            chosen = parsed; break;
        }
    }
    if (!chosen) { console.warn(`No Transfer -> DEAD in ${txHash}`); return; }

    const from = (chosen.args.from as string).toLowerCase();
    const to = (chosen.args.to as string).toLowerCase();
    const value = chosen.args.value as bigint;

    const block = await provider.getBlock(rec.blockNumber);
    const timestamp = block ? new Date(Number(block.timestamp) * 1000) : new Date();

    const amountHuman = new Prisma.Decimal(value.toString())
        .div(new Prisma.Decimal(10).pow(TOKEN_DECIMALS));

    await prisma.burn.upsert({
        where: { txHash: txHash.toLowerCase() },
        update: {},
        create: {
            txHash: txHash.toLowerCase(),
            fromAddress: from,
            toAddress: to,
            tokenAddress: TOKEN_ADDRESS,
            amountRaw: value.toString(),
            amountHuman,
            timestamp,
        },
    });

    console.log(`✅ backfilled tx=${txHash} amount=${amountHuman.toString()}`);
}

async function main() {
    for (const h of TX_HASHES) {
        try { await upsertBurn(h); } catch (e) { console.error(`Error ${h}:`, e); }
    }
}
main().finally(() => prisma.$disconnect());
