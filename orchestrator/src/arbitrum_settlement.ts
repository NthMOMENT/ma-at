// Arbitrum-side settlement sequence (Phase 7B): postCollateral -> (on-chain
// solver check) -> Solana payout (existing flow, unchanged, injected as
// deps.runSolanaPayout) -> confirmSettlement on success, or retry-then-
// slashSolver on failure. Every write is recorded to arbitrum_ledger.ts
// BEFORE broadcast (same tx-hash-before-broadcast pattern as settle_intent.js's
// SETTLING_SIG handshake and prover_pipeline.ts's markSettling), and the
// orchestration itself (runArbitrumSettlementSequence) is deps-injected so
// the state machine — every transition, every crash point, every tx revert —
// is unit-testable without a live chain. See arbitrum_settlement.gate.test.ts.
import { createWalletClient, encodeFunctionData, fallback, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { PublicClient } from "viem";
import type { ProofOutputJson } from "./prover_pipeline";
import { ZK_DIR, alert } from "./prover_pipeline";
import { recordAlertReason, setArbitrumSettlement, type ArbitrumSettlementStage } from "./intent_state";
import { setArbitrumStage, getArbitrumLedgerEntry, getMidSequenceEntries, getAwaitingExpirySlashEntries, getCollateralPostedEntries } from "./arbitrum_ledger";
import { isAlreadySettled } from "./prover_pipeline";

// ─── Config ──────────────────────────────────────────────────────────────────

const MAX_TRANSFER_WEI = BigInt(process.env.MAX_TRANSFER_WEI ?? "10000000000000000"); // 0.01 ETH
const DELIVERY_MARGIN_SEC = Number(process.env.DELIVERY_MARGIN_SEC ?? 600);
// Headroom above the exact 150% collateral requirement so postCollateral's
// own gas cost never turns "solver can afford collateral" into "solver ran
// out of ETH mid-tx" — no spec default given, 0.001 ETH is generous for a
// single L2 write at Arbitrum Sepolia's gas prices.
const ARBITRUM_GAS_BUFFER_WEI = BigInt(process.env.ARBITRUM_GAS_BUFFER_WEI ?? "1000000000000000");
const SOLANA_PAYOUT_RETRY_INTERVAL_MS = Number(process.env.SOLANA_PAYOUT_RETRY_INTERVAL_MS ?? 30_000);

// confirmSettlement retry schedule: 1, 5, 15, 30 min, then every 30 min
// thereafter, up to CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY past expiry.
const CONFIRM_RETRY_BACKOFF_MS = (process.env.CONFIRM_RETRY_BACKOFF_MS ?? "60000,300000,900000,1800000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
// Default 20h — must stay well inside IntentManager v2's 24h claimRefund
// grace period (REFUND_GRACE) so the user can never claim a refund out from
// under an escrow this process is still legitimately trying to confirm.
// Fails fast at boot rather than silently risking that race — see the check
// just below.
const CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY = Number(process.env.CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY ?? 72_000);
const CLAIM_REFUND_GRACE_SEC = 24 * 3600; // IntentManager v2's REFUND_GRACE constant
if (CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY >= CLAIM_REFUND_GRACE_SEC) {
  console.error(
    `[FATAL] CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY (${CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY}s) must stay below IntentManager v2's ` +
      `24h claimRefund grace period (${CLAIM_REFUND_GRACE_SEC}s), with margin — refusing to start with a value that could race claimRefund`
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Signers ─────────────────────────────────────────────────────────────────
// SECURITY: ARBITRUM_SOLVER_PRIVATE_KEY / ARBITRUM_ORCHESTRATOR_PRIVATE_KEY
// are read ONCE, right here, into a viem account — and never bound to any
// other variable, logged, thrown inside an Error, or interpolated into any
// string. Only `.address` (public, safe) ever leaves this block. This has to
// hold by construction: redact()'s long-opaque-token pass explicitly does
// NOT catch a bare 0x-prefixed 64-hex string — it's the same shape as a tx
// hash or intent id, which must survive redaction — so a leaked raw key
// would NOT be caught by the same safety net that catches an RPC URL. See
// this repo's gate report for the grep-based proof this holds.
const ALCHEMY_RPC_URLS = [process.env.ALCHEMY_RPC_URL_1, process.env.ALCHEMY_RPC_URL_2, process.env.ALCHEMY_RPC_URL_3].filter(
  (u): u is string => Boolean(u && u.length > 0)
);

function requiredPrivateKeyEnv(name: string): Hex {
  const v = process.env[name];
  if (!v) {
    console.error(`[FATAL] ${name} must be set in .env`);
    process.exit(1);
  }
  return v as Hex;
}

const solverAccount = privateKeyToAccount(requiredPrivateKeyEnv("ARBITRUM_SOLVER_PRIVATE_KEY"));
const orchestratorAccount = privateKeyToAccount(requiredPrivateKeyEnv("ARBITRUM_ORCHESTRATOR_PRIVATE_KEY"));

console.log(`[ARB-SETTLE] solver address:       ${solverAccount.address}`);
console.log(`[ARB-SETTLE] orchestrator address: ${orchestratorAccount.address}`);

const transport = fallback(ALCHEMY_RPC_URLS.map((u) => http(u)));
const solverWalletClient = createWalletClient({ account: solverAccount, chain: arbitrumSepolia, transport });
const orchestratorWalletClient = createWalletClient({ account: orchestratorAccount, chain: arbitrumSepolia, transport });

// ─── ABI (v2 — just the functions/reads this sequence needs) ────────────────

export const INTENT_MANAGER_V2_WRITE_ABI = [
  {
    type: "function",
    name: "postCollateral",
    stateMutability: "payable",
    inputs: [{ name: "intentId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "confirmSettlement",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intentId", type: "bytes32" },
      { name: "zkProofHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "slashSolver",
    stateMutability: "nonpayable",
    inputs: [{ name: "intentId", type: "bytes32" }],
    outputs: [],
  },
] as const;

export const INTENT_MANAGER_V2_READ_ABI = [
  {
    type: "function",
    name: "intents",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "tokenAddress", type: "address" },
      { name: "destinationWallet", type: "bytes32" },
      { name: "destinationChainId", type: "uint64" },
      { name: "expiry", type: "uint64" },
      { name: "slippageBps", type: "uint16" },
      { name: "status", type: "uint8" },
      { name: "solver", type: "address" },
      { name: "collateralPosted", type: "uint256" },
      { name: "zkProofHash", type: "bytes32" },
      { name: "createdAt", type: "uint256" },
      { name: "settledAt", type: "uint256" },
    ],
  },
] as const;

// Mirrors IntentManager.sol's IntentStatus enum order exactly (append-only).
export const INTENT_STATUS_PENDING = 0;
export const INTENT_STATUS_SETTLED = 1;
export const INTENT_STATUS_EXPIRED = 2;
export const INTENT_STATUS_SLASHED = 3;
export const INTENT_STATUS_REFUNDED = 4;

export interface OnChainIntent {
  owner: `0x${string}`;
  amount: bigint;
  tokenAddress: `0x${string}`;
  status: number;
  solver: `0x${string}`;
  collateralPosted: bigint;
}

// ─── Pure logic (unit-testable without any chain access) ────────────────────

export interface ArbitrumGateParams {
  maxTransferWei: bigint;
  solverBalanceWei: bigint;
  gasBufferWei: bigint;
  nowSec: number;
  deliveryMarginSec: number;
}

/// Extra checks beyond the existing 6-check settle gate (evaluateSettleGate),
/// run before ANY collateral is posted. Failing any of these means no
/// collateral is ever posted for this intent — the user's only recourse is
/// cancelIntent after expiry, exactly like an intent no solver ever touched.
export function evaluateArbitrumGate(json: ProofOutputJson, params: ArbitrumGateParams): { ok: boolean; failedChecks: string[] } {
  const failed: string[] = [];
  if (json.token_address.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
    failed.push("token_not_native");
  }
  const amount = BigInt(json.amount);
  if (amount > params.maxTransferWei) {
    failed.push("amount_exceeds_max_transfer");
  }
  const requiredCollateral = (amount * 150n) / 100n;
  if (params.solverBalanceWei < requiredCollateral + params.gasBufferWei) {
    failed.push("insufficient_solver_balance");
  }
  if (params.nowSec >= json.expiry - params.deliveryMarginSec) {
    failed.push("too_close_to_expiry");
  }
  return { ok: failed.length === 0, failedChecks: failed };
}

export function computeZkProofHash(intentIdHex: string): `0x${string}` {
  const binPath = path.join(ZK_DIR, `proof_${intentIdHex}.bin`);
  const bytes = fs.readFileSync(binPath);
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

// ─── Injectable dependencies — real (viem) vs. test (mocked) ────────────────

export interface TxOutcome {
  ok: boolean;
  txHash?: `0x${string}`;
  error?: string;
}

export interface SolanaPayoutResult {
  ok: boolean;
  sig?: string;
  error?: string;
}

export interface ArbitrumSettlementDeps {
  solverAddress: `0x${string}`;
  orchestratorAddress: `0x${string}`;
  getSolverBalanceWei(): Promise<bigint>;
  readIntent(intentId: `0x${string}`): Promise<OnChainIntent>;
  /** Signs, calls onSigned(hash) BEFORE broadcasting, then broadcasts and
   *  waits for the receipt. */
  postCollateral(intentId: `0x${string}`, valueWei: bigint, onSigned: (hash: `0x${string}`) => void): Promise<TxOutcome>;
  confirmSettlement(intentId: `0x${string}`, zkProofHash: `0x${string}`, onSigned: (hash: `0x${string}`) => void): Promise<TxOutcome>;
  slashSolver(intentId: `0x${string}`, onSigned: (hash: `0x${string}`) => void): Promise<TxOutcome>;
  runSolanaPayout(): Promise<SolanaPayoutResult>;
  nowSec(): number;
}

async function signAndSend(
  walletClient: typeof solverWalletClient,
  publicClient: PublicClient,
  account: typeof solverAccount,
  params: { functionName: "postCollateral" | "confirmSettlement" | "slashSolver"; args: readonly unknown[]; value?: bigint; address: `0x${string}` },
  onSigned: (hash: `0x${string}`) => void
): Promise<TxOutcome> {
  try {
    const data = encodeFunctionData({ abi: INTENT_MANAGER_V2_WRITE_ABI, functionName: params.functionName, args: params.args as never });
    const request = await walletClient.prepareTransactionRequest({
      account,
      to: params.address,
      data,
      value: params.value ?? 0n,
      chain: arbitrumSepolia,
    });
    const serializedTransaction = await walletClient.signTransaction(request);
    const hash = keccak256(serializedTransaction);
    onSigned(hash);
    await publicClient.sendRawTransaction({ serializedTransaction });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { ok: receipt.status === "success", txHash: hash, error: receipt.status === "success" ? undefined : "reverted" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function buildRealDeps(publicClient: PublicClient, intentManagerAddress: `0x${string}`, runSolanaPayout: () => Promise<SolanaPayoutResult>): ArbitrumSettlementDeps {
  return {
    solverAddress: solverAccount.address,
    orchestratorAddress: orchestratorAccount.address,
    async getSolverBalanceWei() {
      return publicClient.getBalance({ address: solverAccount.address });
    },
    async readIntent(intentId) {
      const result = (await publicClient.readContract({
        address: intentManagerAddress,
        abi: INTENT_MANAGER_V2_READ_ABI,
        functionName: "intents",
        args: [intentId],
      })) as readonly [
        `0x${string}`,
        bigint,
        `0x${string}`,
        `0x${string}`,
        bigint,
        bigint,
        number,
        number,
        `0x${string}`,
        bigint,
        `0x${string}`,
        bigint,
        bigint,
      ];
      return { owner: result[0], amount: result[1], tokenAddress: result[2], status: result[7], solver: result[8], collateralPosted: result[9] };
    },
    async postCollateral(intentId, valueWei, onSigned) {
      return signAndSend(solverWalletClient, publicClient, solverAccount, { functionName: "postCollateral", args: [intentId], value: valueWei, address: intentManagerAddress }, onSigned);
    },
    async confirmSettlement(intentId, zkProofHash, onSigned) {
      return signAndSend(orchestratorWalletClient, publicClient, orchestratorAccount, { functionName: "confirmSettlement", args: [intentId, zkProofHash], address: intentManagerAddress }, onSigned);
    },
    async slashSolver(intentId, onSigned) {
      return signAndSend(orchestratorWalletClient, publicClient, orchestratorAccount, { functionName: "slashSolver", args: [intentId], address: intentManagerAddress }, onSigned);
    },
    runSolanaPayout,
    nowSec: () => Math.floor(Date.now() / 1000),
  };
}

// ─── Orchestration (the state machine under test) ───────────────────────────

function mirrorDisplay(
  intentId: string,
  patch: { stage: ArbitrumSettlementStage; collateralTxHash?: string; confirmTxHash?: string; slashTxHash?: string; reason?: string }
): void {
  setArbitrumSettlement(intentId, patch);
}

/// Runs the full Arbitrum settlement sequence for one intent, after the
/// existing 6-check settle gate has already passed. Every branch below is
/// exercised by arbitrum_settlement.gate.test.ts with a mocked `deps`.
export async function runArbitrumSettlementSequence(deps: ArbitrumSettlementDeps, intentId: `0x${string}`, json: ProofOutputJson): Promise<void> {
  const intentIdHex = intentId.replace(/^0x/i, "").toLowerCase();

  // Already mid/past this sequence per the local ledger — never re-post
  // collateral or re-broadcast blindly. Boot reconciliation (not this
  // function) is what resolves a stale mid-sequence entry.
  const existing = getArbitrumLedgerEntry(intentId);
  if (existing && existing.stage !== "collateral_failed") {
    const reason = `Arbitrum settlement already in progress or done (stage: ${existing.stage}) — refusing to restart the sequence`;
    alert(`intent 0x${intentIdHex}: ${reason}`);
    recordAlertReason(intentId, reason);
    return;
  }

  const solverBalanceWei = await deps.getSolverBalanceWei();
  const gate = evaluateArbitrumGate(json, {
    maxTransferWei: MAX_TRANSFER_WEI,
    solverBalanceWei,
    gasBufferWei: ARBITRUM_GAS_BUFFER_WEI,
    nowSec: deps.nowSec(),
    deliveryMarginSec: DELIVERY_MARGIN_SEC,
  });
  if (!gate.ok) {
    const reason = `Arbitrum settle gate REFUSED (failed: ${gate.failedChecks.join(", ")}) — no collateral posted; user can reclaim via cancelIntent once the intent expires`;
    alert(`intent 0x${intentIdHex}: ${reason}`);
    recordAlertReason(intentId, reason);
    setArbitrumStage(intentId, "collateral_failed", { expiry: json.expiry });
    mirrorDisplay(intentId, { stage: "collateral_failed", reason });
    return;
  }

  // ── Step 1: postCollateral ──
  const collateralAmount = (BigInt(json.amount) * 150n) / 100n;
  const collateralOutcome = await deps.postCollateral(intentId, collateralAmount, (hash) => {
    setArbitrumStage(intentId, "posting_collateral", { collateralTxHash: hash, expiry: json.expiry });
    mirrorDisplay(intentId, { stage: "posting_collateral", collateralTxHash: hash });
  });
  if (!collateralOutcome.ok) {
    const reason = `postCollateral failed: ${collateralOutcome.error ?? "unknown"}`;
    alert(`intent 0x${intentIdHex}: ${reason}`);
    recordAlertReason(intentId, reason);
    setArbitrumStage(intentId, "collateral_failed", { collateralTxHash: collateralOutcome.txHash, expiry: json.expiry });
    mirrorDisplay(intentId, { stage: "collateral_failed", collateralTxHash: collateralOutcome.txHash, reason });
    return;
  }
  setArbitrumStage(intentId, "collateral_posted", { collateralTxHash: collateralOutcome.txHash, expiry: json.expiry });
  mirrorDisplay(intentId, { stage: "collateral_posted", collateralTxHash: collateralOutcome.txHash });

  // ── Step 2: on-chain solver/status check — never pay on Solana otherwise ──
  const onChain = await deps.readIntent(intentId);
  if (onChain.solver.toLowerCase() !== deps.solverAddress.toLowerCase() || onChain.status !== INTENT_STATUS_PENDING) {
    const reason = `on-chain check after postCollateral failed (solver=${onChain.solver}, status=${onChain.status}) — stopping, will NOT pay on Solana`;
    alert(`intent 0x${intentIdHex}: ${reason}`);
    recordAlertReason(intentId, reason);
    return;
  }

  // ── Step 3: Solana payout (existing flow, unchanged) — retried until
  // expiry - DELIVERY_MARGIN_SEC, then handed to the slash poller ──
  let solanaResult = await deps.runSolanaPayout();
  while (!solanaResult.ok && deps.nowSec() < json.expiry - DELIVERY_MARGIN_SEC) {
    console.warn(`[ARB-SETTLE] intent 0x${intentIdHex}: Solana payout failed (${solanaResult.error ?? "unknown"}) — retrying in ${SOLANA_PAYOUT_RETRY_INTERVAL_MS}ms`);
    await sleep(SOLANA_PAYOUT_RETRY_INTERVAL_MS);
    solanaResult = await deps.runSolanaPayout();
  }

  if (!solanaResult.ok) {
    const reason = `Solana payout never succeeded before expiry - DELIVERY_MARGIN_SEC (last error: ${solanaResult.error ?? "unknown"}) — awaiting expiry to slash the solver`;
    alert(`intent 0x${intentIdHex}: ${reason}`);
    recordAlertReason(intentId, reason);
    setArbitrumStage(intentId, "awaiting_expiry_slash", { expiry: json.expiry });
    mirrorDisplay(intentId, { stage: "awaiting_expiry_slash", reason });
    return;
  }

  // ── Step 4: confirmSettlement, retried with backoff ──
  await confirmSettlementWithRetry(deps, intentId, json);
}

/// Retries confirmSettlement with backoff (1, 5, 15, 30 min, then every 30
/// min) up to expiry + CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY — well inside
/// IntentManager v2's 24h claimRefund grace period (REFUND_GRACE), so the
/// user can never claim a refund out from under an escrow that's still
/// legitimately being confirmed. Before EVERY attempt (including the first),
/// re-reads intents(intentId) on-chain first: Settled means a previous
/// attempt actually landed despite reporting failure (or something else
/// confirmed it) — mark confirmed and stop, never re-send. Slashed/Refunded
/// means someone/something else already resolved this intent — stop and
/// alert rather than attempting a confirmSettlement that can only revert.
export async function confirmSettlementWithRetry(deps: ArbitrumSettlementDeps, intentId: `0x${string}`, json: ProofOutputJson): Promise<void> {
  const intentIdHex = intentId.replace(/^0x/i, "").toLowerCase();
  const zkProofHash = computeZkProofHash(intentIdHex);
  const deadline = json.expiry + CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY;

  for (let attempt = 1; ; attempt++) {
    const onChain = await deps.readIntent(intentId);
    if (onChain.status === INTENT_STATUS_SETTLED) {
      setArbitrumStage(intentId, "confirmed", { expiry: json.expiry });
      mirrorDisplay(intentId, { stage: "confirmed" });
      return;
    }
    if (onChain.status === INTENT_STATUS_SLASHED || onChain.status === INTENT_STATUS_REFUNDED) {
      const reason = `intent was ${onChain.status === INTENT_STATUS_SLASHED ? "Slashed" : "Refunded"} on-chain while confirmSettlement was retrying — stopping`;
      alert(`intent 0x${intentIdHex}: ${reason}`);
      recordAlertReason(intentId, reason);
      return;
    }

    const confirmOutcome = await deps.confirmSettlement(intentId, zkProofHash, (hash) => {
      setArbitrumStage(intentId, "confirming", { confirmTxHash: hash, expiry: json.expiry });
      mirrorDisplay(intentId, { stage: "confirming", confirmTxHash: hash });
    });
    if (confirmOutcome.ok) {
      setArbitrumStage(intentId, "confirmed", { confirmTxHash: confirmOutcome.txHash, expiry: json.expiry });
      mirrorDisplay(intentId, { stage: "confirmed", confirmTxHash: confirmOutcome.txHash });
      return;
    }

    if (deps.nowSec() >= deadline) {
      const reason =
        `confirmSettlement failed ${attempt} time(s) (last: ${confirmOutcome.error ?? "unknown"}) and the retry deadline ` +
        `(expiry + ${CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY}s) has passed — escrow + collateral STUCK, needs manual review before the 24h claimRefund window`;
      alert(`intent 0x${intentIdHex}: ${reason}`);
      recordAlertReason(intentId, reason);
      mirrorDisplay(intentId, { stage: "confirming", confirmTxHash: confirmOutcome.txHash, reason });
      return;
    }
    const backoff = CONFIRM_RETRY_BACKOFF_MS[Math.min(attempt - 1, CONFIRM_RETRY_BACKOFF_MS.length - 1)];
    console.warn(`[ARB-SETTLE] intent 0x${intentIdHex}: confirmSettlement attempt ${attempt} failed (${confirmOutcome.error ?? "unknown"}) — retrying in ${backoff}ms`);
    await sleep(backoff);
  }
}

// ─── Slash poller (listener.ts calls this on an interval, like pollFinality) ──

export async function pollAwaitingSlash(deps: ArbitrumSettlementDeps): Promise<void> {
  for (const { intentId, entry } of getAwaitingExpirySlashEntries()) {
    if (entry.expiry == null || deps.nowSec() < entry.expiry) continue;
    const id = (`0x${intentId}`) as `0x${string}`;
    const outcome = await deps.slashSolver(id, (hash) => {
      setArbitrumStage(id, "slashing", { slashTxHash: hash });
      mirrorDisplay(id, { stage: "slashing", slashTxHash: hash });
    });
    if (!outcome.ok) {
      const reason = `slashSolver failed: ${outcome.error ?? "unknown"}`;
      alert(`intent ${id}: ${reason}`);
      recordAlertReason(id, reason);
      mirrorDisplay(id, { stage: "slashing", slashTxHash: outcome.txHash, reason });
      continue;
    }
    setArbitrumStage(id, "slashed", { slashTxHash: outcome.txHash });
    mirrorDisplay(id, { stage: "slashed", slashTxHash: outcome.txHash });
  }
}

// ─── Boot reconciliation — the chain is the source of truth ─────────────────
// For any intent left mid-sequence (a tx was signed and its hash recorded,
// but this process never learned the outcome), resolve it from the chain
// itself: the recorded tx's receipt if it exists, otherwise intents()'s
// current on-chain status. Never blindly re-broadcast — a "posting_collateral"
// tx may already have landed; re-sending postCollateral for the same intent
// would revert (SolverAlreadyPosted) at best or double-spend collateral at
// worst if some future version relaxed that guard.

export async function reconcileArbitrumLedger(deps: ArbitrumSettlementDeps, publicClient: PublicClient): Promise<void> {
  for (const { intentId, entry } of getMidSequenceEntries()) {
    const id = (`0x${intentId}`) as `0x${string}`;
    const txHash = entry.stage === "posting_collateral" ? entry.collateralTxHash : entry.stage === "confirming" ? entry.confirmTxHash : entry.slashTxHash;

    let receiptStatus: "success" | "reverted" | "pending" = "pending";
    if (txHash) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
        receiptStatus = receipt.status;
      } catch {
        receiptStatus = "pending"; // not yet mined (or never broadcast) — fall through to on-chain intent status below
      }
    }

    const onChain = await deps.readIntent(id);

    if (onChain.status === INTENT_STATUS_SETTLED) {
      setArbitrumStage(id, "confirmed", { confirmTxHash: entry.confirmTxHash ?? txHash });
      mirrorDisplay(id, { stage: "confirmed", confirmTxHash: entry.confirmTxHash ?? txHash });
      console.log(`[ARB-SETTLE] boot reconciliation: intent ${id} is Settled on-chain — marked confirmed.`);
      continue;
    }
    if (onChain.status === INTENT_STATUS_SLASHED) {
      setArbitrumStage(id, "slashed", { slashTxHash: entry.slashTxHash ?? txHash });
      mirrorDisplay(id, { stage: "slashed", slashTxHash: entry.slashTxHash ?? txHash });
      console.log(`[ARB-SETTLE] boot reconciliation: intent ${id} is Slashed on-chain — marked slashed.`);
      continue;
    }
    if (onChain.status === INTENT_STATUS_REFUNDED) {
      const reason = "intent was Refunded on-chain (claimRefund) while mid-sequence — needs manual review";
      alert(`intent ${id}: ${reason}`);
      recordAlertReason(id, reason);
      continue;
    }

    if (entry.stage === "posting_collateral") {
      if (receiptStatus === "success") {
        setArbitrumStage(id, "collateral_posted", { collateralTxHash: txHash });
        mirrorDisplay(id, { stage: "collateral_posted", collateralTxHash: txHash });
        console.log(`[ARB-SETTLE] boot reconciliation: intent ${id}'s postCollateral tx landed — marked collateral_posted.`);
      } else if (receiptStatus === "reverted") {
        const reason = "postCollateral tx reverted (discovered on boot reconciliation)";
        setArbitrumStage(id, "collateral_failed", { collateralTxHash: txHash });
        mirrorDisplay(id, { stage: "collateral_failed", collateralTxHash: txHash, reason });
      } else {
        const reason = `postCollateral tx ${txHash} still pending after a restart — needs manual review, NOT auto-resubmitting`;
        alert(`intent ${id}: ${reason}`);
        recordAlertReason(id, reason);
      }
    } else if (entry.stage === "confirming") {
      if (receiptStatus === "reverted") {
        const reason = "confirmSettlement tx reverted (discovered on boot reconciliation) — escrow + collateral status unclear, needs manual review";
        alert(`intent ${id}: ${reason}`);
        recordAlertReason(id, reason);
      } else if (receiptStatus === "pending") {
        const reason = `confirmSettlement tx ${txHash} still pending after a restart — needs manual review, NOT auto-resubmitting`;
        alert(`intent ${id}: ${reason}`);
        recordAlertReason(id, reason);
      }
      // receiptStatus === "success" but onChain.status !== Settled would be
      // contradictory (confirmSettlement always flips to Settled on success)
      // — treated as impossible, not specially handled.
    } else if (entry.stage === "slashing") {
      if (receiptStatus === "reverted") {
        const reason = "slashSolver tx reverted (discovered on boot reconciliation) — needs manual review";
        alert(`intent ${id}: ${reason}`);
        recordAlertReason(id, reason);
      } else if (receiptStatus === "pending") {
        const reason = `slashSolver tx ${txHash} still pending after a restart — needs manual review, NOT auto-resubmitting`;
        alert(`intent ${id}: ${reason}`);
        recordAlertReason(id, reason);
      }
    }
  }

  // "collateral_posted" is a stable-looking intermediate stage (no tx
  // in flight), so it's not in getMidSequenceEntries() above — but if the
  // process crashed between the Solana payout succeeding and
  // confirmSettlement ever being attempted, it's just as stuck. Flagged for
  // manual follow-up rather than auto-resumed: re-entering
  // runArbitrumSettlementSequence from here would need to skip steps 1-3,
  // which the current linear sequence doesn't support, and resuming a
  // multi-step onchain sequence unattended after an unknown-duration outage
  // is exactly the kind of ambiguous case this codebase prefers to surface
  // loudly (see setUnconfirmedNeedsReview's equivalent choice for the Solana
  // leg) rather than silently guess its way through.
  for (const { intentId, entry } of getCollateralPostedEntries()) {
    const id = (`0x${intentId}`) as `0x${string}`;
    if (isAlreadySettled(id)) {
      const reason = `collateral posted (tx ${entry.collateralTxHash}) and the Solana payout already succeeded, but confirmSettlement was never attempted (process restart mid-sequence) — needs manual resumption`;
      alert(`intent ${id}: ${reason}`);
      recordAlertReason(id, reason);
    }
  }
}
