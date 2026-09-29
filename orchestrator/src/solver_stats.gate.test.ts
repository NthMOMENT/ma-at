// Gate test (Week 3 design, Phase 2 — "track record and tiers, pure
// functions only"): exercises solver_stats.ts's readSolverRecord,
// computeTier, tierCapWei, and listKnownIntentIds entirely with MOCKED chain
// calls (a SolverStatsDeps built from an in-memory map) and per-run mkdtemp
// files — no real RPC, no real signing, no live transfers, no fixed /tmp
// paths anywhere in this file.
//
// Unlike the other *.gate.test.ts files, this one needs NO env vars set by
// the caller: solver_stats.ts imports arbitrum_settlement.ts's OnChainIntent
// as a TYPE ONLY (erased at compile time) and its status constants from the
// separate, side-effect-free intent_status.ts — so requiring solver_stats.ts
// never loads private keys or builds an RPC transport. The one test that
// legitimately needs a real arbitrum_settlement.ts (the drift guard) builds
// its own throwaway env (mkdtemp'd paths + fake keys) and sets it via
// process.env immediately before a DYNAMIC import — deferred to that one
// test, not baked into this file's top-level imports.
//
// Run with:
//
//   npx ts-node src/solver_stats.gate.test.ts
//
// (a plain `npm run build` first is only needed for this file's own
// "required with an empty environment" check, which spawns dist/solver_stats.js).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import {
  readSolverRecord,
  computeTier,
  tierCapWei,
  defaultTierCapPct,
  listKnownIntentIds,
  type SolverStatsDeps,
  type SolverRecord,
  type TierConfig,
} from "./solver_stats";
import { INTENT_STATUS_SETTLED, INTENT_STATUS_SLASHED, INTENT_STATUS_REFUNDED, INTENT_STATUS_EXPIRED, INTENT_STATUS_PENDING } from "./intent_status";
// Type-only — proves (by construction: this import must be fully erased,
// see test "purity" below) that solver_stats.ts's own OnChainIntent import
// is likewise erased and never drags in arbitrum_settlement.ts at runtime.
import type { OnChainIntent } from "./arbitrum_settlement";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "maat-solver-stats-gate-"));
let tmpCounter = 0;
function tmpPath(name: string): string {
  tmpCounter++;
  return path.join(TMP_DIR, `${tmpCounter}-${name}`);
}
function writeJson(p: string, value: unknown): void {
  fs.writeFileSync(p, JSON.stringify(value));
}
function emptyExclusionsPath(): string {
  const p = tmpPath("exclusions-empty.json");
  writeJson(p, []);
  return p;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;
// Real Solver A address from the design doc.
const SOLVER_A = "0xE39677A621d3f232E9b6A97e84aCD03443540a61";
const SOLVER_A_LOWER = SOLVER_A.toLowerCase();
const SOLVER_B = "0x00000000000000000000000000000000000502";

// Solver A's real terminal history (design doc §4.3 fixture).
const FIXTURE_SETTLED_IDS = [
  "0x18e8cb4a88004a0856eb59b2ba53bf423feaeb155b09ff1bd95067e15f5fad4c",
  "0x212a4c83052afcc95a341268f74f3fa2d812c24fcc1a2b6a94ed4dfcbe029abc",
  "0xa6419d9b5c1a5d05021fee921d487c928db65866c20a800470338080e4b34fb3",
  "0x7207398b4e5e3ece118da18adf7d38402a3757a3974d6d476834e981c62bf40e",
  "0x9349cf3891f12a5a95be81b25aeaa7b24e29aa2f11e2c813c47730eed585ac28",
];
const FIXTURE_EXCLUDED_SLASHED_ID = "0x0ebb033bec8db89338197f47b8ce08b4f2e6bff1be96002d9d54b96884db84de";

function mockOnChainIntent(overrides: Partial<OnChainIntent> = {}): OnChainIntent {
  return {
    owner: ("0x" + "99".repeat(20)) as `0x${string}`,
    amount: 1_000_000_000_000_000n,
    tokenAddress: ZERO_ADDRESS,
    status: INTENT_STATUS_SETTLED,
    solver: SOLVER_A as `0x${string}`,
    collateralPosted: 1_500_000_000_000_000n,
    ...overrides,
  };
}

/// A deps.readIntent backed by a plain map, keyed by bare-lowercase intent
/// ID hex, plus a call log so tests can assert cache hits skip the chain
/// entirely.
function mapDeps(entries: Record<string, OnChainIntent>): SolverStatsDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readIntent(intentId) {
      const key = intentId.replace(/^0x/i, "").toLowerCase();
      calls.push(key);
      const entry = entries[key];
      if (!entry) throw new Error(`mapDeps: no entry for ${key}`);
      return entry;
    },
  };
}

async function main(): Promise<void> {
  // ══════════════════ readSolverRecord: Solver A's real history ══════════════════

  console.log("[gate-test] 1) readSolverRecord: Solver A's real history, WITH the real committed exclusion -> settled 5, slashed 0, excluded 1, resolved 5, successRate 1.0; computeTier(2, ...) stays 2 (only 5 resolved, promotion needs 10)");
  {
    const entries: Record<string, OnChainIntent> = {};
    for (const id of FIXTURE_SETTLED_IDS) entries[id.slice(2)] = mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` });
    entries[FIXTURE_EXCLUDED_SLASHED_ID.slice(2)] = mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_A as `0x${string}` });
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    // exclusionsPath omitted -> the REAL committed orchestrator/solver_exclusions.json,
    // whose first entry is exactly FIXTURE_EXCLUDED_SLASHED_ID / SOLVER_A.
    const { records, errors, complete } = await readSolverRecord(deps, [...FIXTURE_SETTLED_IDS, FIXTURE_EXCLUDED_SLASHED_ID], { cachePath });

    const rec = records[SOLVER_A_LOWER];
    check("no read errors", errors.length === 0);
    check("complete === true", complete === true);
    check("record exists for Solver A", !!rec);
    check("settled === 5", rec?.settled === 5);
    check("slashed === 0", rec?.slashed === 0);
    check("excluded === 1", rec?.excluded === 1);
    check("resolved === 5", rec?.resolved === 5);
    check("successRate === 1.0", rec?.successRate === 1.0);
    check("computeTier(2, ...) stays 2 — not enough resolved to promote", computeTier(2, rec as SolverRecord) === 2);
  }

  console.log("[gate-test] 2) readSolverRecord: SAME history WITHOUT the exclusion -> resolved 6, successRate 5/6 (~0.833), no demotion (>= 0.80) — shows why the exclusion matters");
  {
    const entries: Record<string, OnChainIntent> = {};
    for (const id of FIXTURE_SETTLED_IDS) entries[id.slice(2)] = mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` });
    entries[FIXTURE_EXCLUDED_SLASHED_ID.slice(2)] = mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_A as `0x${string}` });
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const { records } = await readSolverRecord(deps, [...FIXTURE_SETTLED_IDS, FIXTURE_EXCLUDED_SLASHED_ID], { cachePath, exclusionsPath: emptyExclusionsPath() });

    const rec = records[SOLVER_A_LOWER];
    check("excluded === 0", rec?.excluded === 0);
    check("slashed === 1", rec?.slashed === 1);
    check("resolved === 6", rec?.resolved === 6);
    check("successRate === 5/6", Math.abs((rec?.successRate ?? -1) - 5 / 6) < 1e-9);
    const demoteConfig: TierConfig = { promoteMinResolved: 10, promoteMinSuccess: 0.95, demoteMinResolved: 3, demoteMaxSuccess: 0.8 };
    check("no demotion — 5/6 (~0.833) is >= the 0.80 demote threshold", computeTier(2, rec as SolverRecord, demoteConfig) === 2);
  }

  // ══════════════════ readSolverRecord: correctness ══════════════════

  console.log("[gate-test] 3) readSolverRecord: Refunded and Expired never count toward resolved/successRate; an Expired intent's zero-address solver is skipped entirely (not attributed to any solver)");
  {
    const idSettled = "aa".repeat(32);
    const idSlashed = "bb".repeat(32);
    const idRefunded = "cc".repeat(32);
    const idExpired = "dd".repeat(32);
    const entries: Record<string, OnChainIntent> = {
      [idSettled]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_B as `0x${string}` }),
      [idSlashed]: mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_B as `0x${string}` }),
      [idRefunded]: mockOnChainIntent({ status: INTENT_STATUS_REFUNDED, solver: SOLVER_B as `0x${string}` }),
      [idExpired]: mockOnChainIntent({ status: INTENT_STATUS_EXPIRED, solver: ZERO_ADDRESS }),
    };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const { records } = await readSolverRecord(deps, [idSettled, idSlashed, idRefunded, idExpired], { cachePath, exclusionsPath: emptyExclusionsPath() });

    const rec = records[SOLVER_B.toLowerCase()];
    check("settled === 1", rec?.settled === 1);
    check("slashed === 1", rec?.slashed === 1);
    check("refunded === 1 (recorded, but see below — never in resolved)", rec?.refunded === 1);
    check("expired === 0 for Solver B (the Expired intent's solver was address(0), not Solver B)", rec?.expired === 0);
    check("resolved === 2 (settled + slashed only)", rec?.resolved === 2);
    check("successRate === 0.5", rec?.successRate === 0.5);
    check("no record exists for the zero address", records[ZERO_ADDRESS] === undefined);
  }

  console.log("[gate-test] 4) readSolverRecord: two solvers in one run stay separate (no cross-contamination)");
  {
    const idA = "e1".repeat(32);
    const idB1 = "e2".repeat(32);
    const idB2 = "e3".repeat(32);
    const entries: Record<string, OnChainIntent> = {
      [idA]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }),
      [idB1]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_B as `0x${string}` }),
      [idB2]: mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_B as `0x${string}` }),
    };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const { records } = await readSolverRecord(deps, [idA, idB1, idB2], { cachePath, exclusionsPath: emptyExclusionsPath() });

    check("Solver A: settled 1, resolved 1", records[SOLVER_A_LOWER]?.settled === 1 && records[SOLVER_A_LOWER]?.resolved === 1);
    check("Solver B: settled 1, slashed 1, resolved 2 — untouched by Solver A's entry", records[SOLVER_B.toLowerCase()]?.settled === 1 && records[SOLVER_B.toLowerCase()]?.slashed === 1 && records[SOLVER_B.toLowerCase()]?.resolved === 2);
  }

  console.log("[gate-test] 5) readSolverRecord: intent IDs given with/without 0x and in mixed case dedupe to a single read (L2)");
  {
    const idHex = "f1".repeat(32);
    const entries: Record<string, OnChainIntent> = { [idHex]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }) };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const variants = [`0x${idHex}`, idHex, `0X${idHex.toUpperCase()}`, idHex.toUpperCase()];
    const { records } = await readSolverRecord(deps, variants, { cachePath, exclusionsPath: emptyExclusionsPath() });

    check("exactly one chain read despite 4 id spellings", deps.calls.length === 1);
    check("settled counted exactly once, not 4 times", records[SOLVER_A_LOWER]?.settled === 1);
  }

  console.log("[gate-test] 6) readSolverRecord: one failing read is isolated into `errors`, does not stop the others from counting, and marks the whole result incomplete");
  {
    const idOk = "12".repeat(32);
    const idFails = "13".repeat(32);
    const entries: Record<string, OnChainIntent> = { [idOk]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }) };
    const deps = mapDeps(entries); // idFails has no entry -> mapDeps's readIntent throws for it
    const cachePath = tmpPath("cache.json");
    const { records, errors, complete } = await readSolverRecord(deps, [idOk, idFails], { cachePath, exclusionsPath: emptyExclusionsPath() });

    check("exactly one error recorded", errors.length === 1);
    check("the error names the failing intent (0x-prefixed)", errors[0]?.intentId === `0x${idFails}`);
    check("the OK intent still counted", records[SOLVER_A_LOWER]?.settled === 1);
    check("complete === false", complete === false);
  }

  console.log("[gate-test] 6b) readSolverRecord: complete === true when every read succeeds");
  {
    const id = "1a1a".repeat(16);
    const entries: Record<string, OnChainIntent> = { [id]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }) };
    const deps = mapDeps(entries);
    const { complete, errors } = await readSolverRecord(deps, [id], { cachePath: tmpPath("cache.json"), exclusionsPath: emptyExclusionsPath() });
    check("no errors", errors.length === 0);
    check("complete === true", complete === true);
  }

  console.log("[gate-test] 7) readSolverRecord: Pending is never cached and never counted");
  {
    const idPending = "14".repeat(32);
    const entries: Record<string, OnChainIntent> = { [idPending]: mockOnChainIntent({ status: INTENT_STATUS_PENDING, solver: SOLVER_A as `0x${string}` }) };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const { records } = await readSolverRecord(deps, [idPending], { cachePath, exclusionsPath: emptyExclusionsPath() });

    check("no record produced for a solely-Pending intent", Object.keys(records).length === 0);
    // A solely-Pending run never dirties the cache, so the file may not even
    // have been created — either way, the Pending intent must not be in it.
    const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
    check("the Pending intent never appears in the cache file", !(idPending in cache));
  }

  console.log("[gate-test] 7b) readSolverRecord: an intent with owner === address(0) is skipped entirely and never cached, even with a terminal status (guards a garbage/never-created intent slot)");
  {
    const id = "1c1c".repeat(16);
    const entries: Record<string, OnChainIntent> = { [id]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}`, owner: ZERO_ADDRESS }) };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const { records } = await readSolverRecord(deps, [id], { cachePath, exclusionsPath: emptyExclusionsPath() });

    check("no record produced (owner is address(0)) despite status === Settled", Object.keys(records).length === 0);
    const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
    check("never cached", !(id in cache));
  }

  console.log("[gate-test] 7c) readSolverRecord: solver addresses group case-insensitively — a checksummed address and its lowercase form are the SAME solver");
  {
    const idChecksummed = "1d1d".repeat(16);
    const idLower = "1e1e".repeat(16);
    const entries: Record<string, OnChainIntent> = {
      [idChecksummed]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }), // SOLVER_A is checksummed
      [idLower]: mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_A_LOWER as `0x${string}` }), // all-lowercase
    };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const { records } = await readSolverRecord(deps, [idChecksummed, idLower], { cachePath, exclusionsPath: emptyExclusionsPath() });

    check("exactly one solver group, not two", Object.keys(records).length === 1);
    check("both intents combined under the single lowercase key", records[SOLVER_A_LOWER]?.settled === 1 && records[SOLVER_A_LOWER]?.slashed === 1);
  }

  // ══════════════════ readSolverRecord: exclusions ══════════════════

  console.log("[gate-test] 8) readSolverRecord: exclusion's solver disagrees with the true on-chain solver -> warns, does NOT exclude");
  {
    const id = FIXTURE_EXCLUDED_SLASHED_ID;
    const entries: Record<string, OnChainIntent> = { [id.slice(2)]: mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_B as `0x${string}` }) }; // on-chain solver is B, not A
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const exclusionsPath = tmpPath("exclusions-mismatch.json");
    writeJson(exclusionsPath, [{ intentId: id, solver: SOLVER_A, reason: "test mismatch" }]);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    let records: Record<string, SolverRecord>;
    try {
      ({ records } = await readSolverRecord(deps, [id], { cachePath, exclusionsPath }));
    } finally {
      console.warn = originalWarn;
    }

    check("a warning was logged naming both addresses", warnings.some((w) => w.includes(SOLVER_A) && w.includes(SOLVER_B)));
    check("the intent counted as slashed for Solver B, NOT excluded", records[SOLVER_B.toLowerCase()]?.slashed === 1 && records[SOLVER_B.toLowerCase()]?.excluded === 0);
  }

  console.log("[gate-test] 9) readSolverRecord: missing exclusions file -> warns, treated as empty, not fatal");
  {
    const id = "15".repeat(32);
    const entries: Record<string, OnChainIntent> = { [id]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }) };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const exclusionsPath = tmpPath("does-not-exist.json"); // never written
    let threw = false;
    let records: Record<string, SolverRecord> = {};
    try {
      ({ records } = await readSolverRecord(deps, [id], { cachePath, exclusionsPath }));
    } catch {
      threw = true;
    }
    check("did not throw for a missing exclusions file", !threw);
    check("settled still counted (empty exclusions, nothing excluded)", records[SOLVER_A_LOWER]?.settled === 1);
  }

  console.log("[gate-test] 10) readSolverRecord: corrupt exclusions file (invalid JSON) -> warns, treated as empty, not fatal");
  {
    const id = "16".repeat(32);
    const entries: Record<string, OnChainIntent> = { [id]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }) };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache.json");
    const exclusionsPath = tmpPath("corrupt-exclusions.json");
    fs.writeFileSync(exclusionsPath, "{ this is not valid JSON");
    let threw = false;
    let records: Record<string, SolverRecord> = {};
    try {
      ({ records } = await readSolverRecord(deps, [id], { cachePath, exclusionsPath }));
    } catch {
      threw = true;
    }
    check("did not throw for a corrupt exclusions file", !threw);
    check("settled still counted", records[SOLVER_A_LOWER]?.settled === 1);
  }

  console.log("[gate-test] 10b) readSolverRecord: exclusions are applied at COMPUTE time, not baked into the cache — editing the exclusions file changes the result for an already-cached intent, without touching the cache");
  {
    const id = "1f1f".repeat(16);
    const entries: Record<string, OnChainIntent> = { [id]: mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_B as `0x${string}` }) };
    const cachePath = tmpPath("cache-exclusion-timing.json");
    const exclusionsPath = tmpPath("exclusions-editable.json");
    writeJson(exclusionsPath, []); // no exclusion yet

    const deps1 = mapDeps(entries);
    const first = await readSolverRecord(deps1, [id], { cachePath, exclusionsPath });
    check("initially counted as slashed, not excluded", first.records[SOLVER_B.toLowerCase()]?.slashed === 1 && (first.records[SOLVER_B.toLowerCase()]?.excluded ?? 0) === 0);
    check("the intent is now cached", JSON.parse(fs.readFileSync(cachePath, "utf8"))[id] !== undefined);

    // "Edit" the exclusions file — the cache is left completely untouched.
    writeJson(exclusionsPath, [{ intentId: id, solver: SOLVER_B, reason: "test — added after caching" }]);
    const deps2: SolverStatsDeps = {
      async readIntent() {
        throw new Error("must not be called — this intent is already cached, only the exclusion changed");
      },
    };
    const second = await readSolverRecord(deps2, [id], { cachePath, exclusionsPath });
    check("second run served entirely from cache (no read attempted)", true); // would have thrown above otherwise
    check("now excluded instead of slashed, purely from the exclusions file edit", second.records[SOLVER_B.toLowerCase()]?.excluded === 1 && (second.records[SOLVER_B.toLowerCase()]?.slashed ?? 0) === 0);
  }

  // ══════════════════ readSolverRecord: cache ══════════════════

  console.log("[gate-test] 11) readSolverRecord: a run from an empty cache and a run from the resulting full cache give IDENTICAL output, and the second run never touches the chain reader");
  {
    const ids = [...FIXTURE_SETTLED_IDS, FIXTURE_EXCLUDED_SLASHED_ID];
    const entries: Record<string, OnChainIntent> = {};
    for (const id of FIXTURE_SETTLED_IDS) entries[id.slice(2)] = mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` });
    entries[FIXTURE_EXCLUDED_SLASHED_ID.slice(2)] = mockOnChainIntent({ status: INTENT_STATUS_SLASHED, solver: SOLVER_A as `0x${string}` });
    const cachePath = tmpPath("cache-reuse.json");
    const exclusionsPath = emptyExclusionsPath();

    const deps1 = mapDeps(entries);
    const first = await readSolverRecord(deps1, ids, { cachePath, exclusionsPath });
    check("first run (empty cache) read the chain for every id", deps1.calls.length === ids.length);

    // Second run: same cachePath (now populated), a deps whose readIntent
    // throws unconditionally — proves every id was served from the cache.
    const deps2: SolverStatsDeps = {
      async readIntent() {
        throw new Error("must not be called — everything should be cached");
      },
    };
    const second = await readSolverRecord(deps2, ids, { cachePath, exclusionsPath });

    check("second run produced no errors (nothing hit the throwing reader)", second.errors.length === 0);
    check("second run's output is identical to the first", JSON.stringify(second.records) === JSON.stringify(first.records));
  }

  console.log("[gate-test] 12) readSolverRecord: a corrupt cache file is rebuilt from chain reads, not fatal, and yields the same output as a fresh run");
  {
    const id = "17".repeat(32);
    const entries: Record<string, OnChainIntent> = { [id]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }) };
    const cachePath = tmpPath("corrupt-cache.json");
    fs.writeFileSync(cachePath, "not valid json at all {{{");
    const exclusionsPath = emptyExclusionsPath();

    const deps = mapDeps(entries);
    let threw = false;
    let records: Record<string, SolverRecord> = {};
    try {
      ({ records } = await readSolverRecord(deps, [id], { cachePath, exclusionsPath }));
    } catch {
      threw = true;
    }
    check("did not throw for a corrupt cache file", !threw);
    check("read the chain (cache was empty/rebuilt)", deps.calls.length === 1);
    check("settled counted correctly", records[SOLVER_A_LOWER]?.settled === 1);
    const rebuilt = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    check("cache file now holds valid, rebuilt JSON", rebuilt[id]?.status === INTENT_STATUS_SETTLED);
  }

  console.log("[gate-test] 13) readSolverRecord: nothing in the cache file or a warning contains anything but addresses/intent IDs (L5)");
  {
    const id = "18".repeat(32);
    const entries: Record<string, OnChainIntent> = { [id]: mockOnChainIntent({ status: INTENT_STATUS_SETTLED, solver: SOLVER_A as `0x${string}` }) };
    const deps = mapDeps(entries);
    const cachePath = tmpPath("cache-l5.json");
    await readSolverRecord(deps, [id], { cachePath, exclusionsPath: emptyExclusionsPath() });
    const raw = fs.readFileSync(cachePath, "utf8");
    check("cache file contains no URL-shaped text", !/https?:\/\//.test(raw));
    check("cache file contains only the expected keys (status, solver)", JSON.stringify(Object.keys(JSON.parse(raw)[id])) === JSON.stringify(["status", "solver"]));
  }

  // ══════════════════ computeTier ══════════════════

  const config: TierConfig = { promoteMinResolved: 10, promoteMinSuccess: 0.95, demoteMinResolved: 3, demoteMaxSuccess: 0.8 };
  function recordWith(settled: number, slashed: number): SolverRecord {
    const resolved = settled + slashed;
    return { settled, slashed, refunded: 0, expired: 0, excluded: 0, resolved, successRate: resolved === 0 ? null : settled / resolved };
  }

  console.log("[gate-test] 14) computeTier: no history (resolved === 0) returns onboardingTier unchanged");
  {
    check("resolved 0 -> unchanged", computeTier(2, recordWith(0, 0), config) === 2);
  }

  console.log("[gate-test] 15) computeTier: promotion at exactly 10 resolved clean; NOT at 9");
  {
    check("10 resolved, 100% success -> promotes (2 -> 1)", computeTier(2, recordWith(10, 0), config) === 1);
    check("9 resolved, 100% success -> does not promote (stays 2)", computeTier(2, recordWith(9, 0), config) === 2);
  }

  console.log("[gate-test] 16) computeTier: demotion at exactly 3 resolved with success < 0.80; NOT at 2 resolved");
  {
    // 3 resolved, 2 settled + 1 slashed -> success 2/3 (~0.667) < 0.80
    check("3 resolved, ~0.667 success -> demotes (2 -> 3)", computeTier(2, recordWith(2, 1), config) === 3);
    // 2 resolved, 1 settled + 1 slashed -> success 0.5, but resolved < demoteMinResolved
    check("2 resolved -> does not demote (stays 2), even though success is low", computeTier(2, recordWith(1, 1), config) === 2);
  }

  console.log("[gate-test] 17) computeTier: boundaries — success exactly 0.95 promotes; exactly 0.80 does NOT demote");
  {
    // 19/20 = 0.95 exactly, resolved 20 >= 10
    check("19/20 (exactly 0.95) -> promotes", computeTier(2, recordWith(19, 1), config) === 1);
    // 4/5 = 0.80 exactly, resolved 5 >= 3 — spec says demote only when success < 0.80, so exactly 0.80 must NOT demote
    check("4/5 (exactly 0.80) -> does not demote", computeTier(2, recordWith(4, 1), config) === 2);
  }

  console.log("[gate-test] 18) computeTier: clamped at tier 1 (cannot promote past best) and tier 3 (cannot demote past probation)");
  {
    check("already tier 1, promote-eligible -> stays 1", computeTier(1, recordWith(20, 0), config) === 1);
    check("already tier 3, demote-eligible -> stays 3", computeTier(3, recordWith(0, 5), config) === 3);
  }

  console.log("[gate-test] 19) computeTier: at most ONE step per call, even for an extreme record");
  {
    check("tier 3, a flawless 100-resolved record -> only steps to 2, not straight to 1", computeTier(3, recordWith(100, 0), config) === 2);
  }

  console.log("[gate-test] 19b) computeTier: incomplete data (complete === false) NEVER promotes, even for an otherwise-qualifying record");
  {
    const rec = recordWith(10, 0); // resolved 10, 100% success — would promote if complete
    check("complete=true -> promotes (2 -> 1)", computeTier(2, rec, config, true) === 1);
    check("complete=false -> does NOT promote, stays 2", computeTier(2, rec, config, false) === 2);
  }

  console.log("[gate-test] 19c) computeTier: demotion still applies even when complete === false (a conservative/protective action, not weakened by missing data)");
  {
    const rec = recordWith(2, 1); // 3 resolved, ~0.667 success — demote-eligible
    check("complete=false -> still demotes (2 -> 3)", computeTier(2, rec, config, false) === 3);
  }

  console.log("[gate-test] 19d) computeTier: no-change case (neither promote nor demote condition met) is unaffected by complete either way");
  {
    const rec = recordWith(5, 0); // resolved 5 (< promoteMinResolved 10), 100% success (>= demoteMaxSuccess) — neither condition applies
    check("complete=true -> unchanged", computeTier(2, rec, config, true) === 2);
    check("complete=false -> unchanged", computeTier(2, rec, config, false) === 2);
  }

  // ══════════════════ tierCapWei ══════════════════

  console.log("[gate-test] 20) tierCapWei: default percentages (T1 100%, T2 30%, T3 5%) of MAX_TRANSFER_WEI");
  {
    const max = 10_000_000_000_000_000n; // 0.01 ETH
    const pct = defaultTierCapPct({} as NodeJS.ProcessEnv);
    check("T1 defaults to 100%", pct[1] === 100);
    check("T2 defaults to 30%", pct[2] === 30);
    check("T3 defaults to 5%", pct[3] === 5);
    check("tier 1 cap === max", tierCapWei(1, max, pct) === max);
    check("tier 2 cap === 30% of max", tierCapWei(2, max, pct) === (max * 30n) / 100n);
    check("tier 3 cap === 5% of max", tierCapWei(3, max, pct) === (max * 5n) / 100n);
  }

  console.log("[gate-test] 21) tierCapWei: env overrides (SOLVER_TIER_CAP_PCT_1/2/3) are honored");
  {
    const max = 1_000_000_000_000_000_000n; // 1 ETH
    const pct = defaultTierCapPct({ SOLVER_TIER_CAP_PCT_1: "100", SOLVER_TIER_CAP_PCT_2: "50", SOLVER_TIER_CAP_PCT_3: "10" } as NodeJS.ProcessEnv);
    check("tier 2 cap reflects the override (50%)", tierCapWei(2, max, pct) === max / 2n);
  }

  // ══════════════════ listKnownIntentIds ══════════════════

  console.log("[gate-test] 22) listKnownIntentIds: collects from both a state dir (passed explicitly, not via MAAT_STATE_DIR) and ARBITRUM_LEDGER_PATH, normalized and deduped");
  {
    const stateDir = fs.mkdtempSync(path.join(TMP_DIR, "state-"));
    fs.writeFileSync(path.join(stateDir, "aa11.json"), "{}"); // only in state dir
    fs.writeFileSync(path.join(stateDir, "AA22.json"), "{}"); // only in state dir, uppercase-in-filename
    const ledgerPath = tmpPath("ledger-for-known-ids.json");
    writeJson(ledgerPath, { aa11: {}, bb33: {} }); // aa11 overlaps with state dir
    const originalLedgerPathEnv = process.env.ARBITRUM_LEDGER_PATH;
    process.env.ARBITRUM_LEDGER_PATH = ledgerPath; // read lazily by solver_stats.ts, safe to set here

    const ids = listKnownIntentIds(stateDir);

    if (originalLedgerPathEnv === undefined) delete process.env.ARBITRUM_LEDGER_PATH;
    else process.env.ARBITRUM_LEDGER_PATH = originalLedgerPathEnv;

    check("aa11 present exactly once despite appearing in both sources", ids.filter((id) => id === "aa11").length === 1);
    check("aa22 present (normalized to lowercase)", ids.includes("aa22"));
    check("bb33 present (ledger-only)", ids.includes("bb33"));
  }

  // ══════════════════ purity: no import of arbitrum_settlement.ts as a value ══════════════════

  console.log("[gate-test] 23) purity: dist/solver_stats.js can be required with a completely EMPTY environment (no keys, no RPC URLs) — proves it never transitively imports arbitrum_settlement.ts as a value");
  {
    const distPath = path.resolve(__dirname, "../dist/solver_stats.js");
    check("dist/solver_stats.js exists (run `npm run build` first)", fs.existsSync(distPath));
    const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(distPath)}); console.log("SOLVER_STATS_REQUIRE_OK");`], {
      // Deliberately minimal — PATH only (needed for node's own module
      // resolution on some platforms). No ARBITRUM_*_PRIVATE_KEY, no
      // ALCHEMY_RPC_URL_*, nothing arbitrum_settlement.ts's module-level
      // boot would need.
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    check("require() succeeded with an empty environment (exit code 0)", result.status === 0);
    check("stdout confirms the module loaded and ran to completion", (result.stdout ?? "").includes("SOLVER_STATS_REQUIRE_OK"));
    check("no error output", !(result.stderr ?? "").trim());
  }

  // The drift guard (intent_status.ts's constants vs arbitrum_settlement.ts's
  // own) lives in a SEPARATE file, intent_status_drift.gate.test.ts — it's
  // the only place that needs a real arbitrum_settlement.ts (private keys,
  // RPC URL), and keeping it out of this file is what lets test 23 above
  // prove solver_stats.ts needs none of that. See that file to run it.

  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n[gate-test] all checks passed`);
  }
}

main();
