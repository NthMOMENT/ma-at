import * as dotenv from "dotenv";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { recordIntentCreated } from "./intent_state";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────
//
// This is a parallel listener to listener.ts (viem/EVM). It polls TronGrid's
// REST events API instead of subscribing via an RPC/websocket client, since
// there is no first-party TVM equivalent of viem's watchContractEvent.
//
// NOTE on host: the task spec named https://api.trongrid.io as the endpoint,
// but TronGrid splits networks by subdomain and that one serves TRON
// *mainnet*. Nile Testnet is served from https://nile.trongrid.io. Defaulting
// to the correct Nile host below — override with TRON_API_BASE_URL if
// api.trongrid.io was intentional (e.g. a private/proxied gateway).
const TRON_API_BASE_URL = process.env.TRON_API_BASE_URL ?? "https://nile.trongrid.io";

const TRON_INTENT_MANAGER_ADDRESS = process.env.TRON_INTENT_MANAGER_ADDRESS;

if (!TRON_INTENT_MANAGER_ADDRESS) {
  console.error("[FATAL] TRON_INTENT_MANAGER_ADDRESS must be set in .env (base58 T... address, Nile Testnet)");
  process.exit(1);
}

// TronGrid API keys — same fallback pattern as ALCHEMY_RPC_URL_1/2 in listener.ts:
// try the first key, fall back to the second if the request fails. Both are
// optional; TronGrid works keyless at low rate limits.
const API_KEYS = [process.env.TRONGRID_API_KEY_1, process.env.TRONGRID_API_KEY_2].filter(
  (k): k is string => Boolean(k)
);

// Decision 2 (Gate 5C briefing): TRON's default poll interval, configurable
// via env var like the EVM listeners' ARBITRUM_POLL_INTERVAL_MS/ROBINHOOD_POLL_INTERVAL_MS.
const POLL_INTERVAL_MS = Number(process.env.TRON_POLL_INTERVAL_MS ?? 10000);

// ─── Event definitions ────────────────────────────────────────────────────────
// Mirrors listener.ts's INTENT_MANAGER_ABI. TronGrid decodes event args by
// param name when the contract is ABI-verified on Tronscan, and by positional
// index ("0", "1", ...) otherwise — getField() below handles both.

const WATCHED_EVENTS = ["IntentCreated", "CollateralPosted", "IntentSettled"] as const;
type WatchedEvent = (typeof WATCHED_EVENTS)[number];

interface TronGridEvent {
  block_number: number;
  block_timestamp: number;
  event_name: string;
  transaction_id: string;
  event_index: number;
  contract_address: string;
  result: Record<string, string>;
}

interface TronGridEventsResponse {
  success: boolean;
  data: TronGridEvent[];
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatTrx(sun: bigint): string {
  // TRX has 6 decimals (SUN), unlike ETH's 18 (wei) — amount here is msg.value
  // on the TVM side, so it's denominated in SUN, not wei.
  return (Number(sun) / 1e6).toFixed(6);
}

function divider(): void {
  console.log("─".repeat(64));
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58CheckEncode(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  const checksum = createHash("sha256").update(createHash("sha256").update(buf).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([buf, checksum]);

  let value = BigInt("0x" + bytes.toString("hex"));
  let result = "";
  while (value > 0n) {
    const mod = value % 58n;
    result = BASE58_ALPHABET[Number(mod)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

// Tron addresses arrive from TronGrid as 41-prefixed hex (21 bytes). Falls
// back to raw hex if it's not in that shape rather than throwing.
function hexToTronAddress(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 42 || !h.startsWith("41")) return `0x${h}`;
  try {
    return base58CheckEncode(h);
  } catch {
    return `0x${h}`;
  }
}

function getField(result: Record<string, string>, name: string, index: number): string {
  return result[name] ?? result[String(index)] ?? "";
}

// ─── Destination Wallet Decoding ──────────────────────────────────────────────
// Mirrors listener.ts's decodeDestinationWallet/chain-id constants exactly —
// same encoding convention documented on IntentManager.sol's Intent struct.

const SOLANA_CHAIN_ID = 1399811149n;
// Matches ma-at-web/lib/chains.ts's onChainId for TRON Nile — the value the
// frontend actually submits as destinationChainId, not the value named in
// the original TRON-support task spec (2494104990), which doesn't match.
const TRON_NILE_CHAIN_ID = 3448148188n;

function decodeDestinationWallet(destinationWallet: `0x${string}`, destinationChainId: bigint): string {
  const bytes = Buffer.from(destinationWallet.slice(2), "hex");

  if (destinationChainId === SOLANA_CHAIN_ID) {
    return new PublicKey(bytes).toBase58();
  }

  if (destinationChainId === TRON_NILE_CHAIN_ID) {
    const payload = bytes.subarray(0, 21);
    return base58CheckEncode(payload.toString("hex"));
  }

  return `0x${bytes.subarray(12).toString("hex")}`;
}

// ─── Event handlers ────────────────────────────────────────────────────────────

function logIntentCreated(ev: TronGridEvent): void {
  try {
    const r = ev.result;
    const intentId = `0x${getField(r, "intentId", 0).replace(/^0x/, "")}`;
    const sender = hexToTronAddress(getField(r, "sender", 1));
    const amount = BigInt(getField(r, "amount", 2) || "0");
    const tokenAddressHex = getField(r, "tokenAddress", 3);
    const isNative = /^(0x)?0{40}$/.test(tokenAddressHex);
    const tokenAddress = isNative ? tokenAddressHex : hexToTronAddress(tokenAddressHex);
    const destinationWalletHex = `0x${getField(r, "destinationWallet", 4).replace(/^0x/, "")}` as `0x${string}`;
    const destinationChainId = getField(r, "destinationChainId", 5);
    const destinationChainIdBig = BigInt(destinationChainId || "0");
    const expiry = getField(r, "expiry", 6);
    const slippageBps = Number(getField(r, "slippageBps", 7) || "0");

    const expiryDate = new Date(Number(expiry) * 1000).toISOString();
    const decodedDestination = decodeDestinationWallet(destinationWalletHex, destinationChainIdBig);

    divider();
    console.log(`[IntentCreated] Chain: TRON Nile Testnet`);
    console.log(`  intentId:           ${intentId}`);
    console.log(`  sender:             ${sender}`);
    console.log(`  amount:             ${formatTrx(amount)} TRX (${amount.toString()} SUN)`);
    console.log(`  tokenAddress:       ${tokenAddress}${isNative ? " (native)" : " (TRC20)"}`);
    console.log(`  destinationWallet:  ${destinationWalletHex} (decoded: ${decodedDestination})`);
    console.log(`  destinationChainId: ${destinationChainId}`);
    console.log(`  expiry:             ${expiryDate} (${expiry})`);
    console.log(`  slippageBps:        ${slippageBps} (${(slippageBps / 100).toFixed(2)}%)`);
    console.log(`  txHash:             ${ev.transaction_id}`);
    console.log(`  blockNumber:        ${ev.block_number}`);
    divider();

    console.log(`[ZK] IntentCreated detected — triggering ZK verification...`);
    // KNOWN LIMITATION: the ZK pipeline (zk/script/src/bin/prove.rs) only
    // proves Arbitrum Sepolia IntentManager receipts — its TARGET_CONTRACT
    // and RPC calls are pinned to that chain, so it cannot look up a TRON
    // tx. Rather than spawn a prover run that's guaranteed to fail against
    // the wrong chain's RPC, skip explicitly and say why. Revisit once/if
    // prove.rs grows multi-chain support.
    console.log(`[ZK] skipped: no proof available for TRON Nile Testnet — ZK proving is only implemented for Arbitrum Sepolia-sourced intents right now.`);

    // Gate 5C: one state record per intent, same as listener.ts's EVM side —
    // the /proof dashboard's only data source.
    recordIntentCreated(
      {
        intentId,
        sourceChain: "TRON Nile Testnet",
        sourceTxHash: ev.transaction_id,
        blockNumber: ev.block_number,
        blockHash: null, // not present on TronGrid's REST event payload
        amountWei: amount.toString(),
        tokenAddress,
        destinationChainId,
        destinationWallet: decodedDestination,
      },
      { kind: "skipped", chain: "TRON Nile Testnet" }
    );
  } catch (err) {
    console.error(`[ERROR] Failed to process IntentCreated event on TRON Nile Testnet:`, err);
  }
}

function logCollateralPosted(ev: TronGridEvent): void {
  try {
    const r = ev.result;
    const intentId = `0x${getField(r, "intentId", 0).replace(/^0x/, "")}`;
    const solver = hexToTronAddress(getField(r, "solver", 1));
    const collateralAmount = BigInt(getField(r, "collateralAmount", 2) || "0");

    divider();
    console.log(`[CollateralPosted] Chain: TRON Nile Testnet`);
    console.log(`  intentId:         ${intentId}`);
    console.log(`  solver:           ${solver}`);
    console.log(`  collateralAmount: ${formatTrx(collateralAmount)} TRX (${collateralAmount.toString()} SUN)`);
    console.log(`  txHash:           ${ev.transaction_id}`);
    console.log(`  blockNumber:      ${ev.block_number}`);
    divider();
  } catch (err) {
    console.error(`[ERROR] Failed to process CollateralPosted event on TRON Nile Testnet:`, err);
  }
}

function logIntentSettled(ev: TronGridEvent): void {
  try {
    const r = ev.result;
    const intentId = `0x${getField(r, "intentId", 0).replace(/^0x/, "")}`;
    const solver = hexToTronAddress(getField(r, "solver", 1));
    const amount = BigInt(getField(r, "amount", 2) || "0");
    const zkProofHash = `0x${getField(r, "zkProofHash", 3).replace(/^0x/, "")}`;

    divider();
    console.log(`[IntentSettled] Chain: TRON Nile Testnet`);
    console.log(`  intentId:    ${intentId}`);
    console.log(`  solver:      ${solver}`);
    console.log(`  amount:      ${formatTrx(amount)} TRX (${amount.toString()} SUN)`);
    console.log(`  zkProofHash: ${zkProofHash}`);
    console.log(`  txHash:      ${ev.transaction_id}`);
    console.log(`  blockNumber: ${ev.block_number}`);
    divider();
  } catch (err) {
    console.error(`[ERROR] Failed to process IntentSettled event on TRON Nile Testnet:`, err);
  }
}

const HANDLERS: Record<WatchedEvent, (ev: TronGridEvent) => void> = {
  IntentCreated: logIntentCreated,
  CollateralPosted: logCollateralPosted,
  IntentSettled: logIntentSettled,
};

// ─── TronGrid polling ────────────────────────────────────────────────────────

async function fetchEvents(eventName: WatchedEvent, sinceTimestampMs: number): Promise<TronGridEvent[]> {
  const url =
    `${TRON_API_BASE_URL}/v1/contracts/${TRON_INTENT_MANAGER_ADDRESS}/events` +
    `?event_name=${eventName}&only_confirmed=true&order_by=block_timestamp,asc` +
    `&min_block_timestamp=${sinceTimestampMs}&limit=200`;

  const attempts = API_KEYS.length > 0 ? API_KEYS : [undefined];
  let lastErr: Error | undefined;

  for (const apiKey of attempts) {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const json = (await res.json()) as TronGridEventsResponse;
      if (!json.success) throw new Error("TronGrid response: success=false");

      return json.data ?? [];
    } catch (err) {
      lastErr = err as Error;
      // fall back to the next key, same resilience pattern as viem's fallback([url1, url2])
    }
  }

  throw lastErr ?? new Error(`fetchEvents(${eventName}) failed with no reachable endpoint`);
}

interface EventCursor {
  sinceTimestampMs: number;
  seen: Set<string>;
}

function pollEvent(eventName: WatchedEvent, cursor: EventCursor): void {
  fetchEvents(eventName, cursor.sinceTimestampMs)
    .then((events) => {
      for (const ev of events) {
        const key = `${ev.transaction_id}:${ev.event_index}`;
        if (cursor.seen.has(key)) continue;
        cursor.seen.add(key);
        cursor.sinceTimestampMs = Math.max(cursor.sinceTimestampMs, ev.block_timestamp);
        HANDLERS[eventName](ev);
      }
      // Bound memory: drop old dedupe keys once the timestamp watermark has moved past them.
      if (cursor.seen.size > 5000) cursor.seen.clear();
    })
    .catch((err: Error) => {
      console.error(`[TRON Nile Testnet] ${eventName} poll error:`, err.message);
    });
}

function watchChain(): void {
  console.log(`[TRON Nile Testnet] Watching IntentManager at ${TRON_INTENT_MANAGER_ADDRESS}`);
  console.log(`[TRON Nile Testnet] Polling ${TRON_API_BASE_URL} every ${POLL_INTERVAL_MS}ms`);

  const startTimestampMs = Date.now();
  const cursors: Record<WatchedEvent, EventCursor> = {
    IntentCreated: { sinceTimestampMs: startTimestampMs, seen: new Set() },
    CollateralPosted: { sinceTimestampMs: startTimestampMs, seen: new Set() },
    IntentSettled: { sinceTimestampMs: startTimestampMs, seen: new Set() },
  };

  let inFlight = false;
  setInterval(() => {
    if (inFlight) return; // don't pile up requests if a previous tick is still resolving
    inFlight = true;
    Promise.allSettled(WATCHED_EVENTS.map((name) => pollEvent(name, cursors[name])))
      .finally(() => {
        inFlight = false;
      });
  }, POLL_INTERVAL_MS);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(64));
  console.log("  Maat Orchestrator — TRON Intent Listener");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  ZK proving: not yet implemented for this chain (Arbitrum Sepolia only — see prove.rs)`);
  console.log("═".repeat(64) + "\n");

  try {
    const events = await fetchEvents("IntentCreated", 0);
    console.log(`[TRON Nile Testnet] Connected via TronGrid. (${events.length} historical IntentCreated event(s) seen, not replayed)`);
  } catch (err) {
    console.error("[FATAL] Cannot reach TronGrid:", (err as Error).message);
    process.exit(1);
  }

  console.log("");
  watchChain();

  console.log("\n[Orchestrator] Listening on TRON Nile Testnet. Waiting for intents...\n");
}

process.on("unhandledRejection", (reason) => {
  console.error("[ERROR] Unhandled rejection (continuing):", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[ERROR] Uncaught exception (continuing):", err);
});

main().catch((err) => {
  console.error("[FATAL] Unhandled error during boot:", err);
  process.exit(1);
});
