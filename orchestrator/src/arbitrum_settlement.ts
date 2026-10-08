// Arbitrum-side settlement sequence (Phase 7B): postCollateral -> (on-chain
// solver check) -> Solana payout (existing flow, unchanged, injected as
// deps.runSolanaPayout) -> confirmSettlement on success, or retry-then-
// slashSolver on failure. Every write is recorded to arbitrum_ledger.ts
// BEFORE broadcast (same tx-hash-before-broadcast pattern as settle_intent.js's
// SETTLING_SIG handshake and prover_pipeline.ts's markSettling), and the
// orchestration itself (runArbitrumSettlementSequence) is deps-injected so
// the state machine — every transition, every crash point, every tx revert —
// is unit-testable without a live chain. See arbitrum_settlement.gate.test.ts.
import { createWalletClient, encodeFunctionData, keccak256, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { PublicClient } from "viem";
import type { ProofOutputJson } from "./prover_pipeline";
import { ZK_DIR, alert } from "./prover_pipeline";
import { recordAlertReason, setArbitrumSettlement, setSettled, setSolverRouting, type ArbitrumSettlementStage } from "./intent_state";
import {
  setArbitrumStage,
  getArbitrumLedgerEntry,
  getMidSequenceEntries,
  getAwaitingExpirySlashEntries,
  getCollateralPostedEntries,
  type ArbitrumLedgerEntry,
  type RoutingDecisionFields,
} from "./arbitrum_ledger";
import { isAlreadySettled, readProofJson, getLedgerEntry, markSettled } from "./prover_pipeline";
import { redact } from "./redact";
import { createRotatingHttpTransport } from "./rpc_rotation";

// ─── Config ──────────────────────────────────────────────────────────────────

// Exported (Phase 3) so solver_routing.ts's hard gates run evaluateArbitrumGate
// with these exact values — one source of truth, never a second copy.
export const MAX_TRANSFER_WEI = BigInt(process.env.MAX_TRANSFER_WEI ?? "10000000000000000"); // 0.01 ETH
export const DELIVERY_MARGIN_SEC = Number(process.env.DELIVERY_MARGIN_SEC ?? 600);
// Headroom above the exact 150% collateral requirement so postCollateral's
// own gas cost never turns "solver can afford collateral" into "solver ran
// out of ETH mid-tx" — no spec default given, 0.001 ETH is generous for a
// single L2 write at Arbitrum Sepolia's gas prices.
export const ARBITRUM_GAS_BUFFER_WEI = BigInt(process.env.ARBITRUM_GAS_BUFFER_WEI ?? "1000000000000000");
const SOLANA_PAYOUT_RETRY_INTERVAL_MS = Number(process.env.SOLANA_PAYOUT_RETRY_INTERVAL_MS ?? 30_000);
// Gate 5D-race-fix: the Step 2 on-chain check runs right after postCollateral's
// OWN tx receipt was already confirmed — but that receipt and this read can
// land on DIFFERENT nodes behind createRotatingHttpTransport's round-robin
// (rpc_rotation.ts), so a node that hasn't caught up yet can still answer
// with the pre-post default (solver=0x0, status=Pending) even though the tx
// genuinely succeeded elsewhere. These retries are ONLY taken for exactly
// that shape (see readIntentAfterPostCollateral) — a real conflict (a
// different solver, or a non-Pending status) still fails on the first read.
const POST_COLLATERAL_VERIFY_ATTEMPTS = Number(process.env.POST_COLLATERAL_VERIFY_ATTEMPTS ?? 3);
const POST_COLLATERAL_VERIFY_DELAY_MS = Number(process.env.POST_COLLATERAL_VERIFY_DELAY_MS ?? 2000);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

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

// ─── Multi-solver key loading (Week 3 design, §3.9 / Phase 1) ───────────────
// ARBITRUM_SOLVER_PRIVATE_KEY_1, _2, ... _N (indexed, mirroring
// ALCHEMY_RPC_URL_1/2/3's convention in rpc_rotation.ts) — read once, right
// here, same discipline as every other key load in this file: only
// `.address` (public, safe) ever leaves this block via the exported
// SolverAccountConfig list. Legacy single ARBITRUM_SOLVER_PRIVATE_KEY is
// treated as key 1 when no numbered vars are set, so a single-key .env is
// unaffected by this change.

export interface SolverPrivateKeyEnvEntry {
  envVarName: string;
  privateKey: Hex;
}

/// Pure — takes an env-like object so it's unit-testable without touching
/// process.env or module load order. Numbered keys are collected from _1
/// upward and stop at the first gap (matching "indexed" env-var reading
/// elsewhere in this codebase); if none are set at all, falls back to the
/// legacy single var as key 1.
export function collectSolverPrivateKeyEnvEntries(env: NodeJS.ProcessEnv = process.env): SolverPrivateKeyEnvEntry[] {
  const numbered: SolverPrivateKeyEnvEntry[] = [];
  for (let i = 1; ; i++) {
    const envVarName = `ARBITRUM_SOLVER_PRIVATE_KEY_${i}`;
    const v = env[envVarName];
    if (!v) break;
    numbered.push({ envVarName, privateKey: v as Hex });
  }
  if (numbered.length > 0) return numbered;
  const legacy = env.ARBITRUM_SOLVER_PRIVATE_KEY;
  return legacy ? [{ envVarName: "ARBITRUM_SOLVER_PRIVATE_KEY", privateKey: legacy as Hex }] : [];
}

/// Pure — operator visibility for a mistake collectSolverPrivateKeyEnvEntries
/// otherwise resolves silently: a numbered var set PAST the first gap (e.g.
/// _1 set, _2 missing, _3 set) is never loaded (the collector stops at the
/// gap), so without this it would look like _3 was simply never configured.
/// Never fatal — only a warning naming exactly which var is ignored and why.
export function findOrphanedSolverPrivateKeyEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  let contiguous = 0;
  while (env[`ARBITRUM_SOLVER_PRIVATE_KEY_${contiguous + 1}`]) contiguous++;
  const firstMissing = contiguous + 1;
  const orphanIndices: number[] = [];
  const pattern = /^ARBITRUM_SOLVER_PRIVATE_KEY_(\d+)$/;
  for (const key of Object.keys(env)) {
    const match = pattern.exec(key);
    if (!match) continue;
    const idx = Number(match[1]);
    if (idx > contiguous && env[key]) orphanIndices.push(idx);
  }
  orphanIndices.sort((a, b) => a - b);
  return orphanIndices.map((idx) => `ARBITRUM_SOLVER_PRIVATE_KEY_${idx} is set but _${firstMissing} is missing - ignoring it`);
}

/// Pure — operator visibility for the other silent case: when any numbered
/// var is set, collectSolverPrivateKeyEnvEntries ignores the legacy var
/// entirely (§3.9's documented priority) — worth a NOTE so an operator who
/// set both doesn't wonder why the legacy key isn't in use.
export function legacySolverKeyIgnoredNote(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ARBITRUM_SOLVER_PRIVATE_KEY_1 && env.ARBITRUM_SOLVER_PRIVATE_KEY) {
    return "ARBITRUM_SOLVER_PRIVATE_KEY (legacy) is also set but is ignored because ARBITRUM_SOLVER_PRIVATE_KEY_1 is present - remove one to avoid confusion";
  }
  return null;
}

export interface ResolvedSolverAccount {
  envVarName: string;
  address: `0x${string}`;
}

/// Pure — derives each entry's address (never returns the signing Account
/// object itself) and throws if two entries resolve to the same address.
/// Boot checks per §3.9: "addresses must be unique."
export function resolveSolverAccounts(entries: SolverPrivateKeyEnvEntry[]): ResolvedSolverAccount[] {
  const seenBy = new Map<string, string>(); // lowercased address -> envVarName that first claimed it
  const out: ResolvedSolverAccount[] = [];
  for (const entry of entries) {
    const { address } = privateKeyToAccount(entry.privateKey);
    const lower = address.toLowerCase();
    const claimedBy = seenBy.get(lower);
    if (claimedBy) {
      throw new Error(`duplicate solver address ${address}: configured under both ${claimedBy} and ${entry.envVarName}`);
    }
    seenBy.set(lower, entry.envVarName);
    out.push({ envVarName: entry.envVarName, address });
  }
  return out;
}

const orchestratorAccount = privateKeyToAccount(requiredPrivateKeyEnv("ARBITRUM_ORCHESTRATOR_PRIVATE_KEY"));

const transport = createRotatingHttpTransport(ALCHEMY_RPC_URLS, "Arbitrum-settle");

interface SolverAccountConfig {
  envVarName: string;
  account: ReturnType<typeof privateKeyToAccount>;
  walletClient: WalletClient;
}

// IIFE so the raw private-key strings (collectSolverPrivateKeyEnvEntries's
// output) live only in this function's local scope, not in a persistent
// module-level binding — same "read once, only the derived .address/account
// survives" discipline as orchestratorAccount above, now that there's more
// than one line of work between reading the env var and deriving the
// account. Nothing outside this block ever sees the raw key strings.
const { solverAccounts, defaultSolverAccount }: { solverAccounts: SolverAccountConfig[]; defaultSolverAccount: ReturnType<typeof privateKeyToAccount> } = (() => {
  const entries = collectSolverPrivateKeyEnvEntries();
  if (entries.length === 0) {
    console.error("[FATAL] ARBITRUM_SOLVER_PRIVATE_KEY (or ARBITRUM_SOLVER_PRIVATE_KEY_1) must be set in .env");
    process.exit(1);
  }
  try {
    resolveSolverAccounts(entries);
  } catch (err) {
    console.error(`[FATAL] ${(err as Error).message}`);
    process.exit(1);
  }
  for (const warning of findOrphanedSolverPrivateKeyEnvVars()) {
    console.warn(`[ARB-SETTLE] WARNING: ${warning}`);
  }
  const legacyNote = legacySolverKeyIgnoredNote();
  if (legacyNote) {
    console.log(`[ARB-SETTLE] NOTE: ${legacyNote}`);
  }
  const accounts: SolverAccountConfig[] = entries.map((entry) => {
    const account = privateKeyToAccount(entry.privateKey);
    return { envVarName: entry.envVarName, account, walletClient: createWalletClient({ account, chain: arbitrumSepolia, transport }) };
  });
  // Preserves today's single-solver behavior byte-for-byte: every existing
  // call site that doesn't pass an explicit solverAddress (i.e. everything —
  // Phase 1 makes NO routing change) resolves to this one, exactly as before.
  return { solverAccounts: accounts, defaultSolverAccount: accounts[0].account };
})();

console.log(`[ARB-SETTLE] loaded ${solverAccounts.length} solver key(s): ${solverAccounts.map((cfg) => cfg.account.address).join(", ")}`);
console.log(`[ARB-SETTLE] solver address:       ${defaultSolverAccount.address}`);
for (const cfg of solverAccounts.slice(1)) {
  console.log(`[ARB-SETTLE] additional solver address (${cfg.envVarName}): ${cfg.account.address}`);
}
console.log(`[ARB-SETTLE] orchestrator address: ${orchestratorAccount.address}`);

/// Every configured ARBITRUM_SOLVER_PRIVATE_KEY* address, in key order —
/// the full, unfiltered routing candidate list (solver_routing.ts). Addresses
/// only, never the accounts/keys themselves.
export function configuredSolverAddresses(): `0x${string}`[] {
  return solverAccounts.map((cfg) => cfg.account.address);
}

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
  {
    type: "function",
    name: "approvedSolvers",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
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
  /** Gate 5D-vkey: zkProofHash is the SAME value (computeZkProofHash's
   *  output, computed once by the caller) that confirmSettlement below
   *  sends to Arbitrum — one source of truth for both legs, never
   *  recomputed independently on the Solana side. */
  runSolanaPayout(zkProofHash: `0x${string}`): Promise<SolanaPayoutResult>;
  /** Gate 5D-slash-fix: checks a Solana signature's status FRESH, right now
   *  — never a cached/local flag. Used by pollAwaitingSlash immediately
   *  before it would otherwise slash, so a payout that actually landed (but
   *  whose local "settling" record was never resolved to "settled") is
   *  never punished. Same underlying check as prover_pipeline.ts's
   *  reconcileSettlingLedger — see listener.ts's real implementation. */
  checkSolanaSignatureLanded(sig: string): Promise<boolean>;
  nowSec(): number;
  /** Phase 3: set only by solver_routing.ts's dispatchArbitrumSettlement.
   *  Spread into every pre-collateral ledger write below, so the routing
   *  decision lands in the same pre-broadcast patch as `solver`. Absent for
   *  every other caller (reconciliation, the slash poller, existing tests),
   *  which therefore write byte-identical ledger entries to before. */
  routing?: RoutingDecisionFields;
}

async function signAndSend(
  walletClient: WalletClient,
  publicClient: PublicClient,
  account: ReturnType<typeof privateKeyToAccount>,
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

/// Reads intents(intentId) after postCollateral's tx receipt has already
/// been confirmed. If the read comes back looking exactly like the pre-post
/// default (solver still the zero address AND status still Pending), that's
/// indistinguishable from "this particular RPC node hasn't caught up to the
/// confirmed block yet" — postCollateral either sets solver to the caller or
/// reverts, so nothing legitimate produces that exact shape after a
/// successful post. Retried up to `attempts` times, `delayMs` apart, before
/// being returned as-is. ANY other reading — a different real solver
/// address, or a non-Pending status — returns immediately on the first read:
/// that can never be explained by staleness, only by a genuine conflict, and
/// retrying it would just mask a real double-post/slash/refund race.
export async function readIntentAfterPostCollateral(
  deps: ArbitrumSettlementDeps,
  intentId: `0x${string}`,
  opts: { attempts?: number; delayMs?: number } = {}
): Promise<OnChainIntent> {
  const attempts = opts.attempts ?? POST_COLLATERAL_VERIFY_ATTEMPTS;
  const delayMs = opts.delayMs ?? POST_COLLATERAL_VERIFY_DELAY_MS;
  let onChain = await deps.readIntent(intentId);
  for (
    let attempt = 1;
    attempt < attempts && onChain.solver.toLowerCase() === ZERO_ADDRESS && onChain.status === INTENT_STATUS_PENDING;
    attempt++
  ) {
    await sleep(delayMs);
    onChain = await deps.readIntent(intentId);
  }
  return onChain;
}

/// solverAddress defaults to the first configured ARBITRUM_SOLVER_PRIVATE_KEY*
/// account — every existing call site omits it, so single-key behavior is
/// byte-for-byte identical to before this function gained the parameter.
/// Phase 1 makes NO routing change: callers that dispatch NEW settlements
/// (triggerZKVerification) still never pass this explicitly either — that's
/// Phase 3's job (selectSolver). This parameter exists today only so
/// reconciliation/resume paths can rebuild deps scoped to whichever solver a
/// ledger entry recorded (see resumeCollateralPostedIntent).
export function buildRealDeps(
  publicClient: PublicClient,
  intentManagerAddress: `0x${string}`,
  runSolanaPayout: (zkProofHash: `0x${string}`) => Promise<SolanaPayoutResult>,
  checkSolanaSignatureLanded: (sig: string) => Promise<boolean>,
  solverAddress: `0x${string}` = defaultSolverAccount.address
): ArbitrumSettlementDeps {
  const solverCfg = solverAccounts.find((cfg) => cfg.account.address.toLowerCase() === solverAddress.toLowerCase());
  if (!solverCfg) {
    throw new Error(`buildRealDeps: ${solverAddress} is not among the configured ARBITRUM_SOLVER_PRIVATE_KEY* accounts`);
  }
  return {
    solverAddress: solverCfg.account.address,
    orchestratorAddress: orchestratorAccount.address,
    async getSolverBalanceWei() {
      return publicClient.getBalance({ address: solverCfg.account.address });
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
      return signAndSend(solverCfg.walletClient, publicClient, solverCfg.account, { functionName: "postCollateral", args: [intentId], value: valueWei, address: intentManagerAddress }, onSigned);
    },
    async confirmSettlement(intentId, zkProofHash, onSigned) {
      return signAndSend(orchestratorWalletClient, publicClient, orchestratorAccount, { functionName: "confirmSettlement", args: [intentId, zkProofHash], address: intentManagerAddress }, onSigned);
    },
    async slashSolver(intentId, onSigned) {
      return signAndSend(orchestratorWalletClient, publicClient, orchestratorAccount, { functionName: "slashSolver", args: [intentId], address: intentManagerAddress }, onSigned);
    },
    runSolanaPayout,
    checkSolanaSignatureLanded,
    nowSec: () => Math.floor(Date.now() / 1000),
  };
}

export interface SolverApprovalStatus {
  envVarName: string;
  address: `0x${string}`;
  approved: boolean;
}

/// Boot check per §3.9: fresh on-chain read for every configured solver key,
/// never cached. An unapproved key is NOT fatal — Solver B can be configured
/// before its setSolver approval lands — it's just excluded from routing
/// (Phase 3) until it is. Phase 1 has no routing yet, so this is
/// informational (a warning) rather than gating anything itself.
/// Fresh approvedSolvers(address) read — never cached. Shared by the boot
/// check below and solver_routing.ts's per-intent approval gate.
export async function isSolverApprovedOnChain(publicClient: PublicClient, intentManagerAddress: `0x${string}`, solverAddress: `0x${string}`): Promise<boolean> {
  return (await publicClient.readContract({
    address: intentManagerAddress,
    abi: INTENT_MANAGER_V2_READ_ABI,
    functionName: "approvedSolvers",
    args: [solverAddress],
  })) as boolean;
}

export async function checkSolverApprovals(publicClient: PublicClient, intentManagerAddress: `0x${string}`): Promise<SolverApprovalStatus[]> {
  const out: SolverApprovalStatus[] = [];
  for (const cfg of solverAccounts) {
    const approved = await isSolverApprovedOnChain(publicClient, intentManagerAddress, cfg.account.address);
    if (!approved) {
      console.warn(`[ARB-SETTLE] WARNING: solver ${cfg.account.address} (${cfg.envVarName}) is not approved on-chain yet (see setSolver) — excluded from routing until approved`);
    } else {
      console.log(`[ARB-SETTLE] solver ${cfg.account.address} (${cfg.envVarName}) is approved on-chain`);
    }
    out.push({ envVarName: cfg.envVarName, address: cfg.account.address, approved });
  }
  return out;
}

// ─── Orchestration (the state machine under test) ───────────────────────────

function mirrorDisplay(
  intentId: string,
  patch: { stage: ArbitrumSettlementStage; collateralTxHash?: string; confirmTxHash?: string; slashTxHash?: string; reason?: string }
): void {
  setArbitrumSettlement(intentId, patch);
}

/// Phase 4: display mirror of the routing decision, called right after every
/// ledger write that carries it, so the dashboard and the ledger never
/// disagree. No-op when the patch has no routing decision (reconciliation,
/// the slash poller, any caller other than dispatchArbitrumSettlement).
function mirrorRouting(intentId: string, routing: Partial<RoutingDecisionFields> | undefined): void {
  if (routing?.routingReason === undefined) return;
  setSolverRouting(intentId, { solver: routing.selectedSolver ?? null, tier: routing.tierAtSelection ?? null, reason: routing.routingReason });
}

/// The "no collateral posted" refusal path: alert, record the reason, mark the
/// ledger collateral_failed, mirror it for display. The user's only recourse
/// is cancelIntent after expiry, exactly like an intent no solver ever
/// touched. Shared by runArbitrumSettlementSequence's own gate refusal and
/// solver_routing.ts's "no eligible solver" outcome, so both fail the same way.
export function refuseArbitrumSettlement(intentId: `0x${string}`, json: ProofOutputJson, reason: string, ledgerPatch: Partial<ArbitrumLedgerEntry> = {}): void {
  const intentIdHex = intentId.replace(/^0x/i, "").toLowerCase();
  alert(`intent 0x${intentIdHex}: ${reason}`);
  recordAlertReason(intentId, reason);
  setArbitrumStage(intentId, "collateral_failed", { ...ledgerPatch, expiry: json.expiry });
  mirrorRouting(intentId, ledgerPatch);
  mirrorDisplay(intentId, { stage: "collateral_failed", reason });
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
    const reason = `Arbitrum settle gate REFUSED (failed: ${gate.failedChecks.join(", ")}) — not settled; user can reclaim on the source chain via cancelIntent after expiry (no solver collateral) or claimRefund 24h after expiry (solver collateral posted)`;
    refuseArbitrumSettlement(intentId, json, reason, deps.routing);
    return;
  }

  // ── Step 1: postCollateral ──
  const collateralAmount = (BigInt(json.amount) * 150n) / 100n;
  const collateralOutcome = await deps.postCollateral(intentId, collateralAmount, (hash) => {
    // §3.8: solver recorded BEFORE broadcast, same timing as collateralTxHash
    // itself — this is the ledger's only source of truth for which
    // configured solver this intent belongs to; every later stage's merge
    // (setArbitrumStage spreads {...prev, ...patch}) carries it forward
    // without needing to repeat it.
    setArbitrumStage(intentId, "posting_collateral", { collateralTxHash: hash, expiry: json.expiry, solver: deps.solverAddress, ...deps.routing });
    mirrorRouting(intentId, deps.routing);
    mirrorDisplay(intentId, { stage: "posting_collateral", collateralTxHash: hash });
  });
  if (!collateralOutcome.ok) {
    const reason = `postCollateral failed: ${collateralOutcome.error ?? "unknown"}`;
    alert(`intent 0x${intentIdHex}: ${reason}`);
    recordAlertReason(intentId, reason);
    setArbitrumStage(intentId, "collateral_failed", { ...deps.routing, collateralTxHash: collateralOutcome.txHash, expiry: json.expiry });
    mirrorRouting(intentId, deps.routing);
    mirrorDisplay(intentId, { stage: "collateral_failed", collateralTxHash: collateralOutcome.txHash, reason });
    return;
  }
  setArbitrumStage(intentId, "collateral_posted", { collateralTxHash: collateralOutcome.txHash, expiry: json.expiry });
  mirrorDisplay(intentId, { stage: "collateral_posted", collateralTxHash: collateralOutcome.txHash });

  await resumeArbitrumSettlementFromCollateralPosted(deps, intentId, json);
}

/// Steps 2-4 of the settlement sequence, for an intent whose collateral is
/// ALREADY posted (Step 1 done). Factored out so it can run both inline,
/// right after Step 1 above, and from boot reconciliation (Gate 5D-race-fix)
/// for a "collateral_posted" ledger entry that never got past Step 2 or
/// crashed before Step 3 ever ran — previously reconcileArbitrumLedger only
/// resumed a collateral_posted entry whose Solana leg had ALREADY settled,
/// leaving that other case (e.g. Step 2's on-chain check failing on a stale
/// RPC read) a dead end no reconciliation pass ever revisited.
async function resumeArbitrumSettlementFromCollateralPosted(
  deps: ArbitrumSettlementDeps,
  intentId: `0x${string}`,
  json: ProofOutputJson
): Promise<void> {
  const intentIdHex = intentId.replace(/^0x/i, "").toLowerCase();

  // ── Step 2: on-chain solver/status check — never pay on Solana otherwise ──
  const onChain = await readIntentAfterPostCollateral(deps, intentId);
  if (onChain.solver.toLowerCase() !== deps.solverAddress.toLowerCase() || onChain.status !== INTENT_STATUS_PENDING) {
    const reason = `on-chain check after postCollateral failed (solver=${onChain.solver}, status=${onChain.status}) — stopping, will NOT pay on Solana`;
    alert(`intent 0x${intentIdHex}: ${reason}`);
    recordAlertReason(intentId, reason);
    return;
  }

  // Gate 5D-vkey: computed ONCE here and threaded through both legs below —
  // the Solana settlement (via deps.runSolanaPayout) and the Arbitrum
  // confirmSettlement call — so they always commit to the identical hash
  // for this intent, rather than each independently deriving (or, as
  // settle_intent.js used to, hardcoding) their own.
  const zkProofHash = computeZkProofHash(intentIdHex);
  console.log(`[ARB-SETTLE] intent 0x${intentIdHex}: zkProofHash for both legs = ${zkProofHash}`);

  // ── Step 3: Solana payout (existing flow, unchanged) — retried until
  // expiry - DELIVERY_MARGIN_SEC, then handed to the slash poller ──
  let solanaResult = await deps.runSolanaPayout(zkProofHash);
  while (!solanaResult.ok && deps.nowSec() < json.expiry - DELIVERY_MARGIN_SEC) {
    console.warn(`[ARB-SETTLE] intent 0x${intentIdHex}: Solana payout failed (${redact(solanaResult.error ?? "unknown")}) — retrying in ${SOLANA_PAYOUT_RETRY_INTERVAL_MS}ms`);
    await sleep(SOLANA_PAYOUT_RETRY_INTERVAL_MS);
    solanaResult = await deps.runSolanaPayout(zkProofHash);
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
  await confirmSettlementWithRetry(deps, intentId, json, zkProofHash);
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
export async function confirmSettlementWithRetry(
  deps: ArbitrumSettlementDeps,
  intentId: `0x${string}`,
  json: ProofOutputJson,
  zkProofHash: `0x${string}`
): Promise<void> {
  const intentIdHex = intentId.replace(/^0x/i, "").toLowerCase();
  console.log(`[ARB-SETTLE] intent 0x${intentIdHex}: confirming with zkProofHash ${zkProofHash}`);
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
    console.warn(`[ARB-SETTLE] intent 0x${intentIdHex}: confirmSettlement attempt ${attempt} failed (${redact(confirmOutcome.error ?? "unknown")}) — retrying in ${backoff}ms`);
    await sleep(backoff);
  }
}

// ─── Slash poller (listener.ts calls this on an interval, like pollFinality) ──

/// Gate 5D-slash-fix: the incident this closes — slashSolver fired for an
/// intent whose Solana payout had ACTUALLY succeeded, because nothing
/// re-checked the recorded Solana signature fresh before slashing. The
/// local settled-intent ledger's "settled" status is definitive once set;
/// its "settling" status is the ambiguous case (a payout that may have
/// landed despite this process never confirming it — see
/// prover_pipeline.ts's reconcileSettlingLedger) — and that ambiguous case
/// is exactly what must never be resolved by assumption immediately before
/// an irreversible slash. Mirrors the SAME discipline already used by
/// confirmSettlementWithRetry (fresh readIntent before every attempt) and
/// reconcileSettlingLedger (fresh getSignatureStatus) — re-check ground
/// truth at the moment of the decision, not from any snapshot taken
/// earlier. Returns true if slashing was averted (and confirmSettlement was
/// resumed, or an alert was recorded because it couldn't be) — the caller
/// must not slash in that case. Returns false only when there is nothing to
/// re-check (no Solana leg was ever recorded) or the fresh check confirms it
/// genuinely never landed — a genuinely non-delivering solver must still be
/// slashable.
async function resumeConfirmIfSolanaLanded(deps: ArbitrumSettlementDeps, id: `0x${string}`, intentIdHex: string): Promise<boolean> {
  const ledgerEntry = getLedgerEntry(id);
  if (!ledgerEntry) return false; // Solana leg never even started — nothing to re-check.

  let landed = ledgerEntry.status === "settled";
  if (!landed && ledgerEntry.solanaSig) {
    landed = await deps.checkSolanaSignatureLanded(ledgerEntry.solanaSig);
  }
  if (!landed) return false; // genuinely never delivered (or no signature to check) — slash as before.

  if (ledgerEntry.status !== "settled" && ledgerEntry.solanaSig) {
    // The fresh check just proved what reconcileSettlingLedger's own boot/
    // periodic check hadn't yet — bring the local ledger in line so nothing
    // downstream re-derives this from scratch.
    markSettled(id);
    setSettled(id, ledgerEntry.solanaSig);
  }

  const json = readProofJson(intentIdHex);
  if (!json) {
    const reason =
      `awaiting_expiry_slash, but the Solana payout (sig ${ledgerEntry.solanaSig ?? "unknown"}) is confirmed on Solana right now — refusing to ` +
      `slash a solver who delivered — but proof_${intentIdHex}.json is missing/invalid, so confirmSettlement cannot be resumed automatically ` +
      `either — needs manual review.`;
    alert(`intent ${id}: ${reason}`);
    recordAlertReason(id, reason);
    return true; // NOT slashed — that's the point — even though it can't fully resume either.
  }

  console.log(
    `[ARB-SETTLE] intent ${id}: awaiting_expiry_slash, but the Solana payout (sig ${ledgerEntry.solanaSig ?? "unknown"}) is confirmed on Solana ` +
      `right now — NOT slashing; resuming confirmSettlement instead.`
  );
  const zkProofHash = computeZkProofHash(intentIdHex);
  await confirmSettlementWithRetry(deps, id, json, zkProofHash);
  return true;
}

export async function pollAwaitingSlash(deps: ArbitrumSettlementDeps): Promise<void> {
  for (const { intentId, entry } of getAwaitingExpirySlashEntries()) {
    if (entry.expiry == null || deps.nowSec() < entry.expiry) continue;
    const id = (`0x${intentId}`) as `0x${string}`;

    if (await resumeConfirmIfSolanaLanded(deps, id, intentId)) continue;

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

/// Per-intent version of the "collateral_posted" resume logic inside
/// reconcileArbitrumLedger below — looks up the ledger entry itself and
/// no-ops if this intent isn't (or is no longer) sitting at
/// collateral_posted, so a caller can invoke it unconditionally for any
/// intent without first checking that itself. Gate 5D-wire-periodic-to-arbitrum:
/// this is what lets a Solana signature landing SIDE the periodic
/// reconcileSettlingLedger pass (prover_pipeline.ts) — not just at boot —
/// immediately resume the Arbitrum side for that one intent, instead of
/// leaving a collateral_posted entry stuck until the next process restart.
/// Same logic reconcileArbitrumLedger's boot pass runs for every
/// collateral_posted entry it finds — factored out here so both call sites
/// share one implementation.
export async function resumeCollateralPostedIntent(
  deps: ArbitrumSettlementDeps,
  intentId: `0x${string}`,
  buildRunSolanaPayout?: (intentId: `0x${string}`, json: ProofOutputJson) => (zkProofHash: `0x${string}`) => Promise<SolanaPayoutResult>
): Promise<void> {
  const intentIdHex = intentId.replace(/^0x/i, "").toLowerCase();
  const entry = getArbitrumLedgerEntry(intentIdHex);
  if (!entry || entry.stage !== "collateral_posted") return; // nothing to resume right now
  const id = (`0x${intentIdHex}`) as `0x${string}`;
  const alreadySettled = isAlreadySettled(id);

  // Gate 5D-resume-fix-2: wrapped so ANY unexpected throw (a vanished/
  // unreadable proof file, an RPC failure inside confirmSettlementWithRetry
  // or resumeArbitrumSettlementFromCollateralPosted) turns into an alert for
  // THIS intent rather than propagating to the caller and, for the periodic
  // reconciliation pass, potentially breaking that pass for every other
  // intent behind it.
  try {
    const json = readProofJson(intentIdHex);
    if (!json) {
      const reason = alreadySettled
        ? `collateral posted (tx ${entry.collateralTxHash}) and the Solana payout already succeeded, but proof_${intentIdHex}.json is missing/invalid — cannot resume confirmSettlement automatically, needs manual review`
        : `collateral posted (tx ${entry.collateralTxHash}) but proof_${intentIdHex}.json is missing/invalid — cannot resume the settlement sequence automatically, needs manual review`;
      alert(`intent ${id}: ${reason}`);
      recordAlertReason(id, reason);
      return;
    }

    if (alreadySettled) {
      const zkProofHash = computeZkProofHash(intentIdHex);
      console.log(`[ARB-SETTLE] intent ${id} is collateral_posted with the Solana payout already settled — resuming confirmSettlement.`);
      await confirmSettlementWithRetry(deps, id, json, zkProofHash);
    } else if (buildRunSolanaPayout) {
      // §3.8 migration: an entry written before the ledger's solver field
      // existed has none — default to deps.solverAddress (today's sole
      // solver). Either way, Step 2 inside
      // resumeArbitrumSettlementFromCollateralPosted below re-reads the
      // intent's ACTUAL on-chain solver and treats any mismatch against
      // this value as a genuine conflict (alerts, never pays Solana) — the
      // exact same check it already runs for a same-solver setup, so a
      // wrong/stale recorded solver can never cause a wrong payout, only a
      // (safe) alert.
      const resolvedSolverAddress = entry.solver ?? deps.solverAddress;
      // A real, per-intent runSolanaPayout — NOT the shared deps.runSolanaPayout
      // stub, which throws by design (see reconcileArbitrumLedger's own doc
      // comment below): this entry's Solana leg is a function of ITS OWN
      // intentId/json, which only the caller (listener.ts) can decode.
      const resumeDeps: ArbitrumSettlementDeps = { ...deps, solverAddress: resolvedSolverAddress, runSolanaPayout: buildRunSolanaPayout(id, json) };
      console.log(`[ARB-SETTLE] intent ${id} is collateral_posted but never got past the on-chain check — resuming from Step 2 (recorded solver: ${resolvedSolverAddress}).`);
      await resumeArbitrumSettlementFromCollateralPosted(resumeDeps, id, json);
    } else {
      const reason = `collateral posted (tx ${entry.collateralTxHash}) but the Solana leg was never started, and this reconciliation pass has no way to run it (no buildRunSolanaPayout provided) — needs manual review`;
      alert(`intent ${id}: ${reason}`);
      recordAlertReason(id, reason);
    }
  } catch (err) {
    const reason = alreadySettled
      ? `collateral posted (tx ${entry.collateralTxHash}) and the Solana payout already succeeded, but resuming confirmSettlement threw unexpectedly (${(err as Error).message}) — needs manual review; other intents' reconciliation is unaffected`
      : `collateral posted (tx ${entry.collateralTxHash}), but resuming the settlement sequence threw unexpectedly (${(err as Error).message}) — needs manual review; other intents' reconciliation is unaffected`;
    alert(`intent ${id}: ${reason}`);
    recordAlertReason(id, reason);
  }
}

export async function reconcileArbitrumLedger(
  deps: ArbitrumSettlementDeps,
  publicClient: PublicClient,
  /** Gate 5D-race-fix-2: `deps.runSolanaPayout` here is normally a stub that
   *  throws (see listener.ts's `reconciliationDeps`) — a single `deps`
   *  object is shared across every entry in this pass, but the REAL Solana
   *  payout is a function of that entry's OWN intentId/json/payoutDestination
   *  (decoded per-intent, exactly like triggerZKVerification does), which a
   *  single shared closure can't provide. Only the "collateral_posted, Solana
   *  leg never started" resume path below (added by Gate 5D-race-fix) needs a
   *  real Solana payout during reconciliation at all — confirmSettlement /
   *  slashSolver / postCollateral / readIntent all take intentId as an
   *  explicit argument and are safely shared as-is. When provided, this
   *  builds the correct per-intent runSolanaPayout for THAT resume call only;
   *  when omitted (e.g. a caller with no live Solana leg to run, or a test),
   *  that resume path alerts instead of ever touching deps.runSolanaPayout. */
  buildRunSolanaPayout?: (intentId: `0x${string}`, json: ProofOutputJson) => (zkProofHash: `0x${string}`) => Promise<SolanaPayoutResult>
): Promise<void> {
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

  // "collateral_posted" is a stable-looking intermediate stage (no tx in
  // flight), so it's not in getMidSequenceEntries() above. Two distinct ways
  // an entry can be stuck here:
  //  - Gate 5D-resume-fix: the process crashed between the Solana payout
  //    succeeding and confirmSettlement ever being attempted (isAlreadySettled
  //    true) — steps 1-3 are done, so this resumes directly at step 4
  //    (confirmSettlement) via confirmSettlementWithRetry.
  //  - Gate 5D-race-fix: the sequence never got past step 1 at all —
  //    Step 2's on-chain check either genuinely failed, or (the incident this
  //    fixes) failed on a stale RPC read immediately after postCollateral's
  //    OWN receipt was confirmed on a DIFFERENT node (see
  //    readIntentAfterPostCollateral), or the process crashed before Step 2
  //    ever ran. Previously this case was a dead end no reconciliation pass
  //    ever revisited — it just sat in "collateral_posted" forever. Now it
  //    resumes from Step 2 onward (resumeArbitrumSettlementFromCollateralPosted),
  //    which re-runs the SAME retry-tolerant on-chain check rather than
  //    blindly assuming success.
  // Either way, confirmSettlementWithRetry / the Step 2 check itself re-reads
  // on-chain state before acting, so a Slashed/Refunded/Settled intent is
  // still handled safely, not blindly re-sent. The alert path is kept only
  // for a genuine unhandled case: the proof JSON/bin this needs (json.expiry,
  // the zkProofHash) is missing or unreadable, which nothing here can safely
  // guess its way around.
  // Gate 5D-wire-periodic-to-arbitrum: this per-entry resume logic now lives
  // in resumeCollateralPostedIntent (above) — shared with the periodic
  // reconcileSettlingLedger pass (prover_pipeline.ts, wired via listener.ts),
  // which needs the exact same behavior for one specific intent the moment
  // its Solana signature lands mid-run, not just for every entry at boot.
  for (const { intentId } of getCollateralPostedEntries()) {
    await resumeCollateralPostedIntent(deps, (`0x${intentId}`) as `0x${string}`, buildRunSolanaPayout);
  }
}
