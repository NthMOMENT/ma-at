# IntentManager v2 (Maat protocol) — Independent Security Audit

**Auditor:** Heist (glassofbeer.ai), independent session
**Date:** September 27, 2026
**Repo audited:** `NthMOMENT/ma-at` (read-only clone; no push/commit/PR made against it)
**Commit audited:** `bb3e7c0f7f2d0620f70e5117d2718ed3466d566c` (master, "IntentManager v2")
**File:** `contracts/evm/src/IntentManager.sol`
**Deployed:** `0xa3d4B948593334E55F0caC52DE406381e7052eAa`, Arbitrum Sepolia — confirmed live, unpaused, `intentNonce=5` at time of audit. Checked via read-only `cast call` only; no transactions were sent to it at any point.
**Live role addresses observed** (read-only): `treasury`, `owner`, and `orchestrator` were all plain EOAs at audit time.
**Testing:** Foundry, 100% local, in an isolated scratch clone. Nothing outside `contracts/evm/` was touched. No fix was applied to the live/canonical repo; no deploy occurred.

## Summary

All 8 requested invariants **held** under independent Foundry PoC testing. Two novel findings were identified and fixed in a local v3 diff (not deployed): a treasury-payment coupling that could break the protocol's own escape hatch, and a missing actual-balance check that could permanently strand fee-on-transfer/rebasing-token deposits. **Neither finding is currently exploitable against the live deployment** — both require conditions not present today (a non-EOA treasury; a fee-on-transfer token used as `tokenAddress`) — but both are real, working PoC-verified bugs that should be fixed before the protocol handles non-test funds or a treasury migration to a contract wallet.

## Phase 1 — Function-by-function findings

| Function | Access control | Reentrancy | State transition | CEI | Notes |
|---|---|---|---|---|---|
| `submitIntent` | public (by design) | `nonReentrant` ✓ | creates `Pending` | ✓ | fine |
| `postCollateral` | `approvedSolvers` only | `nonReentrant` ✓ | `Pending`→(solver set) | ✓ | fine |
| `confirmSettlement` | `onlyOrchestrator` | `nonReentrant` ✓ | `Pending`→`Settled` | ✓ | see Finding C |
| `slashSolver` | `onlyOrchestrator` | `nonReentrant` ✓ | `Pending`→`Slashed` | ✓ | see Finding A |
| `cancelIntent` | intent owner | `nonReentrant` ✓ | `Pending`→`Expired` | ✓ | fine |
| `claimRefund` | intent owner | `nonReentrant` ✓ | `Pending`→`Refunded` | ✓ | see Finding A |
| `pause`/`unpause` | `onlyAdmin` | n/a | n/a | n/a | fine |
| `setOrchestrator`/`setSolver` | `onlyAdmin` | n/a | n/a | n/a | fine |
| circuit breaker (`dailyVolumeLimit`) | `onlyAdmin` to change | n/a | n/a | n/a | see Informational D |

`ReentrancyGuard` is applied to every state-mutating, fund-moving external function, and OZ's guard uses a single shared lock, so it blocks reentrancy *across* functions, not just within one.

**Integer/overflow:** Solidity 0.8.24 checked arithmetic throughout; `(amount * 150) / 100` can only revert on overflow (unreachable at realistic supplies), not wrap. Integer-division truncation is at most 1 wei — immaterial.

## Phase 2 — Invariants (8/8 held)

Independent PoC suite (`test/Audit_PoC.t.sol`, written from scratch, not reusing the project's own tests) — 27 initial tests, later extended to 29 with fix-verification tests. Combined with the project's own 31 tests: **60/60 passing** on the final (v3-fixed) source.

| # | Invariant | Result |
|---|---|---|
| 1 | Escrow released twice for same intent | **HELD** — `status` is a one-way latch out of `Pending`, checked before every payout (CEI), reentrancy-guarded. |
| 2 | Solver collateral permanently lost on legitimate settlement | **HELD** — collateral returns atomically with settlement; edge case (non-payable solver) blocks only that solver's own confirm, `slashSolver` still recovers the funds after expiry. |
| 3 | `postCollateral` succeeds for a non-approved address | **HELD** — gated by `approvedSolvers`, including revoked solvers. |
| 4 | `confirmSettlement`/`slashSolver` callable by non-orchestrator | **HELD** — including the owner/admin itself. |
| 5 | `claimRefund` before `expiry + REFUND_GRACE` | **HELD** — boundary-tested at `expiry`, `expiry+GRACE-1`, and exactly `expiry+GRACE`. |
| 6 | Multiple payouts exceeding escrow+collateral | **HELD** — every ordered pair of (confirm, slash, claim): first succeeds, rest revert `IntentNotPending`; balance hits exactly 0. |
| 7 | Reentrancy on `confirmSettlement`/`slashSolver`'s transfers | **HELD** — see methodology note below. |
| 8 | Orchestrator/solver role changed by non-owner | **HELD** — including the current orchestrator trying to rotate itself. |

**Methodology note on invariant 7:** `confirmSettlement`/`slashSolver` are `onlyOrchestrator`-gated, so a reentrant call from a mere solver/user would hit access control before ever reaching `ReentrancyGuard`, proving nothing about reentrancy specifically. To test the guard itself, fresh `IntentManager` instances were deployed with the attacker contract's own predicted address set as `orchestrator` (and, in separate tests, as the intent owner or treasury), so the reentrant call passes every access check and is stopped by `ReentrancyGuardReentrantCall()` alone — confirmed via the exact returned selector in each test.

## Phase 3 — Findings

### Finding A — High (fixed in v3): `claimRefund`/`slashSolver` coupled the escape hatch to a mandatory treasury payment in the same transaction

`claimRefund` is documented as the deliberate escape hatch ("a pause must never trap user funds"). But pre-fix, it did the user's refund **and** the treasury's collateral-forfeiture in one atomic call — if the treasury payment ever failed (non-payable contract, reverting fallback, paused Safe), the **entire** `claimRefund` call reverted, rolling back the user's refund too. `slashSolver` had the identical coupling. Since `treasury` is `immutable`, there was no recovery path.

**Current live risk (at audit time):** not exploitable — `treasury` on the live deployment is a plain EOA. Becomes live risk the moment treasury custody moves to any contract wallet.

**Fix applied (v3, local only):** forfeited collateral is now credited to a `pendingTreasuryWithdrawals[treasury]` mapping instead of pushed via `.call`, and a new `withdrawTreasury()` function lets treasury pull it whenever it's able to. `withdrawTreasury()` is callable by anyone but only ever pays the caller their *own* credited balance — since only `treasury` is ever credited, it functions as treasury-only in practice with no access-control modifier needed.

### Finding B — High (fixed in v3): no allowlist on `submitIntent`'s `tokenAddress` — fee-on-transfer/rebasing tokens could permanently strand funds

`submitIntent` recorded the caller-supplied nominal `amount`, not what the contract actually received. For a fee-on-transfer or negative-rebase ERC20, the contract receives strictly less than `amount`; every later payout path then tried to send out the full nominal amount and reverted on insufficient balance — permanently stranding the tokens that *were* received, with no sweep/reconciliation function to recover them.

**Current live risk:** not exploitable today — no ERC20 intents observed live, and the risk only manifests for fee-on-transfer/rebasing tokens specifically.

**Fix applied (v3, local only):** `submitIntent` now measures the actual pre/post balance delta on the contract and records that as `intent.amount`, so every downstream payout only ever tries to send what was actually escrowed. (A true "fee on every transfer" token will still tax the *outgoing* leg too — that's inherent, unavoidable token behavior, not a fund-stranding bug; the fix's guarantee is that the contract's balance for that intent always drains to exactly zero, nothing is ever left stuck.)

### Finding C — Medium (not fixed, flagged only): ETH-denominated collateral against non-ETH-denominated intents is economically meaningless

`postCollateral` applies the 150% ratio to `intent.amount`'s raw token-unit count regardless of `tokenAddress`'s price/decimals — already flagged in the contract's own doc comments as a known v2 gap. Not fixed in this pass (out of the approved fix scope); should block a mainnet/real-funds deployment for ERC20 intents until an oracle-based valuation exists.

### Informational / Low
- `dailyVolume` never decrements on cancel/slash/refund — volume from incomplete intents can still exhaust the daily cap until the window rolls over.
- Collateral-ratio integer-division truncation: ≤1 wei, immaterial.
- Single, owner-rotatable orchestrator — expected centralization/trust assumption, not a code bug.
- Post-expiry race between `slashSolver` (orchestrator) and `claimRefund` (user, after grace): first lands wins cleanly, no double-spend, just a UX note.

## v3 fix diff (source)

```diff
diff --git a/contracts/evm/src/IntentManager.sol b/contracts/evm/src/IntentManager.sol
index 5aca647..ae9c0db 100644
--- a/contracts/evm/src/IntentManager.sol
+++ b/contracts/evm/src/IntentManager.sol
@@ -60,6 +60,13 @@ contract IntentManager is ReentrancyGuard, Pausable {
     /// postCollateral — replaces v1's "first caller with the right collateral wins".
     mapping(address => bool) public approvedSolvers;
 
+    /// @dev v3: forfeited solver collateral (slashSolver, claimRefund) is
+    /// credited here instead of pushed to `treasury` directly, so a treasury
+    /// that can't accept a bare ETH transfer (no receive(), reverting
+    /// fallback, paused multisig, ...) can never block the user/solver leg of
+    /// those calls — including claimRefund, the designated escape hatch.
+    mapping(address => uint256) public pendingTreasuryWithdrawals;
+
     uint256 public constant COLLATERAL_RATIO = 150;
 
     /// @dev v2: grace period after expiry before the intent owner can pull the
@@ -149,7 +156,14 @@ contract IntentManager is ReentrancyGuard, Pausable {
             if (msg.value != amount) revert IncorrectValue();
         } else {
             if (msg.value != 0) revert IncorrectValue();
+            // v3: fee-on-transfer / negative-rebase tokens deliver less than
+            // `amount` was asked for — record what was actually escrowed, not
+            // the nominal ask, so later payouts never try to send out more
+            // than this contract actually holds for this intent.
+            uint256 balBefore = IERC20(tokenAddress).balanceOf(address(this));
             IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);
+            amount = IERC20(tokenAddress).balanceOf(address(this)) - balBefore;
+            if (amount == 0) revert InvalidAmount();
         }
 
         if (block.timestamp > lastVolumeReset + VOLUME_WINDOW) {
@@ -256,9 +270,11 @@ contract IntentManager is ReentrancyGuard, Pausable {
 
         _releaseFunds(user, amount, intent.tokenAddress);
 
-        // Collateral is always native ETH (see postCollateral), independent of the intent's asset.
-        (bool okTreasury,) = payable(treasury).call{value: collateral}("");
-        if (!okTreasury) revert EthTransferFailed();
+        // Collateral is always native ETH (see postCollateral), independent of
+        // the intent's asset. v3: credited for pull-withdrawal rather than
+        // pushed, so a treasury that can't accept a bare ETH transfer can
+        // never block this call (see pendingTreasuryWithdrawals).
+        pendingTreasuryWithdrawals[treasury] += collateral;
 
         emit SolverSlashed(intentId, solver, collateral, treasury);
     }
@@ -299,12 +315,24 @@ contract IntentManager is ReentrancyGuard, Pausable {
 
         _releaseFunds(msg.sender, amount, intent.tokenAddress);
 
-        (bool okTreasury,) = payable(treasury).call{value: collateral}("");
-        if (!okTreasury) revert EthTransferFailed();
+        // v3: credited for pull-withdrawal — see slashSolver and
+        // pendingTreasuryWithdrawals. Critically, this means a broken
+        // treasury can never block the escape hatch itself.
+        pendingTreasuryWithdrawals[treasury] += collateral;
 
         emit IntentRefunded(intentId, msg.sender, amount, collateral);
     }
 
+    /// @notice Treasury pulls any collateral forfeited to it via slashSolver
+    /// or claimRefund. Pull-based so a broken/reverting treasury can never
+    /// block those calls (see pendingTreasuryWithdrawals).
+    function withdrawTreasury() external nonReentrant {
+        uint256 amount = pendingTreasuryWithdrawals[msg.sender];
+        pendingTreasuryWithdrawals[msg.sender] = 0;
+        (bool ok,) = payable(msg.sender).call{value: amount}("");
+        if (!ok) revert EthTransferFailed();
+    }
+
     /// @dev Releases an intent's escrowed `amount` — native ETH if tokenAddress is
     /// address(0), otherwise the ERC20 token at tokenAddress. Used by confirmSettlement,
     /// slashSolver, and cancelIntent; never for collateral, which is always native ETH.
```

Three tests in the project's own `test/IntentManager.t.sol` needed a one-line update each (`vm.prank(treasury); intentManager.withdrawTreasury();` before their balance assertions) to reflect the new pull-payment semantics — see `docs/audits/2026-09-27-IntentManager.t.sol.diff` note below if that file's diff is wanted too; not reproduced here since only `Audit_PoC.t.sol` was asked to be archived alongside this report.

## Status

- Fix implemented and verified locally: **yes**, both Finding A and Finding B.
- Deployed anywhere: **no**.
- Pushed/committed to `NthMOMENT/ma-at`: **no**, and never will be from this workspace — any fix must go back to NthMOMENT as a proposed diff for their own review, not as a direct commit/PR from this audit.
- Full combined test suite (project's 31 + this audit's 29): **60/60 passing** against the v3-fixed source.
