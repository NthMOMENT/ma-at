// Week 3 design (solver credit scoring), Phase 2: pure track-record and tier
// functions. Nothing here is wired into runArbitrumSettlementSequence or the
// ledger (arbitrum_settlement.ts / arbitrum_ledger.ts) — this module only
// READS intent IDs from where they already live (state files, the Arbitrum
// ledger) and re-reads intents(id) fresh through an injected chain reader
// that reuses arbitrum_settlement.ts's OnChainIntent SHAPE (type-only import
// — erased, no runtime dependency) and its status constants' VALUES (via the
// separate, side-effect-free intent_status.ts, not arbitrum_settlement.ts
// itself). This module never imports arbitrum_settlement.ts as a value, so
// it can be required with an empty environment — no private keys, no RPC
// URLs — see the "required with an empty environment" gate test. Phase 3
// will call into this module; it does not call into Phase 3.
//
// L1: a TERMINAL on-chain status (Settled/Slashed/Refunded/Expired) never
// changes once reached — unlike Pending, which is why it's safe to cache and
// Pending is never cached. L2: intent IDs appear with and without a 0x
// prefix (and in mixed case) in different files — every ID is normalized to
// bare lowercase hex before comparison, dedup, or use as a cache/lookup key.
// L3/L6: one intent's failed chain read never aborts the others — it's
// recorded in `errors` and simply not counted this run. L4: every env var
// this module reads is read lazily, inside a function, never at module load
// time (dotenv may not have run yet). L5: nothing written here (cache,
// warnings, errors) ever carries anything but addresses and intent IDs.
import * as fs from "fs";
import * as path from "path";
import { STATE_DIR } from "./intent_state";
import { INTENT_STATUS_SETTLED, INTENT_STATUS_SLASHED, INTENT_STATUS_REFUNDED, INTENT_STATUS_EXPIRED } from "./intent_status";
// Type-only — erased at compile time, so this never triggers a runtime
// require() of arbitrum_settlement.ts (which loads private keys and builds
// the RPC transport at module load). Verified by this module's own
// "required with an empty environment" gate test.
import type { OnChainIntent } from "./arbitrum_settlement";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function keyOf(intentId: string): string {
  return intentId.replace(/^0x/i, "").toLowerCase();
}

// ─── Known intent IDs (state files + Arbitrum ledger) ───────────────────────

function arbitrumLedgerPath(): string {
  return process.env.ARBITRUM_LEDGER_PATH || path.resolve(__dirname, "../arbitrum_settled_intents.json");
}

function listArbitrumLedgerIntentIds(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(arbitrumLedgerPath(), "utf8")) as Record<string, unknown>;
    return Object.keys(raw);
  } catch {
    return []; // missing/corrupt — the other source still contributes (L6)
  }
}

function listStateFileIntentIds(stateDir: string): string[] {
  try {
    return fs
      .readdirSync(stateDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/// Every intent ID this orchestrator knows about, normalized (bare lowercase
/// hex, no 0x) and deduped — the same ID can appear in both sources, and
/// with/without a 0x prefix (L2). `stateDir` defaults to intent_state.ts's
/// STATE_DIR but is overridable (mainly for tests) — same injectable-path
/// discipline as readSolverRecord's cachePath/exclusionsPath.
export function listKnownIntentIds(stateDir: string = STATE_DIR): string[] {
  const ids = new Set<string>();
  for (const id of listStateFileIntentIds(stateDir)) ids.add(keyOf(id));
  for (const id of listArbitrumLedgerIntentIds()) ids.add(keyOf(id));
  return [...ids];
}

// ─── Terminal-intent cache (gitignored, rebuildable from chain reads) ───────
// Keyed by bare lowercase intent ID hex. Only ever holds TERMINAL statuses —
// Pending is never written here (L1). Atomic write (temp file + rename,
// same pattern as intent_state.ts's writeStateFile) so a crash mid-write
// never leaves a corrupt cache file behind.

interface CachedTerminalIntent {
  status: number;
  solver: string; // lowercased
}

type TerminalCache = Record<string, CachedTerminalIntent>;

function defaultCachePath(): string {
  return process.env.SOLVER_STATS_CACHE_PATH || path.resolve(__dirname, "../solver_stats_cache.json");
}

function loadCache(cachePath: string): TerminalCache {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      console.warn(`[SOLVER-STATS] WARNING: ${cachePath} is not a valid cache object — rebuilding from chain reads`);
      return {};
    }
    return raw as TerminalCache;
  } catch {
    return {}; // missing or corrupt — never a crash (L6), always rebuildable
  }
}

function saveCache(cachePath: string, cache: TerminalCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, cachePath);
  } catch (err) {
    console.warn(`[SOLVER-STATS] WARNING: failed to persist ${cachePath}: ${(err as Error).message} — next run will re-read from chain`);
  }
}

// ─── Exclusions (orchestrator/solver_exclusions.json, committed) ───────────
// §3.6: an excluded intent counts as neither settled nor slashed — only in
// the `excluded` count. If the on-chain solver disagrees with the entry's
// solver, this is logged as a warning (naming both addresses) and the entry
// is NOT applied — never silently excluded (or included) on a stale/wrong
// solver match.

export interface SolverExclusionEntry {
  intentId: string;
  solver: string;
  reason: string;
}

function defaultExclusionsPath(): string {
  // Not committed under this name in .env.example (the file itself IS
  // committed at a fixed path) — overridable only so tests can point at a
  // fixture without touching the real committed file.
  return process.env.SOLVER_EXCLUSIONS_PATH || path.resolve(__dirname, "../solver_exclusions.json");
}

function loadExclusions(exclusionsPath: string): SolverExclusionEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(exclusionsPath, "utf8"));
    if (!Array.isArray(raw)) {
      console.warn(`[SOLVER-STATS] WARNING: ${exclusionsPath} is not an array — treating exclusions as empty`);
      return [];
    }
    return raw as SolverExclusionEntry[];
  } catch (err) {
    console.warn(`[SOLVER-STATS] WARNING: failed to read/parse ${exclusionsPath} (${(err as Error).message}) — treating exclusions as empty`);
    return [];
  }
}

// ─── readSolverRecord ────────────────────────────────────────────────────────

export interface SolverStatsDeps {
  /** Same shape as ArbitrumSettlementDeps.readIntent — a fresh on-chain read,
   *  never a cached one. Reused deliberately; this module does not invent a
   *  second chain reader. */
  readIntent(intentId: `0x${string}`): Promise<OnChainIntent>;
}

export interface SolverRecord {
  settled: number;
  slashed: number;
  refunded: number;
  expired: number;
  excluded: number;
  /** settled + slashed, AFTER exclusions. */
  resolved: number;
  /** settled / resolved, or null when resolved === 0. */
  successRate: number | null;
}

export interface ReadSolverRecordError {
  intentId: string;
  error: string;
}

export interface ReadSolverRecordResult {
  /** Keyed by lowercased solver address. */
  records: Record<string, SolverRecord>;
  errors: ReadSolverRecordError[];
  /** False if any intent's chain read failed this run (errors.length > 0) —
   *  the data behind every record here is then a strict subset of the truth,
   *  never an overcount. computeTier uses this to refuse to PROMOTE off an
   *  incomplete picture, while still allowing a demotion (a conservative,
   *  protective action) through. */
  complete: boolean;
}

export interface ReadSolverRecordOptions {
  /** Overrides SOLVER_STATS_CACHE_PATH / the default path — mainly for tests. */
  cachePath?: string;
  /** Overrides SOLVER_EXCLUSIONS_PATH / the default path — mainly for tests. */
  exclusionsPath?: string;
}

function isTerminalStatus(status: number): boolean {
  return status === INTENT_STATUS_SETTLED || status === INTENT_STATUS_SLASHED || status === INTENT_STATUS_REFUNDED || status === INTENT_STATUS_EXPIRED;
}

function emptyRecordAccumulator(): { settled: number; slashed: number; refunded: number; expired: number; excluded: number } {
  return { settled: 0, slashed: 0, refunded: 0, expired: 0, excluded: 0 };
}

/// For each given intent ID (deduped, normalized per L2), reads intents(id)
/// fresh — via the cache when a terminal result was already cached, via
/// deps.readIntent otherwise — and groups the terminal ones by solver.
/// Pending intents are ignored entirely and never cached (L1). A failed read
/// for one intent is isolated into `errors` and simply not counted this run
/// (L3/L6) — it never aborts the rest.
export async function readSolverRecord(deps: SolverStatsDeps, intentIds: string[], options: ReadSolverRecordOptions = {}): Promise<ReadSolverRecordResult> {
  const cachePath = options.cachePath ?? defaultCachePath();
  const exclusionsPath = options.exclusionsPath ?? defaultExclusionsPath();

  const cache = loadCache(cachePath);
  const exclusions = loadExclusions(exclusionsPath);
  const normalizedIds = [...new Set(intentIds.map(keyOf))];

  const accumulators = new Map<string, ReturnType<typeof emptyRecordAccumulator>>();
  const errors: ReadSolverRecordError[] = [];
  let cacheDirty = false;

  for (const idHex of normalizedIds) {
    let cached = cache[idHex];
    if (!cached) {
      let onChain: OnChainIntent;
      try {
        onChain = await deps.readIntent((`0x${idHex}`) as `0x${string}`);
      } catch (err) {
        errors.push({ intentId: `0x${idHex}`, error: (err as Error).message });
        continue;
      }
      if (!isTerminalStatus(onChain.status)) {
        continue; // Pending — never counted, never cached
      }
      if (onChain.owner.toLowerCase() === ZERO_ADDRESS) {
        // A genuinely-created intent always has a real owner (submitIntent
        // requires one). owner === address(0) means this slot was never
        // written — a bad/garbage/never-created intent ID — not a real
        // terminal intent, regardless of what `status` happens to read as.
        // Skip entirely and never cache it, so a future run re-checks fresh
        // rather than trusting a one-off anomaly forever.
        continue;
      }
      cached = { status: onChain.status, solver: onChain.solver.toLowerCase() };
      cache[idHex] = cached;
      cacheDirty = true;
    }

    if (cached.solver === ZERO_ADDRESS) continue; // Expired intents have no solver — skip entirely

    const exclusion = exclusions.find((e) => keyOf(e.intentId) === idHex);
    let excluded = false;
    if (exclusion) {
      if (exclusion.solver.toLowerCase() === cached.solver) {
        excluded = true;
      } else {
        console.warn(
          `[SOLVER-STATS] WARNING: exclusion entry for intent 0x${idHex} names solver ${exclusion.solver}, but the on-chain solver is ${cached.solver} — NOT excluding`
        );
      }
    }

    const acc = accumulators.get(cached.solver) ?? emptyRecordAccumulator();
    if (excluded) {
      acc.excluded++;
    } else if (cached.status === INTENT_STATUS_SETTLED) {
      acc.settled++;
    } else if (cached.status === INTENT_STATUS_SLASHED) {
      acc.slashed++;
    } else if (cached.status === INTENT_STATUS_REFUNDED) {
      acc.refunded++;
    } else if (cached.status === INTENT_STATUS_EXPIRED) {
      acc.expired++;
    }
    accumulators.set(cached.solver, acc);
  }

  if (cacheDirty) {
    saveCache(cachePath, cache);
  }

  const records: Record<string, SolverRecord> = {};
  for (const [solver, acc] of accumulators) {
    const resolved = acc.settled + acc.slashed;
    records[solver] = {
      settled: acc.settled,
      slashed: acc.slashed,
      refunded: acc.refunded,
      expired: acc.expired,
      excluded: acc.excluded,
      resolved,
      successRate: resolved === 0 ? null : acc.settled / resolved,
    };
  }

  return { records, errors, complete: errors.length === 0 };
}

// ─── computeTier ──────────────────────────────────────────────────────────
// §3.9 defaults. Tiers are 1 (best) .. 3 (probation). At most one step per
// call, clamped to 1..3. No history windows in v1 — every terminal intent
// ever seen counts, forever; a known limitation, not a bug.

export interface TierConfig {
  promoteMinResolved: number;
  promoteMinSuccess: number;
  demoteMinResolved: number;
  demoteMaxSuccess: number;
}

/// Reads config lazily (L4) — only evaluated when no explicit config is
/// passed to computeTier, so computeTier itself stays a pure function of its
/// three arguments whenever a caller supplies its own config (as every test
/// here does).
export function defaultTierConfig(env: NodeJS.ProcessEnv = process.env): TierConfig {
  return {
    promoteMinResolved: Number(env.SOLVER_PROMOTE_MIN_RESOLVED ?? 10),
    promoteMinSuccess: Number(env.SOLVER_PROMOTE_MIN_SUCCESS ?? 0.95),
    demoteMinResolved: Number(env.SOLVER_DEMOTE_MIN_RESOLVED ?? 3),
    demoteMaxSuccess: Number(env.SOLVER_DEMOTE_MAX_SUCCESS ?? 0.8),
  };
}

/// `complete` (default true, matching ReadSolverRecordResult.complete for a
/// run with no failed reads) gates PROMOTION only: a record built from an
/// incomplete run (some intent read failed and was silently dropped, per L3)
/// must never be trusted enough to promote a solver — the true resolved
/// count/successRate could be different once every read succeeds. Demotion
/// and no-change are unaffected: demoting on the data actually in hand is
/// conservative/protective, not something incompleteness makes less safe.
export function computeTier(onboardingTier: number, record: SolverRecord, config: TierConfig = defaultTierConfig(), complete: boolean = true): number {
  if (record.resolved === 0 || record.successRate === null) return onboardingTier;

  let tier = onboardingTier;
  if (complete && record.resolved >= config.promoteMinResolved && record.successRate >= config.promoteMinSuccess) {
    tier -= 1;
  } else if (record.resolved >= config.demoteMinResolved && record.successRate < config.demoteMaxSuccess) {
    tier += 1;
  }
  return Math.min(3, Math.max(1, tier));
}

// ─── tierCapWei ───────────────────────────────────────────────────────────
// Not used anywhere yet — Phase 3 wires this into routing. §3.9 defaults:
// T1 100%, T2 30%, T3 5% of MAX_TRANSFER_WEI.

export interface TierCapPct {
  1: number;
  2: number;
  3: number;
}

export function defaultTierCapPct(env: NodeJS.ProcessEnv = process.env): TierCapPct {
  return {
    1: Number(env.SOLVER_TIER_CAP_PCT_1 ?? 100),
    2: Number(env.SOLVER_TIER_CAP_PCT_2 ?? 30),
    3: Number(env.SOLVER_TIER_CAP_PCT_3 ?? 5),
  };
}

export function tierCapWei(tier: 1 | 2 | 3, maxTransferWei: bigint, capPct: TierCapPct = defaultTierCapPct()): bigint {
  const pct = capPct[tier];
  return (maxTransferWei * BigInt(Math.round(pct))) / 100n;
}
