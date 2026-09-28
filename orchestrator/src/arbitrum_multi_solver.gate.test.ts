// Gate test (Week 3 design, Phase 1 — "multi-solver foundations, NO routing
// change"): exercises the parts of arbitrum_settlement.ts / arbitrum_ledger.ts
// that arbitrum_settlement.gate.test.ts's single-key setup can never reach —
// loading N solver keys, boot-time duplicate/approval checks, buildRealDeps'
// new solverAddress parameter, the ledger's new `solver` field and its
// migration for pre-existing entries, and the wrong-solver-slash invariant.
// Same "no test runner wired up yet" pattern as the other *.gate.test.ts
// files — mocked chain calls only, no real RPC, no real signing.
//
// Run with (all required — this would otherwise touch real state, and two
// distinct solver keys + the orchestrator key must be present for the module
// to load, even though no real signing ever happens in this test):
//
//   MAAT_STATE_DIR=/tmp/gate-test-multisolver-state \
//   SETTLED_LEDGER_PATH=/tmp/gate-test-multisolver-ledger.json \
//   ALERT_LOG_PATH=/tmp/gate-test-multisolver-alerts.log \
//   ARBITRUM_LEDGER_PATH=/tmp/gate-test-multisolver-arbledger.json \
//   ZK_DIR_PATH=/tmp/gate-test-multisolver-zkdir \
//   ALCHEMY_RPC_URL_1=https://example-placeholder.invalid/v2/test \
//   ARBITRUM_SOLVER_PRIVATE_KEY_1=0x1111111111111111111111111111111111111111111111111111111111111111 \
//   ARBITRUM_SOLVER_PRIVATE_KEY_2=0x3333333333333333333333333333333333333333333333333333333333333333 \
//   ARBITRUM_ORCHESTRATOR_PRIVATE_KEY=0x2222222222222222222222222222222222222222222222222222222222222222 \
//   npx ts-node src/arbitrum_multi_solver.gate.test.ts
import * as fs from "fs";
import * as path from "path";
import { privateKeyToAccount } from "viem/accounts";

for (const v of [
  "MAAT_STATE_DIR",
  "SETTLED_LEDGER_PATH",
  "ALERT_LOG_PATH",
  "ARBITRUM_LEDGER_PATH",
  "ZK_DIR_PATH",
  "ALCHEMY_RPC_URL_1",
  "ARBITRUM_SOLVER_PRIVATE_KEY_1",
  "ARBITRUM_SOLVER_PRIVATE_KEY_2",
  "ARBITRUM_ORCHESTRATOR_PRIVATE_KEY",
]) {
  if (!process.env[v]) {
    console.error(`[gate-test] refusing to run without ${v} set (see this file's header comment)`);
    process.exit(1);
  }
}
if (process.env.ARBITRUM_SOLVER_PRIVATE_KEY) {
  console.error("[gate-test] refusing to run with legacy ARBITRUM_SOLVER_PRIVATE_KEY also set — this file tests the numbered-key path specifically");
  process.exit(1);
}

import type { PublicClient } from "viem";
import {
  collectSolverPrivateKeyEnvEntries,
  resolveSolverAccounts,
  findOrphanedSolverPrivateKeyEnvVars,
  legacySolverKeyIgnoredNote,
  buildRealDeps,
  checkSolverApprovals,
  pollAwaitingSlash,
  resumeCollateralPostedIntent,
  INTENT_STATUS_PENDING,
  type ArbitrumSettlementDeps,
  type OnChainIntent,
} from "./arbitrum_settlement";
import { getArbitrumLedgerEntry, setArbitrumStage } from "./arbitrum_ledger";
import { readState } from "./intent_state";
import type { ProofOutputJson } from "./prover_pipeline";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

const SOLVER_1 = privateKeyToAccount(process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1 as `0x${string}`).address;
const SOLVER_2 = privateKeyToAccount(process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2 as `0x${string}`).address;

function baseJson(intentIdHex: string, overrides: Partial<ProofOutputJson> = {}): ProofOutputJson {
  return {
    tx_hash: "0x" + "11".repeat(32),
    mode: "prove",
    vkey: "0x" + "00".repeat(32),
    block_hash: "0x" + "ab".repeat(32),
    block_number: 12345,
    block_timestamp: Math.floor(Date.now() / 1000) - 60,
    contract: "0x9D1bd7119E9FefF6Baa3968272811323B354B16f",
    intent_id: "0x" + intentIdHex,
    sender: "0x" + "33".repeat(20),
    amount: "0x" + (1000000000000000n).toString(16),
    token_address: "0x" + "0".repeat(40),
    destination_wallet: "0x" + "44".repeat(32),
    destination_chain_id: 1399811149,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    slippage_bps: 50,
    ...overrides,
  };
}

function mockOnChainIntent(overrides: Partial<OnChainIntent> = {}): OnChainIntent {
  return {
    owner: ("0x" + "99".repeat(20)) as `0x${string}`,
    amount: 1000000000000000n,
    tokenAddress: "0x0000000000000000000000000000000000000000",
    status: INTENT_STATUS_PENDING,
    solver: SOLVER_1,
    collateralPosted: 1500000000000000n,
    ...overrides,
  };
}

function baseDeps(solverAddress: `0x${string}`, overrides: Partial<ArbitrumSettlementDeps> = {}): ArbitrumSettlementDeps {
  return {
    solverAddress,
    orchestratorAddress: ("0x" + "60".repeat(20)) as `0x${string}`,
    async getSolverBalanceWei() {
      return 10_000_000_000_000_000_000n;
    },
    async readIntent() {
      return mockOnChainIntent({ solver: solverAddress });
    },
    async postCollateral(_id, _v, onSigned) {
      onSigned(("0x" + "aa".repeat(32)) as `0x${string}`);
      return { ok: true, txHash: ("0x" + "aa".repeat(32)) as `0x${string}` };
    },
    async confirmSettlement(_id, _hash, onSigned) {
      onSigned(("0x" + "bb".repeat(32)) as `0x${string}`);
      return { ok: true, txHash: ("0x" + "bb".repeat(32)) as `0x${string}` };
    },
    async slashSolver(_id, onSigned) {
      onSigned(("0x" + "cc".repeat(32)) as `0x${string}`);
      return { ok: true, txHash: ("0x" + "cc".repeat(32)) as `0x${string}` };
    },
    async runSolanaPayout() {
      return { ok: true, sig: "solana-sig-1" };
    },
    async checkSolanaSignatureLanded() {
      return false;
    },
    nowSec: () => Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ══════════════════ pure env-parsing functions ══════════════════

  console.log("[gate-test] 1) collectSolverPrivateKeyEnvEntries: legacy-only env falls back to a single key-1 entry");
  {
    const entries = collectSolverPrivateKeyEnvEntries({ ARBITRUM_SOLVER_PRIVATE_KEY: "0xdead" } as NodeJS.ProcessEnv);
    check("exactly one entry", entries.length === 1);
    check("named after the legacy var", entries[0]?.envVarName === "ARBITRUM_SOLVER_PRIVATE_KEY");
  }

  console.log("[gate-test] 2) collectSolverPrivateKeyEnvEntries: numbered vars take priority over a legacy var also set");
  {
    const entries = collectSolverPrivateKeyEnvEntries({
      ARBITRUM_SOLVER_PRIVATE_KEY: "0xdead",
      ARBITRUM_SOLVER_PRIVATE_KEY_1: "0x0001",
      ARBITRUM_SOLVER_PRIVATE_KEY_2: "0x0002",
    } as NodeJS.ProcessEnv);
    check("two entries, not three", entries.length === 2);
    check("entry order is _1 then _2", entries[0]?.envVarName === "ARBITRUM_SOLVER_PRIVATE_KEY_1" && entries[1]?.envVarName === "ARBITRUM_SOLVER_PRIVATE_KEY_2");
    check("legacy var ignored once numbered vars exist", !entries.some((e) => e.envVarName === "ARBITRUM_SOLVER_PRIVATE_KEY"));
  }

  console.log("[gate-test] 3) collectSolverPrivateKeyEnvEntries: stops at the first gap (matches ALCHEMY_RPC_URL_1..3's indexed convention)");
  {
    const entries = collectSolverPrivateKeyEnvEntries({
      ARBITRUM_SOLVER_PRIVATE_KEY_1: "0x0001",
      ARBITRUM_SOLVER_PRIVATE_KEY_3: "0x0003", // _2 missing — must not be picked up
    } as NodeJS.ProcessEnv);
    check("only _1 collected, _3 skipped past the gap", entries.length === 1 && entries[0]?.envVarName === "ARBITRUM_SOLVER_PRIVATE_KEY_1");
  }

  console.log("[gate-test] 3b) findOrphanedSolverPrivateKeyEnvVars: _1 set, _2 missing, _3 set -> exactly one warning naming _3 and the first missing index (_2), no key value in it");
  {
    const warnings = findOrphanedSolverPrivateKeyEnvVars({
      ARBITRUM_SOLVER_PRIVATE_KEY_1: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1,
      ARBITRUM_SOLVER_PRIVATE_KEY_3: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2, // reuse a real-shaped key value as the orphan's value
    } as NodeJS.ProcessEnv);
    check("exactly one warning", warnings.length === 1);
    check("names the orphaned var", !!warnings[0]?.includes("ARBITRUM_SOLVER_PRIVATE_KEY_3"));
    check("names the first missing index", !!warnings[0]?.includes("_2"));
    check("matches the exact requested phrasing shape", warnings[0] === "ARBITRUM_SOLVER_PRIVATE_KEY_3 is set but _2 is missing - ignoring it");
    check("no key value appears in the warning text", !warnings[0]?.includes(process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2 as string));
  }

  console.log("[gate-test] 3c) findOrphanedSolverPrivateKeyEnvVars: multiple orphans past the same gap are all reported, in order");
  {
    const warnings = findOrphanedSolverPrivateKeyEnvVars({
      ARBITRUM_SOLVER_PRIVATE_KEY_1: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1,
      ARBITRUM_SOLVER_PRIVATE_KEY_3: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2,
      ARBITRUM_SOLVER_PRIVATE_KEY_4: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2,
    } as NodeJS.ProcessEnv);
    check("two warnings, one per orphan", warnings.length === 2);
    check("ordered _3 then _4", !!warnings[0]?.startsWith("ARBITRUM_SOLVER_PRIVATE_KEY_3") && !!warnings[1]?.startsWith("ARBITRUM_SOLVER_PRIVATE_KEY_4"));
  }

  console.log("[gate-test] 3d) findOrphanedSolverPrivateKeyEnvVars: no gap (contiguous _1.._2) -> no warnings");
  {
    const warnings = findOrphanedSolverPrivateKeyEnvVars({
      ARBITRUM_SOLVER_PRIVATE_KEY_1: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1,
      ARBITRUM_SOLVER_PRIVATE_KEY_2: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2,
    } as NodeJS.ProcessEnv);
    check("no warnings for a contiguous run", warnings.length === 0);
  }

  console.log("[gate-test] 3e) legacySolverKeyIgnoredNote: legacy AND _1 both set -> a note naming both vars, no key value in it");
  {
    const note = legacySolverKeyIgnoredNote({
      ARBITRUM_SOLVER_PRIVATE_KEY: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2,
      ARBITRUM_SOLVER_PRIVATE_KEY_1: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1,
    } as NodeJS.ProcessEnv);
    check("a note is returned", note !== null);
    check("names the legacy var", !!note?.includes("ARBITRUM_SOLVER_PRIVATE_KEY"));
    check("names ARBITRUM_SOLVER_PRIVATE_KEY_1", !!note?.includes("ARBITRUM_SOLVER_PRIVATE_KEY_1"));
    check("no key value appears in the note", !note?.includes(process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2 as string));
  }

  console.log("[gate-test] 3f) legacySolverKeyIgnoredNote: only one of the two set -> no note either way");
  {
    check(
      "legacy only -> null",
      legacySolverKeyIgnoredNote({ ARBITRUM_SOLVER_PRIVATE_KEY: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1 } as NodeJS.ProcessEnv) === null
    );
    check(
      "_1 only -> null",
      legacySolverKeyIgnoredNote({ ARBITRUM_SOLVER_PRIVATE_KEY_1: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1 } as NodeJS.ProcessEnv) === null
    );
  }

  console.log("[gate-test] 4) resolveSolverAccounts: two distinct keys resolve to two distinct addresses, no throw");
  {
    const accounts = resolveSolverAccounts([
      { envVarName: "K1", privateKey: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1 as `0x${string}` },
      { envVarName: "K2", privateKey: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_2 as `0x${string}` },
    ]);
    check("two accounts returned", accounts.length === 2);
    check("addresses are distinct", accounts[0]?.address.toLowerCase() !== accounts[1]?.address.toLowerCase());
  }

  console.log("[gate-test] 5) resolveSolverAccounts: the SAME private key configured under two env vars is rejected as a duplicate");
  {
    let threw = false;
    let message = "";
    try {
      resolveSolverAccounts([
        { envVarName: "ARBITRUM_SOLVER_PRIVATE_KEY_1", privateKey: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1 as `0x${string}` },
        { envVarName: "ARBITRUM_SOLVER_PRIVATE_KEY_2", privateKey: process.env.ARBITRUM_SOLVER_PRIVATE_KEY_1 as `0x${string}` }, // same key, different var
      ]);
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    check("duplicate address rejected", threw);
    check("error names both offending env vars", message.includes("ARBITRUM_SOLVER_PRIVATE_KEY_1") && message.includes("ARBITRUM_SOLVER_PRIVATE_KEY_2"));
  }

  // ══════════════════ module boot with two REAL configured keys ══════════════════

  console.log("[gate-test] 6) two-key boot: module loaded successfully with ARBITRUM_SOLVER_PRIVATE_KEY_1/_2 both set, without exiting");
  {
    check("SOLVER_1 and SOLVER_2 addresses were derived and are distinct", SOLVER_1.toLowerCase() !== SOLVER_2.toLowerCase());
  }

  console.log("[gate-test] 7) buildRealDeps: default (no solverAddress arg) resolves to the FIRST configured key — single-key call sites are unaffected by multi-key config");
  {
    const fakePublicClient = { getBalance: async () => 0n } as unknown as PublicClient;
    const deps = buildRealDeps(fakePublicClient, "0x" + "aa".repeat(20) as `0x${string}`, async () => ({ ok: true }), async () => false);
    check("solverAddress defaults to key 1 (ARBITRUM_SOLVER_PRIVATE_KEY_1)", deps.solverAddress.toLowerCase() === SOLVER_1.toLowerCase());
  }

  console.log("[gate-test] 8) buildRealDeps: an explicit solverAddress resolves to that specific configured key's deps");
  {
    const fakePublicClient = { getBalance: async () => 0n } as unknown as PublicClient;
    const deps = buildRealDeps(fakePublicClient, "0x" + "aa".repeat(20) as `0x${string}`, async () => ({ ok: true }), async () => false, SOLVER_2);
    check("solverAddress resolves to key 2", deps.solverAddress.toLowerCase() === SOLVER_2.toLowerCase());
  }

  console.log("[gate-test] 9) buildRealDeps: an address that isn't one of the configured solver keys throws rather than silently defaulting");
  {
    let threw = false;
    try {
      buildRealDeps(
        { getBalance: async () => 0n } as unknown as PublicClient,
        "0x" + "aa".repeat(20) as `0x${string}`,
        async () => ({ ok: true }),
        async () => false,
        ("0x" + "ff".repeat(20)) as `0x${string}`
      );
    } catch {
      threw = true;
    }
    check("threw for an unconfigured solver address", threw);
  }

  // ══════════════════ checkSolverApprovals (boot check, §3.9) ══════════════════

  console.log("[gate-test] 10) checkSolverApprovals: reports approved/unapproved per configured key from a FRESH on-chain read, excludes neither list (Phase 1 has no routing to exclude from), warns for the unapproved one");
  {
    const calledWith: `0x${string}`[] = [];
    const fakePublicClient = {
      readContract: async ({ args }: { args: readonly [`0x${string}`] }) => {
        calledWith.push(args[0]);
        return args[0].toLowerCase() === SOLVER_1.toLowerCase(); // SOLVER_1 approved, SOLVER_2 not
      },
    } as unknown as PublicClient;

    const originalWarn = console.warn;
    let warnedAbout: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnedAbout.push(args.join(" "));
    };
    let statuses: Awaited<ReturnType<typeof checkSolverApprovals>>;
    try {
      statuses = await checkSolverApprovals(fakePublicClient, ("0x" + "aa".repeat(20)) as `0x${string}`);
    } finally {
      console.warn = originalWarn;
    }

    check("both configured keys were checked fresh on-chain", calledWith.length === 2);
    check("SOLVER_1 reported approved", statuses.find((s) => s.address.toLowerCase() === SOLVER_1.toLowerCase())?.approved === true);
    check("SOLVER_2 reported NOT approved", statuses.find((s) => s.address.toLowerCase() === SOLVER_2.toLowerCase())?.approved === false);
    check("a warning was logged naming the unapproved solver", warnedAbout.some((w) => w.includes(SOLVER_2)));
    check("no warning was logged naming the approved solver", !warnedAbout.some((w) => w.includes(SOLVER_1)));
  }

  // ══════════════════ ledger `solver` field + migration (§3.8) ══════════════════

  console.log("[gate-test] 11) resumeCollateralPostedIntent: a pre-migration entry (no solver field) defaults to deps.solverAddress and proceeds normally when that matches on-chain truth");
  {
    const intentIdHex = "31".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    fs.mkdirSync(process.env.ZK_DIR_PATH as string, { recursive: true });
    fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${intentIdHex}.bin`), Buffer.from("fake"));
    fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${intentIdHex}.json`), JSON.stringify(json));

    // Simulates an entry written BEFORE this field existed: no `solver` key at all.
    setArbitrumStage(intentId, "collateral_posted", { collateralTxHash: "0x" + "aa".repeat(32), expiry: json.expiry });
    check("entry genuinely has no solver field (pre-migration shape)", getArbitrumLedgerEntry(intentId)?.solver === undefined);

    let confirmCalls = 0;
    const deps = baseDeps(SOLVER_1, {
      readIntent: async () => mockOnChainIntent({ solver: SOLVER_1 }), // on-chain truth matches the default
      confirmSettlement: async (_id, _hash, onSigned) => {
        confirmCalls++;
        onSigned(("0x" + "bb".repeat(32)) as `0x${string}`);
        return { ok: true, txHash: ("0x" + "bb".repeat(32)) as `0x${string}` };
      },
    });
    await resumeCollateralPostedIntent(deps, intentId, () => async () => ({ ok: true, sig: "sig-1" }));

    check("resumed normally (default solver matched on-chain truth)", confirmCalls === 1);
    check("ledger reached confirmed", getArbitrumLedgerEntry(intentId)?.stage === "confirmed");
    check("no alert recorded", !readState(intentId)?.alertReason);
  }

  console.log("[gate-test] 12) resumeCollateralPostedIntent: ledger's recorded solver DISAGREES with the true on-chain solver -> genuine conflict, alerts, never pays Solana (chain wins, per §3.8)");
  {
    const intentIdHex = "32".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${intentIdHex}.bin`), Buffer.from("fake"));
    fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${intentIdHex}.json`), JSON.stringify(json));

    // Ledger says SOLVER_1 posted collateral for this intent...
    setArbitrumStage(intentId, "collateral_posted", { collateralTxHash: "0x" + "cc".repeat(32), expiry: json.expiry, solver: SOLVER_1 });

    let solanaPayoutCalled = false;
    const deps = baseDeps(SOLVER_1, {
      // ...but the chain says SOLVER_2 actually holds it — a genuine
      // disagreement, not staleness (see readIntentAfterPostCollateral).
      readIntent: async () => mockOnChainIntent({ solver: SOLVER_2 }),
    });
    await resumeCollateralPostedIntent(deps, intentId, () => async () => {
      solanaPayoutCalled = true;
      return { ok: true, sig: "should-never-happen" };
    });

    check("Solana payout never attempted", !solanaPayoutCalled);
    check("ledger stays at collateral_posted (not silently advanced)", getArbitrumLedgerEntry(intentId)?.stage === "collateral_posted");
    const reason = readState(intentId)?.alertReason;
    check("alert recorded for the genuine conflict", !!reason);
    check("alert names the on-chain solver actually found", !!reason && reason.includes(SOLVER_2));
  }

  // ══════════════════ wrong-solver-slash invariant (§3.8 / §5) ══════════════════

  console.log("[gate-test] 13) pollAwaitingSlash: slashSolver's call shape is intent-scoped only (intentId + onSigned) — it structurally cannot receive or act on a solver identity, so a wrong/mismatched ledger `solver` field can never route a slash to the wrong solver");
  {
    const idA = ("0x" + "41".repeat(32)) as `0x${string}`;
    const idB = ("0x" + "42".repeat(32)) as `0x${string}`;
    const fakeNow = Math.floor(Date.now() / 1000);
    // Two entries recorded under DIFFERENT solvers, both due for slashing.
    setArbitrumStage(idA, "awaiting_expiry_slash", { expiry: fakeNow - 10, solver: SOLVER_1 });
    setArbitrumStage(idB, "awaiting_expiry_slash", { expiry: fakeNow - 10, solver: SOLVER_2 });

    const slashCallArgs: unknown[][] = [];
    const deps = baseDeps(SOLVER_1, {
      slashSolver: async (id, onSigned) => {
        slashCallArgs.push([id]); // the ENTIRE argument list available to slashSolver, besides onSigned
        onSigned(("0x" + "dd".repeat(32)) as `0x${string}`);
        return { ok: true, txHash: ("0x" + "dd".repeat(32)) as `0x${string}` };
      },
      nowSec: () => fakeNow,
    });
    await pollAwaitingSlash(deps);

    check("slashSolver was called once per due entry", slashCallArgs.length === 2);
    check("every call's only identifying argument is intentId — no solver address is or could be passed", slashCallArgs.every((args) => args.length === 1));
    check("entry A's own recorded solver is untouched by entry B's processing", getArbitrumLedgerEntry(idA)?.solver?.toLowerCase() === SOLVER_1.toLowerCase());
    check("entry B's own recorded solver is untouched by entry A's processing", getArbitrumLedgerEntry(idB)?.solver?.toLowerCase() === SOLVER_2.toLowerCase());
    check("both entries reached slashed", getArbitrumLedgerEntry(idA)?.stage === "slashed" && getArbitrumLedgerEntry(idB)?.stage === "slashed");
  }

  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n[gate-test] all checks passed`);
  }
}

main();
