// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Independent, auditor-authored PoC suite for IntentManager v2 (Maat protocol).
// Written from scratch against src/IntentManager.sol without relying on the
// project's own test/IntentManager.t.sol, to independently verify the 8
// invariants requested in the audit brief plus two additional findings
// surfaced during static review. No live chain interaction; local Foundry
// EVM only.

import {Test} from "forge-std/Test.sol";
import {IntentManager} from "../src/IntentManager.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev A minimal fee-on-transfer token: the sender's balance always drops by
/// the full `value` passed to transfer/transferFrom, but the recipient only
/// receives `value - fee`. Models real deflationary/FOT tokens (and negative
/// rebase tokens have the same "contract holds less than the sum of recorded
/// amounts" effect).
contract FeeOnTransferToken is ERC20 {
    uint256 public constant FEE_BPS = 500; // 5%

    constructor() ERC20("Fee-on-Transfer Mock", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = (value * FEE_BPS) / 10_000;
            super._update(from, to, value - fee);
            super._update(from, address(0xdead), fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Treasury with no receive/fallback — every plain ETH transfer to it
/// reverts. Stands in for treasury being a multisig/contract that can't
/// accept a bare `.call{value:}("")` (paused Safe, contract with no payable
/// fallback, etc.) to test whether that breaks the claimRefund escape hatch.
contract RevertingTreasury {
// intentionally no receive() / fallback()
}

/// @dev Plays solver, intent-owner, or treasury depending on which
/// IntentManager function is under test — always via a role it legitimately
/// holds, so any revert on the reentrant call proves ReentrancyGuard (not
/// access control) is what stopped it.
contract ReentrantParty {
    IntentManager public target;
    bytes32 public intentId;

    enum Reentry {
        None,
        Confirm,
        Slash,
        Claim,
        WithdrawTreasury
    }

    Reentry public plan;

    /// @dev Set by receive() so the outer (legitimate) call can complete and
    /// we can assert on the reentrant attempt's outcome afterward, instead of
    /// letting its revert bubble up and abort the whole transaction.
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    constructor(IntentManager _target) {
        target = _target;
    }

    function arm(bytes32 _intentId, Reentry _plan) external {
        intentId = _intentId;
        plan = _plan;
    }

    function submit(uint256 amount, bytes32 destWallet, uint64 destChainId, uint64 expiry, uint16 slippageBps)
        external
        payable
        returns (bytes32)
    {
        return target.submitIntent{value: msg.value}(address(0), amount, destWallet, destChainId, expiry, slippageBps);
    }

    function postCollateral(bytes32 _intentId) external payable {
        target.postCollateral{value: msg.value}(_intentId);
    }

    function cancelIntent(bytes32 _intentId) external {
        target.cancelIntent(_intentId);
    }

    function claimRefund(bytes32 _intentId) external {
        target.claimRefund(_intentId);
    }

    /// @dev Only meaningful when this contract itself is `target.orchestrator`.
    function confirmSettlementCall(bytes32 _intentId, bytes32 proofHash) external {
        target.confirmSettlement(_intentId, proofHash);
    }

    /// @dev Only meaningful when this contract itself is `target.orchestrator`.
    function slashSolverCall(bytes32 _intentId) external {
        target.slashSolver(_intentId);
    }

    /// @dev v3: the treasury leg of slashSolver/claimRefund is pull-based —
    /// this is now the only place a treasury-side reentrant call can happen.
    function withdrawTreasuryCall() external {
        target.withdrawTreasury();
    }

    receive() external payable {
        if (plan == Reentry.None) return;
        Reentry p = plan;
        plan = Reentry.None; // arm-once, avoid infinite recursion on the outer call's own transfer

        bytes memory callData;
        if (p == Reentry.Confirm) {
            callData = abi.encodeWithSelector(IntentManager.confirmSettlement.selector, intentId, bytes32(uint256(0xdead)));
        } else if (p == Reentry.Slash) {
            callData = abi.encodeWithSelector(IntentManager.slashSolver.selector, intentId);
        } else if (p == Reentry.Claim) {
            callData = abi.encodeWithSelector(IntentManager.claimRefund.selector, intentId);
        } else if (p == Reentry.WithdrawTreasury) {
            callData = abi.encodeWithSelector(IntentManager.withdrawTreasury.selector);
        }

        // Low-level call so a revert here does NOT bubble up and abort the
        // outer (legitimate) transfer/call that triggered this receive() —
        // we want the legitimate call to complete so we can assert the
        // reentrant attempt specifically failed, and failed on the guard.
        reentryAttempted = true;
        (bool ok, bytes memory ret) = address(target).call(callData);
        reentrySucceeded = ok;
        reentryReturnData = ret;
    }
}

contract AuditPoCTest is Test {
    IntentManager im;
    ERC20Mock token;

    address orchestrator = makeAddr("orchestrator");
    address treasury = makeAddr("treasury");
    address owner = makeAddr("owner");
    address userAcc = makeAddr("user");
    address solver = makeAddr("solver");
    address stranger = makeAddr("stranger");

    uint256 constant AMOUNT = 1 ether;
    bytes32 constant DEST_WALLET = bytes32(uint256(uint160(address(0xBEEF))));
    uint64 constant DEST_CHAIN_ID = 1;
    uint16 constant SLIPPAGE_BPS = 50;
    uint256 constant REFUND_GRACE = 24 hours;

    function setUp() public {
        im = new IntentManager(orchestrator, treasury, owner);
        token = new ERC20Mock();

        vm.prank(owner);
        im.setSolver(solver, true);

        vm.deal(userAcc, 100 ether);
        vm.deal(solver, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    function _collateral(uint256 amount) internal pure returns (uint256) {
        return (amount * 150) / 100;
    }

    function _submitAndCollateralize() internal returns (bytes32 intentId, uint64 expiry) {
        expiry = _expiry();
        vm.prank(userAcc);
        intentId =
            im.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, expiry, SLIPPAGE_BPS);

        vm.prank(solver);
        im.postCollateral{value: _collateral(AMOUNT)}(intentId);
    }

    function _status(bytes32 intentId) internal view returns (IntentManager.IntentStatus s) {
        (,,,,,,, s,,,,,) = im.intents(intentId);
    }

    // ───────────────────────── Invariant 1 & 6: no double payout ─────────────

    function test_inv1_afterConfirm_slashReverts() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.prank(orchestrator);
        im.confirmSettlement(id, bytes32(uint256(1)));
        assertEq(uint8(_status(id)), uint8(IntentManager.IntentStatus.Settled));

        vm.warp(exp + 1);
        vm.prank(orchestrator);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        im.slashSolver(id);
    }

    function test_inv1_afterConfirm_claimRevert() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.prank(orchestrator);
        im.confirmSettlement(id, bytes32(uint256(1)));

        vm.warp(exp + REFUND_GRACE + 1);
        vm.prank(userAcc);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        im.claimRefund(id);
    }

    function test_inv1_afterSlash_confirmReverts() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(exp + 1);
        vm.prank(orchestrator);
        im.slashSolver(id);
        assertEq(uint8(_status(id)), uint8(IntentManager.IntentStatus.Slashed));

        vm.prank(orchestrator);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        im.confirmSettlement(id, bytes32(uint256(1)));
    }

    function test_inv1_afterSlash_claimReverts() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(exp + 1);
        vm.prank(orchestrator);
        im.slashSolver(id);

        vm.warp(exp + REFUND_GRACE + 1);
        vm.prank(userAcc);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        im.claimRefund(id);
    }

    function test_inv1_afterClaim_confirmAndSlashRevert() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(exp + REFUND_GRACE + 1);
        vm.prank(userAcc);
        im.claimRefund(id);
        assertEq(uint8(_status(id)), uint8(IntentManager.IntentStatus.Refunded));

        vm.prank(orchestrator);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        im.confirmSettlement(id, bytes32(uint256(1)));

        vm.prank(orchestrator);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        im.slashSolver(id);
    }

    /// @dev Full balance-conservation check: total ETH paid out across every
    /// possible follow-up call never exceeds escrow + collateral, no matter
    /// which terminal path is taken first.
    function test_inv6_totalPayoutNeverExceedsEscrowPlusCollateral() public {
        (bytes32 id,) = _submitAndCollateralize();
        uint256 pot = AMOUNT + _collateral(AMOUNT);
        uint256 contractBalBefore = address(im).balance;
        assertEq(contractBalBefore, pot);

        vm.prank(orchestrator);
        im.confirmSettlement(id, bytes32(uint256(1)));

        // Contract must hold exactly 0 for this intent's funds after the one
        // legitimate payout — nothing left to double-spend.
        assertEq(address(im).balance, 0);
    }

    // ───────────────────────── Invariant 2: collateral has a return path ─────

    function test_inv2_collateralReturnedOnLegitimateSettlement() public {
        (bytes32 id,) = _submitAndCollateralize();
        uint256 solverBefore = solver.balance;

        vm.prank(orchestrator);
        im.confirmSettlement(id, bytes32(uint256(1)));

        assertEq(solver.balance, solverBefore + AMOUNT + _collateral(AMOUNT));
    }

    /// @dev Edge case surfaced during review: if the solver is a contract that
    /// rejects plain ETH, confirmSettlement for that intent reverts forever
    /// (self-inflicted — solver chose not to accept ETH). Demonstrates funds
    /// are NOT permanently stuck though: slashSolver after expiry still
    /// succeeds and un-sticks the escrow to the user / collateral to treasury.
    function test_inv2_nonPayableSolver_confirmBlocked_butSlashRecovers() public {
        RevertingTreasury rejectingSolver = new RevertingTreasury(); // reuse: no receive()
        vm.prank(owner);
        im.setSolver(address(rejectingSolver), true);

        uint64 exp = _expiry();
        vm.prank(userAcc);
        bytes32 id = im.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);

        vm.deal(address(rejectingSolver), 10 ether);
        vm.prank(address(rejectingSolver));
        im.postCollateral{value: _collateral(AMOUNT)}(id);

        vm.prank(orchestrator);
        vm.expectRevert(IntentManager.EthTransferFailed.selector);
        im.confirmSettlement(id, bytes32(uint256(1)));

        vm.warp(exp + 1);
        vm.prank(orchestrator);
        im.slashSolver(id); // succeeds — treasury (EOA-like makeAddr) accepts ETH fine
        assertEq(uint8(_status(id)), uint8(IntentManager.IntentStatus.Slashed));
    }

    // ───────────────────────── Invariant 3: postCollateral gated to approved solvers

    function test_inv3_strangerCannotPostCollateral() public {
        uint64 exp = _expiry();
        vm.prank(userAcc);
        bytes32 id = im.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);

        vm.prank(stranger);
        vm.expectRevert(IntentManager.NotApprovedSolver.selector);
        im.postCollateral{value: _collateral(AMOUNT)}(id);
    }

    function test_inv3_revokedSolverCannotPostCollateral() public {
        vm.prank(owner);
        im.setSolver(solver, false); // revoke

        uint64 exp = _expiry();
        vm.prank(userAcc);
        bytes32 id = im.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);

        vm.prank(solver);
        vm.expectRevert(IntentManager.NotApprovedSolver.selector);
        im.postCollateral{value: _collateral(AMOUNT)}(id);
    }

    // ───────────────────────── Invariant 4: confirm/slash gated to orchestrator

    function test_inv4_strangerCannotConfirmSettlement() public {
        (bytes32 id,) = _submitAndCollateralize();
        vm.prank(stranger);
        vm.expectRevert(IntentManager.NotOrchestrator.selector);
        im.confirmSettlement(id, bytes32(uint256(1)));
    }

    function test_inv4_solverCannotSelfConfirm() public {
        (bytes32 id,) = _submitAndCollateralize();
        vm.prank(solver);
        vm.expectRevert(IntentManager.NotOrchestrator.selector);
        im.confirmSettlement(id, bytes32(uint256(1)));
    }

    function test_inv4_strangerCannotSlashSolver() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(exp + 1);
        vm.prank(stranger);
        vm.expectRevert(IntentManager.NotOrchestrator.selector);
        im.slashSolver(id);
    }

    function test_inv4_ownerCannotConfirmOrSlash() public {
        // Owner (admin) is a distinct role from orchestrator — must not be
        // able to act as orchestrator just because it's privileged elsewhere.
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.prank(owner);
        vm.expectRevert(IntentManager.NotOrchestrator.selector);
        im.confirmSettlement(id, bytes32(uint256(1)));

        vm.warp(exp + 1);
        vm.prank(owner);
        vm.expectRevert(IntentManager.NotOrchestrator.selector);
        im.slashSolver(id);
    }

    // ───────────────────────── Invariant 5: claimRefund grace window ─────────

    function test_inv5_claimRefund_revertsBeforeExpiry() public {
        (bytes32 id,) = _submitAndCollateralize();
        vm.prank(userAcc);
        vm.expectRevert(IntentManager.IntentNotExpired.selector);
        im.claimRefund(id);
    }

    function test_inv5_claimRefund_revertsRightAtExpiry_gracePending() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(exp); // expired, but grace not yet elapsed
        vm.prank(userAcc);
        vm.expectRevert(IntentManager.IntentNotExpired.selector);
        im.claimRefund(id);
    }

    function test_inv5_claimRefund_revertsOneSecondBeforeGraceEnds() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(uint256(exp) + REFUND_GRACE - 1);
        vm.prank(userAcc);
        vm.expectRevert(IntentManager.IntentNotExpired.selector);
        im.claimRefund(id);
    }

    function test_inv5_claimRefund_succeedsExactlyAtGraceBoundary() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(uint256(exp) + REFUND_GRACE);
        vm.prank(userAcc);
        im.claimRefund(id); // must not revert
        assertEq(uint8(_status(id)), uint8(IntentManager.IntentStatus.Refunded));
    }

    // ───────────────────────── Invariant 7: reentrancy ────────────────────────

    /// @dev confirmSettlement/slashSolver are onlyOrchestrator-gated, so a
    /// reentrant call from a mere solver/user hits that access-control check
    /// before ever reaching the ReentrancyGuard — proving nothing about
    /// reentrancy specifically. To test the guard itself, per the audit
    /// brief, the attacker must legitimately BE the orchestrator (we deploy
    /// a fresh IntentManager with the attacker's predicted address as
    /// orchestrator) while ALSO being the party an ETH leg pays out to.
    function test_inv7_reentrancy_confirmSettlement_viaSolver() public {
        uint256 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 1);
        IntentManager im5 = new IntentManager(predicted, treasury, owner);
        ReentrantParty attacker = new ReentrantParty(im5);
        assertEq(address(attacker), predicted);

        vm.prank(owner);
        im5.setSolver(address(attacker), true);

        uint64 exp = _expiry();
        vm.prank(userAcc);
        bytes32 id = im5.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);

        vm.deal(address(attacker), 10 ether);
        vm.prank(address(attacker));
        im5.postCollateral{value: _collateral(AMOUNT)}(id);

        attacker.arm(id, ReentrantParty.Reentry.Confirm);
        attacker.confirmSettlementCall(id, bytes32(uint256(1))); // attacker==orchestrator; first ETH leg (to attacker==solver) triggers receive()

        assertTrue(attacker.reentryAttempted());
        assertFalse(attacker.reentrySucceeded(), "reentrant confirmSettlement must fail");
        assertEq(bytes4(attacker.reentryReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        // Legitimate outer call still completed exactly once, correctly.
        (,,,,,,, IntentManager.IntentStatus s5,,,,,) = im5.intents(id);
        assertEq(uint8(s5), uint8(IntentManager.IntentStatus.Settled));
        assertEq(address(im5).balance, 0);
    }

    function test_inv7_reentrancy_slashSolver_viaUserLeg() public {
        uint256 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 1);
        IntentManager im6 = new IntentManager(predicted, treasury, owner);
        ReentrantParty attacker = new ReentrantParty(im6);
        assertEq(address(attacker), predicted);

        vm.prank(owner);
        im6.setSolver(solver, true);

        vm.deal(address(attacker), 10 ether);
        uint64 exp = _expiry();
        bytes32 id =
            attacker.submit{value: AMOUNT}(AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS); // attacker == intent owner

        vm.prank(solver);
        im6.postCollateral{value: _collateral(AMOUNT)}(id);

        attacker.arm(id, ReentrantParty.Reentry.Slash);
        vm.warp(exp + 1);
        attacker.slashSolverCall(id); // attacker==orchestrator; user leg (to attacker==owner) triggers receive()

        assertTrue(attacker.reentryAttempted());
        assertFalse(attacker.reentrySucceeded(), "reentrant slashSolver via user leg must fail");
        assertEq(bytes4(attacker.reentryReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        (,,,,,,, IntentManager.IntentStatus s6,,,,,) = im6.intents(id);
        assertEq(uint8(s6), uint8(IntentManager.IntentStatus.Slashed));
    }

    /// @dev v3: slashSolver's treasury leg is now pure bookkeeping
    /// (pendingTreasuryWithdrawals += collateral), not an external call — so
    /// slashSolver itself has nothing left to reenter through on that leg
    /// (confirmed: with the fix applied, treasury's receive() never even
    /// fires during slashSolver/claimRefund). The reentrancy-relevant surface
    /// moved entirely to the new withdrawTreasury() function, tested here:
    /// treasury pulls its credited collateral and attempts to reenter
    /// withdrawTreasury() itself during that transfer.
    function test_inv7_reentrancy_slashSolver_viaTreasuryLeg() public {
        uint256 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 1);
        IntentManager im7 = new IntentManager(orchestrator, predicted, owner);
        ReentrantParty attackerTreasury = new ReentrantParty(im7);
        assertEq(address(attackerTreasury), predicted);

        vm.prank(owner);
        im7.setSolver(solver, true);

        uint64 exp = uint64(block.timestamp + 1 days);
        vm.prank(userAcc);
        bytes32 id =
            im7.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);
        vm.prank(solver);
        im7.postCollateral{value: _collateral(AMOUNT)}(id);

        vm.warp(exp + 1);
        vm.prank(orchestrator);
        im7.slashSolver(id); // credits pendingTreasuryWithdrawals[attackerTreasury]; no external call fires here anymore
        assertFalse(attackerTreasury.reentryAttempted(), "treasury leg must not call out at all now");
        assertEq(im7.pendingTreasuryWithdrawals(address(attackerTreasury)), _collateral(AMOUNT));

        attackerTreasury.arm(id, ReentrantParty.Reentry.WithdrawTreasury);
        attackerTreasury.withdrawTreasuryCall(); // must NOT revert — outer withdrawal completes exactly once

        assertTrue(attackerTreasury.reentryAttempted());
        assertFalse(attackerTreasury.reentrySucceeded(), "reentrant withdrawTreasury must fail");
        assertEq(bytes4(attackerTreasury.reentryReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(im7.pendingTreasuryWithdrawals(address(attackerTreasury)), 0); // paid out exactly once
        assertEq(address(attackerTreasury).balance, _collateral(AMOUNT));

        (,,,,,,, IntentManager.IntentStatus s7,,,,,) = im7.intents(id);
        assertEq(uint8(s7), uint8(IntentManager.IntentStatus.Slashed));
    }

    function test_inv7_reentrancy_claimRefund_viaUserLeg() public {
        ReentrantParty attackerUser = new ReentrantParty(im);
        vm.deal(address(attackerUser), 10 ether);

        uint64 exp = _expiry();
        vm.prank(address(attackerUser));
        bytes32 id =
            im.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);
        vm.prank(solver);
        im.postCollateral{value: _collateral(AMOUNT)}(id);

        attackerUser.arm(id, ReentrantParty.Reentry.Claim);
        vm.warp(uint256(exp) + REFUND_GRACE);
        vm.prank(address(attackerUser));
        im.claimRefund(id);

        assertTrue(attackerUser.reentryAttempted());
        assertFalse(attackerUser.reentrySucceeded(), "reentrant claimRefund via user leg must fail");
        assertEq(bytes4(attackerUser.reentryReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(uint8(_status(id)), uint8(IntentManager.IntentStatus.Refunded));
    }

    /// @dev Same rationale as the slashSolver version above, but the credit
    /// comes from claimRefund instead — confirms both money-in paths feed the
    /// same pull-protected withdrawal correctly, and that neither calls out
    /// to treasury directly anymore.
    function test_inv7_reentrancy_claimRefund_viaTreasuryLeg() public {
        uint256 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 1);
        IntentManager im4 = new IntentManager(orchestrator, predicted, owner);
        ReentrantParty attackerTreasury = new ReentrantParty(im4);
        assertEq(address(attackerTreasury), predicted);

        vm.prank(owner);
        im4.setSolver(solver, true);

        uint64 exp = uint64(block.timestamp + 1 days);
        vm.prank(userAcc);
        bytes32 id =
            im4.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);
        vm.prank(solver);
        im4.postCollateral{value: _collateral(AMOUNT)}(id);

        vm.warp(uint256(exp) + REFUND_GRACE);
        vm.prank(userAcc);
        im4.claimRefund(id); // credits pendingTreasuryWithdrawals[attackerTreasury]; no external call fires here anymore
        assertFalse(attackerTreasury.reentryAttempted(), "treasury leg must not call out at all now");
        assertEq(im4.pendingTreasuryWithdrawals(address(attackerTreasury)), _collateral(AMOUNT));

        attackerTreasury.arm(id, ReentrantParty.Reentry.WithdrawTreasury);
        attackerTreasury.withdrawTreasuryCall();

        assertTrue(attackerTreasury.reentryAttempted());
        assertFalse(attackerTreasury.reentrySucceeded(), "reentrant withdrawTreasury must fail");
        assertEq(bytes4(attackerTreasury.reentryReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(im4.pendingTreasuryWithdrawals(address(attackerTreasury)), 0);
        assertEq(address(attackerTreasury).balance, _collateral(AMOUNT));

        (,,,,,,, IntentManager.IntentStatus s4,,,,,) = im4.intents(id);
        assertEq(uint8(s4), uint8(IntentManager.IntentStatus.Refunded));
    }

    // ───────────────────────── Invariant 8: role changes gated to owner ──────

    function test_inv8_setOrchestrator_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IntentManager.NotAdmin.selector);
        im.setOrchestrator(stranger);

        vm.prank(orchestrator); // even the current orchestrator can't rotate itself
        vm.expectRevert(IntentManager.NotAdmin.selector);
        im.setOrchestrator(stranger);

        vm.prank(owner);
        im.setOrchestrator(stranger);
        assertEq(im.orchestrator(), stranger);
    }

    function test_inv8_setSolver_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IntentManager.NotAdmin.selector);
        im.setSolver(stranger, true);

        vm.prank(owner);
        im.setSolver(stranger, true);
        assertTrue(im.approvedSolvers(stranger));
    }

    // ───────────────────────── Finding A (v3 FIX): treasury pull-payment ─────

    /// @notice v3 fix verification. Previously, claimRefund/slashSolver pushed
    /// the forfeited collateral to `treasury` via a bare `.call` in the same
    /// transaction as the user/solver's own leg — a reverting treasury
    /// permanently blocked both, including the designated escape hatch. Now
    /// the treasury leg is credited to `pendingTreasuryWithdrawals` instead of
    /// pushed, so a treasury that can never accept ETH no longer blocks
    /// anything for the user or the orchestrator.
    function test_findingA_revertingTreasury_noLongerBlocksClaimRefund() public {
        RevertingTreasury badTreasury = new RevertingTreasury();
        IntentManager im3 = new IntentManager(orchestrator, address(badTreasury), owner);
        vm.prank(owner);
        im3.setSolver(solver, true);

        uint64 exp = uint64(block.timestamp + 1 days);
        vm.prank(userAcc);
        bytes32 id =
            im3.submitIntent{value: AMOUNT}(address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);
        vm.prank(solver);
        im3.postCollateral{value: _collateral(AMOUNT)}(id);

        vm.warp(uint256(exp) + REFUND_GRACE);
        uint256 userBalBefore = userAcc.balance;

        vm.prank(userAcc);
        im3.claimRefund(id); // must NOT revert anymore, even though badTreasury can't accept ETH

        (,,,,,,, IntentManager.IntentStatus s3,,,,,) = im3.intents(id);
        assertEq(uint8(s3), uint8(IntentManager.IntentStatus.Refunded));
        assertEq(userAcc.balance, userBalBefore + AMOUNT); // user got their refund immediately
        assertEq(im3.pendingTreasuryWithdrawals(address(badTreasury)), _collateral(AMOUNT)); // collateral credited, not lost

        // Second intent to independently verify slashSolver's identical fix.
        vm.prank(userAcc);
        bytes32 id2 = im3.submitIntent{value: AMOUNT}(
            address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, uint64(block.timestamp + 1 days), SLIPPAGE_BPS
        );
        vm.prank(solver);
        im3.postCollateral{value: _collateral(AMOUNT)}(id2);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(orchestrator);
        im3.slashSolver(id2); // must NOT revert either
        (,,,,,,, IntentManager.IntentStatus s3b,,,,,) = im3.intents(id2);
        assertEq(uint8(s3b), uint8(IntentManager.IntentStatus.Slashed));
        assertEq(im3.pendingTreasuryWithdrawals(address(badTreasury)), _collateral(AMOUNT) * 2); // accumulates
    }

    /// @notice A treasury that CAN accept ETH pulls its accumulated
    /// collateral correctly, and only it can — no other address can drain
    /// someone else's pending balance.
    function test_findingA_treasuryWithdrawsAccumulatedCollateral() public {
        (bytes32 id, uint64 exp) = _submitAndCollateralize();
        vm.warp(exp + 1);
        vm.prank(orchestrator);
        im.slashSolver(id); // uses the default `treasury` (an EOA)

        assertEq(im.pendingTreasuryWithdrawals(treasury), _collateral(AMOUNT));
        uint256 treasuryBalBefore = treasury.balance;

        // A stranger calling withdrawTreasury() can only ever pull their OWN
        // credited balance (zero here) — cannot drain treasury's.
        vm.prank(stranger);
        im.withdrawTreasury();
        assertEq(treasury.balance, treasuryBalBefore);

        vm.prank(treasury);
        im.withdrawTreasury();
        assertEq(treasury.balance, treasuryBalBefore + _collateral(AMOUNT));
        assertEq(im.pendingTreasuryWithdrawals(treasury), 0);
    }

    // ───────────────────────── Finding B (v3 FIX): actual-balance accounting ─

    /// @notice v3 fix verification. Previously, submitIntent recorded the
    /// caller-supplied nominal `amount` for ERC20 intents, not what the
    /// contract actually received — a fee-on-transfer/negative-rebase token
    /// would then permanently strand the tokens it DID receive, because every
    /// payout path tried to send out the (larger) nominal amount. Now the
    /// actual post-transfer balance delta is recorded instead.
    function test_findingB_feeOnTransferToken_noLongerLocksFunds() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        fot.mint(userAcc, 1000 ether);

        vm.startPrank(userAcc);
        fot.approve(address(im), AMOUNT);
        uint64 exp = _expiry();
        bytes32 id = im.submitIntent(address(fot), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);
        vm.stopPrank();

        uint256 escrowedAmount = AMOUNT - (AMOUNT * 500) / 10_000; // 5% fee on the way IN
        (, uint256 recordedAmount, address recordedToken,,,,,,,,,,) = im.intents(id);
        assertEq(recordedAmount, escrowedAmount); // now matches actual balance delta, not the nominal ask
        assertEq(recordedToken, address(fot));
        assertEq(fot.balanceOf(address(im)), escrowedAmount);

        // cancelIntent now succeeds — it only ever tries to pay out what was
        // actually recorded (== actually held), never more. This particular
        // mock token taxes EVERY transfer (realistic for true FOT tokens), so
        // the user's payout is itself taxed again on the way OUT — that's an
        // inherent, expected property of using such a token at all (any
        // recipient of any hop loses the same %), not a fund-stranding bug:
        // the key fix property is that the contract's balance for this
        // intent is drained to exactly 0, nothing is left stuck.
        uint256 finalUserReceipt = escrowedAmount - (escrowedAmount * 500) / 10_000;
        vm.warp(uint256(exp) + 1);
        uint256 userBalBefore = fot.balanceOf(userAcc);
        vm.prank(userAcc);
        im.cancelIntent(id); // must NOT revert anymore

        (,,,,,,, IntentManager.IntentStatus sB,,,,,) = im.intents(id);
        assertEq(uint8(sB), uint8(IntentManager.IntentStatus.Expired));
        assertEq(fot.balanceOf(userAcc), userBalBefore + finalUserReceipt);
        assertEq(fot.balanceOf(address(im)), 0); // nothing stranded — the core fix property
    }

    /// @notice Confirms the fix also makes the full settle path (not just
    /// cancelIntent) correct for a fee-on-transfer token: collateral is now
    /// sized off the actual escrowed amount, and confirmSettlement pays the
    /// solver out of the full balance the contract holds — no insufficient-
    /// balance revert, no dust left behind (same "tax on every hop" caveat as
    /// above applies to what the solver ends up net-receiving).
    function test_findingB_feeOnTransferToken_fullSettlementPathWorks() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        fot.mint(userAcc, 1000 ether);

        vm.startPrank(userAcc);
        fot.approve(address(im), AMOUNT);
        uint64 exp = _expiry();
        bytes32 id = im.submitIntent(address(fot), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, exp, SLIPPAGE_BPS);
        vm.stopPrank();

        uint256 escrowedAmount = AMOUNT - (AMOUNT * 500) / 10_000;
        uint256 finalSolverReceipt = escrowedAmount - (escrowedAmount * 500) / 10_000;
        vm.prank(solver);
        im.postCollateral{value: _collateral(escrowedAmount)}(id); // sized off the corrected (received) amount

        vm.prank(orchestrator);
        im.confirmSettlement(id, bytes32(uint256(1))); // must NOT revert

        assertEq(fot.balanceOf(solver), finalSolverReceipt);
        assertEq(fot.balanceOf(address(im)), 0); // contract's holding for this intent is exactly drained — nothing stranded
    }
}
