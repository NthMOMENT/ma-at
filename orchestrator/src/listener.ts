import { createPublicClient, http, fallback, parseAbiItem, type Log, type Chain } from "viem";
import { arbitrumSepolia } from "viem/chains";
import * as dotenv from "dotenv";
import { spawn } from "child_process";
import * as path from "path";
import { createHash } from "crypto";
import { PublicKey, Connection } from "@solana/web3.js";
import {
  PROVER_BINARY,
  ProverQueue,
  proveIntent,
  evaluateSettleGate,
  isAlreadySettled,
  getLedgerEntry,
  getSettlingEntries,
  markSettling,
  markSettled,
  alert,
} from "./prover_pipeline";
import {
  recordIntentCreated,
  recordAlertReason,
  setSettling,
  setSettled,
  setUnconfirmedNeedsReview,
  listPendingFinality,
  isBlockFinal,
  setFinal,
} from "./intent_state";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

// Each chain has its own IntentManager deployment — never share one address
// across chains here, since the two are deployed independently.
const ARBITRUM_INTENT_MANAGER_ADDRESS = (process.env.ARBITRUM_INTENT_MANAGER_ADDRESS ??
  "0x9D1bd7119E9FefF6Baa3968272811323B354B16f") as `0x${string}`;
const ROBINHOOD_INTENT_MANAGER_ADDRESS = (process.env.ROBINHOOD_INTENT_MANAGER_ADDRESS ??
  "0xcA6bf2D574209D49515a9Eeb61E27924edE28860") as `0x${string}`;

// Three separate Alchemy app keys, tried in order (URL_1 -> URL_2 -> URL_3) —
// mirrors zk/script's rpc_urls() in prove.rs/header_check.rs exactly, so one
// key hitting its monthly cap doesn't take the whole pipeline down.
const ALCHEMY_RPC_URLS = [process.env.ALCHEMY_RPC_URL_1, process.env.ALCHEMY_RPC_URL_2, process.env.ALCHEMY_RPC_URL_3].filter(
  (u): u is string => Boolean(u && u.length > 0)
);
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
// Optional Alchemy-backed fallback for Robinhood Testnet (documented in
// .env.example but never wired up before now).
const ROBINHOOD_ALCHEMY_RPC_URL = process.env.ROBINHOOD_ALCHEMY_RPC_URL;

// Per-chain watch polling intervals (Decision 2, Gate 5C briefing) — each
// independently configurable since the two chains have very different block
// times; defaults chosen for Arbitrum Sepolia's faster blocks vs. Robinhood
// Testnet's slower ones.
const ARBITRUM_POLL_INTERVAL_MS = Number(process.env.ARBITRUM_POLL_INTERVAL_MS ?? 4000);
const ROBINHOOD_POLL_INTERVAL_MS = Number(process.env.ROBINHOOD_POLL_INTERVAL_MS ?? 12000);

// Gate 5C: how often to check Arbitrum Sepolia's "finalized" block tag
// against every intent state record still awaiting finality — see
// pollFinality() below.
const FINALITY_POLL_INTERVAL_MS = Number(process.env.FINALITY_POLL_INTERVAL_MS ?? 60000);

// PROVER_BINARY is imported from ./prover_pipeline (single source of truth
// for the spawn path, since that's what actually invokes it).
const SETTLE_SCRIPT = process.env.SETTLE_SCRIPT_PATH ?? path.resolve(__dirname, "../settle_intent.js");

// Same default as settle_intent.js — used here only to reconcile the
// settled-ledger's "settling" entries against Solana on boot (Gate 5B-fix).
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");

if (ALCHEMY_RPC_URLS.length === 0) {
  console.error("[FATAL] at least one of ALCHEMY_RPC_URL_1/2/3 must be set in .env");
  process.exit(1);
}

// ─── Chain definitions ───────────────────────────────────────────────────────

const robinhoodTestnet: Chain = {
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC_URL] },
  },
};

// ─── ABI ─────────────────────────────────────────────────────────────────────

const INTENT_CREATED_EVENT = parseAbiItem(
  "event IntentCreated(bytes32 indexed intentId, address indexed sender, uint256 amount, address tokenAddress, bytes32 destinationWallet, uint64 destinationChainId, uint64 expiry, uint16 slippageBps)"
);

// Chain IDs that use a non-EVM VM — destinationWallet is decoded differently for these.
const SOLANA_CHAIN_ID = 1399811149n;
// Matches ma-at-web/lib/chains.ts's onChainId for TRON Nile — the value the
// frontend actually submits as destinationChainId, not the value named in
// the original TRON-support task spec (2494104990), which doesn't match.
const TRON_NILE_CHAIN_ID = 3448148188n;

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

/// Decodes an IntentCreated `destinationWallet` (bytes32) per the encoding
/// convention documented on IntentManager.sol's Intent struct:
///   - Solana: the raw 32-byte public key.
///   - TRON: the raw 21-byte address (1-byte prefix + 20 address bytes),
///     right-padded with zeros — checksum is recomputed on encode.
///   - EVM (anything else): left-padded address, in the low 20 bytes.
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

const COLLATERAL_POSTED_EVENT = parseAbiItem(
  "event CollateralPosted(bytes32 indexed intentId, address indexed solver, uint256 collateralAmount)"
);

const INTENT_SETTLED_EVENT = parseAbiItem(
  "event IntentSettled(bytes32 indexed intentId, address indexed solver, uint256 amount, bytes32 zkProofHash)"
);

const INTENT_MANAGER_ABI = [INTENT_CREATED_EVENT, COLLATERAL_POSTED_EVENT, INTENT_SETTLED_EVENT] as const;

// ─── Clients ─────────────────────────────────────────────────────────────────

const arbClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: fallback(ALCHEMY_RPC_URLS.map((u) => http(u))),
  pollingInterval: ARBITRUM_POLL_INTERVAL_MS,
});

const rhClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: ROBINHOOD_ALCHEMY_RPC_URL
    ? fallback([http(ROBINHOOD_RPC_URL), http(ROBINHOOD_ALCHEMY_RPC_URL)])
    : http(ROBINHOOD_RPC_URL),
  pollingInterval: ROBINHOOD_POLL_INTERVAL_MS,
});

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatEther(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6);
}

function divider(): void {
  console.log("─".repeat(64));
}

// ─── ZK Proof Trigger ────────────────────────────────────────────────────────
// Spawns the SP1 prover in prove mode ONLY (see prover_pipeline.ts), strictly
// one at a time across both listener processes, and decides purely from its
// exit code + the JSON it writes — never from stdout. Called automatically
// on every IntentCreated event on Arbitrum Sepolia (the only chain the
// prover currently supports — see the skip branch in logIntentCreated).

const proverQueue = new ProverQueue();

function triggerZKVerification(
  txHash: string,
  intentId: string,
  destinationWallet: string,
  destinationChainId: bigint
): void {
  const intentIdHex = intentId.replace(/^0x/, "").toLowerCase();

  proverQueue.enqueue(async () => {
    console.log(`[ZK] Proving intent ${intentId} (tx ${txHash}) via ${PROVER_BINARY} — prove mode, ~7min/~14GB, one at a time`);
    const outcome = await proveIntent(txHash, intentIdHex);

    if (outcome.status === "rejected") {
      console.log(`[ZK] intent ${intentId}: Rejected (semantic failure) — no retry, not settling.`);
      return;
    }
    if (outcome.status === "alert") {
      console.error(`[ZK] intent ${intentId}: prover failure — see [ALERT] above / orchestrator/alerts.log. NOT settling.`);
      return;
    }

    const { json } = outcome;
    divider();
    console.log(`[ZK] ─── PROOF VERIFIED ───`);
    console.log(`[ZK]   intentId: ${json.intent_id}`);
    console.log(`[ZK]   vkey:     ${json.vkey}`);
    console.log(`[ZK]   block:    ${json.block_number} (${json.block_hash})`);
    divider();

    let canonicalBlockHash: string;
    try {
      const block = await arbClient.getBlock({ blockNumber: BigInt(json.block_number) });
      canonicalBlockHash = block.hash;
    } catch (err) {
      const reason = `failed to fetch canonical block ${json.block_number} for the settle gate: ${(err as Error).message}`;
      alert(`intent ${intentId}: ${reason}`);
      recordAlertReason(intentId, reason);
      return;
    }

    const gate = evaluateSettleGate(json, ARBITRUM_INTENT_MANAGER_ADDRESS, canonicalBlockHash);
    if (!gate.ok) {
      const reason = `settle gate REFUSED (failed: ${gate.failedChecks.join(", ")}) — not settling`;
      alert(`intent ${intentId}: ${reason}`);
      recordAlertReason(intentId, reason);
      return;
    }

    // Fix 6/8 (Gate 5B-fix): a settle already recorded "settled" or
    // mid-flight "settling" for this intent means either it already paid
    // out, or a signed-but-unconfirmed tx is waiting on boot reconciliation
    // (see reconcileSettlingLedger). Either way, never re-invoke
    // settle_intent.js blindly — that's exactly the double-payout this
    // ledger exists to prevent.
    if (isAlreadySettled(json.intent_id) || getLedgerEntry(json.intent_id)?.status === "settling") {
      const reason = "already settled or mid-settlement per local ledger — refusing to re-invoke settle_intent.js";
      alert(`intent ${intentId}: ${reason}`);
      recordAlertReason(intentId, reason);
      return;
    }

    // Fix 8 (Gate 5B-fix): payout recipient and amount come ONLY from the
    // proof JSON's committed values from here on — never from the
    // IntentCreated log args (`destinationWallet`/`destinationChainId`
    // params above are still used for the pre-proof console log only). The
    // settle gate above already proved json.destination_chain_id ==
    // SOLANA_CHAIN_ID, so this always decodes via the Solana branch.
    const payoutDestination = decodeDestinationWallet(json.destination_wallet as `0x${string}`, BigInt(json.destination_chain_id));

    console.log(`[SETTLE] all gate checks passed — triggering Solana settlement...`);
    const settleEnv = {
      ...process.env,
      DESTINATION_WALLET: payoutDestination,
      DESTINATION_CHAIN_ID: json.destination_chain_id.toString(),
      PROOF_AMOUNT_WEI: json.amount,
      INTENT_ID: json.intent_id,
    };

    await new Promise<void>((resolve) => {
      const settler = spawn("node", [SETTLE_SCRIPT], { env: settleEnv, stdio: ["pipe", "pipe", "pipe"] });
      let settleOut = "";
      let settleErr = "";
      let sigHandled = false;
      let settlingSig: string | undefined;
      settler.stdout.on("data", (d: Buffer) => {
        settleOut += d.toString();
        // Fix 6 (Gate 5B-fix): the settling-signature handshake. The child
        // signs the payout tx, prints SETTLING_SIG:<sig> BEFORE broadcasting
        // it, then blocks on stdin. We record "settling" with that
        // signature the instant we see the line (durable, synchronous
        // write — see markSettling), then unblock the child. A crash
        // anywhere after this point leaves a signature the next boot can
        // check on-chain instead of a blind unknown.
        if (!sigHandled) {
          const m = settleOut.match(/SETTLING_SIG:(\S+)/);
          if (m) {
            sigHandled = true;
            settlingSig = m[1];
            markSettling(json.intent_id, m[1]);
            setSettling(json.intent_id, m[1]);
            console.log(`[SETTLE] intent ${intentId}: payout tx signed (sig ${m[1]}) — recorded "settling" before broadcast`);
            settler.stdin.write("GO\n");
          }
        }
      });
      settler.stderr.on("data", (d: Buffer) => { settleErr += d.toString(); });
      settler.on("close", (code: number) => {
        if (code !== 0) {
          const reason = `settlement script failed (code ${code}): ${settleErr.trim()}`;
          alert(`intent ${intentId}: ${reason}`);
          recordAlertReason(intentId, reason);
          // A signature was recorded as "settling" before this failure —
          // its actual on-chain fate is now unknown (may have broadcast and
          // landed anyway), so mirror that ambiguity rather than silently
          // leaving the display stuck on "settling". No signature yet means
          // nothing was ever signed, so settlement correctly stays "none".
          if (settlingSig) setUnconfirmedNeedsReview(json.intent_id, settlingSig);
          resolve();
          return;
        }
        markSettled(json.intent_id);
        setSettled(json.intent_id, settlingSig ?? "unknown");
        const settleTxMatch = settleOut.match(/receive_settlement tx:\s*(\S+)/);
        const deltaMatch = settleOut.match(/Delta:\s*\+\s*([\d.]+)/);
        const settleTx = settleTxMatch ? settleTxMatch[1] : "unknown";
        const delta = deltaMatch ? deltaMatch[1] : "unknown";
        divider();
        console.log(`[SETTLE] ─── SOLANA SETTLEMENT COMPLETE ───`);
        console.log(`[SETTLE]   intentId:   ${intentId}`);
        console.log(`[SETTLE]   settleTx:   ${settleTx}`);
        console.log(`[SETTLE]   delivered:  ${delta} SOL`);
        console.log(`[SETTLE]   destination: ${payoutDestination}`);
        console.log(`[SETTLE]   note: 1:1 mock rate (devnet). Pyth oracle + Jupiter routing at mainnet.`);
        divider();
        resolve();
      });
      settler.on("error", (err: Error) => {
        const reason = `failed to spawn settler: ${err.message}`;
        alert(`intent ${intentId}: ${reason}`);
        recordAlertReason(intentId, reason);
        resolve();
      });
    });
  });
}

// ─── Event handlers ────────────────────────────────────────────────────────────

function logIntentCreated(log: Log, chainLabel: string): void {
  try {
    const args = (log as unknown as {
      args: {
        intentId: `0x${string}`;
        sender: `0x${string}`;
        amount: bigint;
        tokenAddress: `0x${string}`;
        destinationWallet: `0x${string}`;
        destinationChainId: bigint;
        expiry: bigint;
        slippageBps: number;
      };
    }).args;

    const expiryDate = new Date(Number(args.expiry) * 1000).toISOString();
    const isNative = args.tokenAddress === "0x0000000000000000000000000000000000000000";

    divider();
    console.log(`[IntentCreated] Chain: ${chainLabel}`);
    console.log(`  intentId:           ${args.intentId}`);
    console.log(`  sender:             ${args.sender}`);
    console.log(`  amount:             ${formatEther(args.amount)} ETH (${args.amount.toString()} wei)`);
    console.log(`  tokenAddress:       ${args.tokenAddress}${isNative ? " (native)" : " (ERC20)"}`);
    const decodedDestination = decodeDestinationWallet(args.destinationWallet, args.destinationChainId);
    console.log(`  destinationWallet:  ${args.destinationWallet} (decoded: ${decodedDestination})`);
    console.log(`  destinationChainId: ${args.destinationChainId.toString()}`);
    console.log(`  expiry:             ${expiryDate} (${args.expiry.toString()})`);
    console.log(`  slippageBps:        ${args.slippageBps} (${(args.slippageBps / 100).toFixed(2)}%)`);
    console.log(`  txHash:             ${log.transactionHash}`);
    console.log(`  blockNumber:        ${log.blockNumber?.toString()}`);
    divider();

    // Gate 5C: one state record per intent, regardless of chain or whether
    // it will ever be proven — the /proof dashboard's only data source.
    const stateFields = {
      intentId: args.intentId,
      sourceChain: chainLabel,
      sourceTxHash: log.transactionHash ?? "unknown",
      blockNumber: log.blockNumber != null ? Number(log.blockNumber) : null,
      blockHash: log.blockHash ?? null,
      amountWei: args.amount.toString(),
      tokenAddress: args.tokenAddress,
      destinationChainId: args.destinationChainId.toString(),
      destinationWallet: decodedDestination,
    };

    // ── Automatically trigger ZK verification ──
    console.log(`[ZK] IntentCreated detected — triggering ZK verification...`);
    // KNOWN LIMITATION: prove.rs's TARGET_CONTRACT and RPC calls are pinned
    // to Arbitrum Sepolia (see zk/script/src/bin/prove.rs) — it cannot look
    // up a Robinhood Testnet tx. Rather than spawn a prover run that's
    // guaranteed to fail, skip explicitly and say why.
    if (chainLabel !== "Arbitrum Sepolia") {
      console.log(`[ZK] skipped: no proof available for ${chainLabel} — ZK proving is only implemented for Arbitrum Sepolia-sourced intents right now.`);
      recordIntentCreated(stateFields, { kind: "skipped", chain: chainLabel });
      return;
    }
    if (!log.transactionHash) {
      console.error(`[ZK] IntentCreated log has no transactionHash — cannot prove. Skipping.`);
      recordIntentCreated(stateFields, { kind: "alert" });
      recordAlertReason(args.intentId, "IntentCreated log has no transactionHash — cannot prove");
      return;
    }
    recordIntentCreated(stateFields, { kind: "queued" });
    triggerZKVerification(log.transactionHash, args.intentId, decodedDestination, args.destinationChainId);

  } catch (err) {
    console.error(`[ERROR] Failed to process IntentCreated log on ${chainLabel}:`, err);
  }
}

function logCollateralPosted(log: Log, chainLabel: string): void {
  try {
    const args = (log as unknown as {
      args: {
        intentId: `0x${string}`;
        solver: `0x${string}`;
        collateralAmount: bigint;
      };
    }).args;

    divider();
    console.log(`[CollateralPosted] Chain: ${chainLabel}`);
    console.log(`  intentId:         ${args.intentId}`);
    console.log(`  solver:           ${args.solver}`);
    console.log(`  collateralAmount: ${formatEther(args.collateralAmount)} ETH (${args.collateralAmount.toString()} wei)`);
    console.log(`  txHash:           ${log.transactionHash}`);
    console.log(`  blockNumber:      ${log.blockNumber?.toString()}`);
    divider();
  } catch (err) {
    console.error(`[ERROR] Failed to process CollateralPosted log on ${chainLabel}:`, err);
  }
}

function logIntentSettled(log: Log, chainLabel: string): void {
  try {
    const args = (log as unknown as {
      args: {
        intentId: `0x${string}`;
        solver: `0x${string}`;
        amount: bigint;
        zkProofHash: `0x${string}`;
      };
    }).args;

    divider();
    console.log(`[IntentSettled] Chain: ${chainLabel}`);
    console.log(`  intentId:    ${args.intentId}`);
    console.log(`  solver:      ${args.solver}`);
    console.log(`  amount:      ${formatEther(args.amount)} ETH (${args.amount.toString()} wei)`);
    console.log(`  zkProofHash: ${args.zkProofHash}`);
    console.log(`  txHash:      ${log.transactionHash}`);
    console.log(`  blockNumber: ${log.blockNumber?.toString()}`);
    divider();
  } catch (err) {
    console.error(`[ERROR] Failed to process IntentSettled log on ${chainLabel}:`, err);
  }
}

// ─── Watchers ────────────────────────────────────────────────────────────────

function watchChain(
  client: typeof arbClient | typeof rhClient,
  chainLabel: string,
  intentManagerAddress: `0x${string}`
): void {
  console.log(`[${chainLabel}] Watching IntentManager at ${intentManagerAddress}`);

  client.watchContractEvent({
    address: intentManagerAddress,
    abi: INTENT_MANAGER_ABI,
    eventName: "IntentCreated",
    onLogs: (logs) => logs.forEach((log) => logIntentCreated(log, chainLabel)),
    onError: (err) => console.error(`[${chainLabel}] IntentCreated watcher error:`, err.message),
  });

  client.watchContractEvent({
    address: intentManagerAddress,
    abi: INTENT_MANAGER_ABI,
    eventName: "CollateralPosted",
    onLogs: (logs) => logs.forEach((log) => logCollateralPosted(log, chainLabel)),
    onError: (err) => console.error(`[${chainLabel}] CollateralPosted watcher error:`, err.message),
  });

  client.watchContractEvent({
    address: intentManagerAddress,
    abi: INTENT_MANAGER_ABI,
    eventName: "IntentSettled",
    onLogs: (logs) => logs.forEach((log) => logIntentSettled(log, chainLabel)),
    onError: (err) => console.error(`[${chainLabel}] IntentSettled watcher error:`, err.message),
  });
}

// ─── Ledger reconciliation ────────────────────────────────────────────────────
// Fix 6 (Gate 5B-fix): on every boot, before touching any watcher, resolve
// every intent this process (or a prior crashed instance of it) left in
// "settling" — a payout that was signed and whose signature we recorded,
// but never confirmed as sent. We check the signature on Solana directly;
// we never re-invoke settle_intent.js for one of these, since the original
// signed tx may already have landed.

async function reconcileSettlingLedger(): Promise<void> {
  const pending = getSettlingEntries();
  if (pending.length === 0) return;

  console.log(`[LEDGER] ${pending.length} intent(s) left in "settling" from a previous run — checking their signatures on Solana first...`);
  for (const { intentId, solanaSig } of pending) {
    try {
      const status = await solanaConnection.getSignatureStatus(solanaSig, { searchTransactionHistory: true });
      const landed =
        !!status.value &&
        !status.value.err &&
        (status.value.confirmationStatus === "confirmed" || status.value.confirmationStatus === "finalized");
      if (landed) {
        markSettled(intentId);
        setSettled(intentId, solanaSig);
        console.log(`[LEDGER] intent 0x${intentId}: sig ${solanaSig} landed on-chain — marked settled.`);
      } else {
        const reason = `still "settling" (sig ${solanaSig}) with no confirmed landing on Solana — NOT auto-resettling. Needs manual review before any retry.`;
        alert(`intent 0x${intentId}: ${reason}`);
        setUnconfirmedNeedsReview(intentId, solanaSig);
        recordAlertReason(intentId, reason);
      }
    } catch (err) {
      const reason = `failed to check signature ${solanaSig} on Solana during boot reconciliation: ${(err as Error).message} — NOT auto-resettling.`;
      alert(`intent 0x${intentId}: ${reason}`);
      recordAlertReason(intentId, reason);
    }
  }
}

// ─── Finality poller ───────────────────────────────────────────────────────
// Gate 5C: every FINALITY_POLL_INTERVAL_MS, re-fetch Arbitrum Sepolia's
// "finalized" block tag (via the same URL_1/_2/_3 fallback as everything
// else here) and flip any Arbitrum-sourced intent state record whose block
// has since been swallowed by that tag from finality "pending" to "final".
// Runs independently of proof/settlement stage — a source block can (and
// typically does, on devnet timings) become finalized well after its intent
// already shows "Delivered" on the dashboard.

async function pollFinality(): Promise<void> {
  let finalizedBlockNumber: number;
  try {
    const block = await arbClient.getBlock({ blockTag: "finalized" });
    if (block.number == null) return;
    finalizedBlockNumber = Number(block.number);
  } catch (err) {
    console.error(`[FINALITY] failed to fetch Arbitrum Sepolia's finalized block:`, (err as Error).message);
    return;
  }

  for (const state of listPendingFinality("Arbitrum Sepolia")) {
    if (state.blockNumber != null && isBlockFinal(state.blockNumber, finalizedBlockNumber)) {
      setFinal(state.intentId);
      console.log(`[FINALITY] intent ${state.intentId}: block ${state.blockNumber} <= finalized ${finalizedBlockNumber} — marked final`);
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(64));
  console.log("  Maat Orchestrator — Intent Listener + ZK Verifier");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  Prover:  ${PROVER_BINARY}`);
  console.log("═".repeat(64) + "\n");

  await reconcileSettlingLedger();

  try {
    const arbBlock = await arbClient.getBlockNumber();
    console.log(`[Arbitrum Sepolia] Connected. Latest block: ${arbBlock}`);
  } catch (err) {
    console.error("[FATAL] Cannot connect to Arbitrum Sepolia RPC:", (err as Error).message);
    process.exit(1);
  }

  let robinhoodAvailable = true;
  try {
    const rhBlock = await rhClient.getBlockNumber();
    console.log(`[Robinhood Testnet] Connected. Latest block: ${rhBlock}`);
  } catch (err) {
    robinhoodAvailable = false;
    console.warn("[WARN] Cannot connect to Robinhood Testnet RPC. Skipping its watcher.");
    console.warn(`  Error: ${(err as Error).message}`);
  }

  console.log("");
  watchChain(arbClient, "Arbitrum Sepolia", ARBITRUM_INTENT_MANAGER_ADDRESS);
  if (robinhoodAvailable) {
    watchChain(rhClient, "Robinhood Testnet", ROBINHOOD_INTENT_MANAGER_ADDRESS);
  }

  pollFinality().catch((err) => console.error("[FINALITY] initial poll failed:", (err as Error).message));
  setInterval(() => {
    pollFinality().catch((err) => console.error("[FINALITY] poll failed:", (err as Error).message));
  }, FINALITY_POLL_INTERVAL_MS);

  console.log("\n[Orchestrator] Listening. Waiting for intents...\n");
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
