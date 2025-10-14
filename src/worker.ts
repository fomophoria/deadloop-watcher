import "dotenv/config";
import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";

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
const DEAD_ADDRESS = must("DEAD_ADDRESS");
const PRIVATE_KEY = must("PRIVATE_KEY");

const TOKEN_DECIMALS = num("TOKEN_DECIMALS", 18);
const MIN_TOKEN_TO_ACT = num("MIN_TOKEN_TO_ACT", 0);
const DELAY_MS_AFTER_EVENT = num("DELAY_MS_AFTER_EVENT", 3000);
const STARTUP_SWEEP = process.env.STARTUP_SWEEP === "1" || process.env.STARTUP_SWEEP === "true";

assertAddress("TOKEN_ADDRESS", TOKEN_ADDRESS);
assertAddress("REWARD_RECIPIENT", REWARD_RECIPIENT);
assertAddress("DEAD_ADDRESS", DEAD_ADDRESS);

const ZERO = "0x0000000000000000000000000000000000000000";

/* ────────────────────────────────────────────────────────────────────────── */
/* Globals                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

const prisma = new PrismaClient();
const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

let httpProvider: ethers.JsonRpcProvider;
let signer: ethers.Wallet;
let wsProvider: ethers.WebSocketProvider;
let tokenRead: ethers.Contract;
let tokenWrite: ethers.Contract;

const toHuman = (raw: bigint) => Number(ethers.formatUnits(raw, TOKEN_DECIMALS));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────────────────────── */
/* WebSocket Provider (reconnect + health check)                             */
/* ────────────────────────────────────────────────────────────────────────── */

function createWsProvider() {
    const ws = new ethers.WebSocketProvider(RPC_WSS);
    ws.on("error", (e) => console.error("⚠️ WS error:", e));
    return ws;
}

async function reconnectWs(maxDelayMs = 15000) {
    let delay = 1000;
    while (true) {
        try {
            console.log("🔌 Reconnecting WebSocket…");
            wsProvider?.destroy?.();
            wsProvider = createWsProvider();
            tokenRead = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, wsProvider);
            console.log("✅ WS reconnected");
            bindTransferListener();
            break;
        } catch (e) {
            console.warn(`WS reconnect failed, retrying in ${delay} ms`, e);
            await sleep(delay);
            delay = Math.min(maxDelayMs, delay * 2);
        }
    }
}

/** Periodically verify WS health (every 30s) */
function startWsHealthCheck() {
    setInterval(async () => {
        try {
            await wsProvider._detectNetwork();
        } catch {
            console.warn("🧩 WS health check failed, reconnecting...");
            await reconnectWs();
        }
    }, 30000);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Burn logic                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

async function burnAmount(from: string, value: bigint) {
    const human = toHuman(value);
    if (human < MIN_TOKEN_TO_ACT) {
        console.log(`⏭️  Skip (below threshold). amount=${human} min=${MIN_TOKEN_TO_ACT}`);
        return;
    }

    await sleep(DELAY_MS_AFTER_EVENT);

    const tx = await tokenWrite.transfer(DEAD_ADDRESS, value);
    console.log(`🔥 Burn submitted: ${human} tokens → ${DEAD_ADDRESS} | tx=${tx.hash}`);
    const receipt = await tx.wait();

    const txHash = tx.hash || receipt?.transactionHash;
    if (!txHash) {
        console.warn("⚠️ No txHash found for burn — skipping DB insert.");
        return;
    }

    await prisma.burn.create({
        data: {
            txHash,
            fromAddress: from,
            toAddress: DEAD_ADDRESS,
            tokenAddress: TOKEN_ADDRESS,
            amountRaw: value.toString(),
            amountHuman: human,
        },
    });

    console.log(`✅ Logged burn: ${human} tokens | tx=${txHash}`);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Event listener                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function bindTransferListener() {
    tokenRead.removeAllListeners();
    tokenRead.on("Transfer", async (from: string, to: string, value: bigint) => {
        try {
            if (to.toLowerCase() !== REWARD_RECIPIENT) return;
            const human = toHuman(value);
            console.log(`🪙 Incoming: ${human} tokens from ${from} → ${REWARD_RECIPIENT}`);
            await burnAmount(from, value);
        } catch (e) {
            console.error("Transfer handler error:", e);
        }
    });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Startup sweep                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

async function startupSweep() {
    try {
        const bal = (await tokenWrite.balanceOf(REWARD_RECIPIENT)) as bigint;
        if (bal > 0n) {
            const human = toHuman(bal);
            console.log(`🧹 Startup sweep: found ${human} tokens at ${REWARD_RECIPIENT}`);
            await burnAmount(REWARD_RECIPIENT, bal);
        } else {
            console.log("🧹 Startup sweep: no tokens to burn");
        }
    } catch (e) {
        console.warn("Startup sweep failed:", e);
    }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function main() {
    httpProvider = new ethers.JsonRpcProvider(RPC_HTTP);
    signer = new ethers.Wallet(PRIVATE_KEY, httpProvider);
    wsProvider = createWsProvider();
    tokenRead = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, wsProvider);
    tokenWrite = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, signer);

    console.log("Watcher online ✅");
    console.log(`Token: ${TOKEN_ADDRESS}`);
    console.log(`Listening for transfers to: ${REWARD_RECIPIENT}`);

    try {
        const chainDecimals: number = await tokenWrite.decimals();
        if (chainDecimals !== TOKEN_DECIMALS) {
            console.warn(`NOTE: TOKEN_DECIMALS=${TOKEN_DECIMALS} but contract decimals=${chainDecimals}.`);
        }
    } catch (e) {
        console.warn("Could not read token decimals (continuing):", e);
    }

    bindTransferListener();
    startWsHealthCheck();

    if (STARTUP_SWEEP) await startupSweep();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Launch-safe idle                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

if (TOKEN_ADDRESS.toLowerCase() === ZERO) {
    console.log("⏸️  TOKEN_ADDRESS is zero address. Watcher is idling until launch.");
    setInterval(() => console.log("⏳ waiting for launch…"), 60_000);
} else {
    main().catch((e) => {
        console.error("Fatal watcher error:", e);
        process.exit(1);
    });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Graceful shutdown                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

process.on("SIGINT", async () => {
    console.log("Shutting down…");
    try {
        await prisma.$disconnect();
    } finally {
        process.exit(0);
    }
});

process.on("SIGTERM", async () => {
    console.log("Shutting down…");
    try {
        await prisma.$disconnect();
    } finally {
        process.exit(0);
    }
});
