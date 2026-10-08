// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IntentManager} from "../src/IntentManager.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Tests for the three v3 changes in IntentManager:
//   1. submitIntent records what a fee-on-transfer token actually delivered
//      (balBefore/balAfter), not the nominal amount;
//   2. forfeited collateral is credited to pendingTreasuryWithdrawals and
//      pulled via withdrawTreasury, instead of pushed to the treasury;
//   3. so a treasury that can't accept ETH never blocks slashSolver or
//      claimRefund (the escape hatch).

/// @dev Takes `feeBps` of every transferFrom (sent to FEE_SINK), delivering
/// less than asked. 10_000 bps = 100% fee: the recipient receives nothing.
/// Plain transfer (used for payouts) is fee-free.
contract FeeOnTransferTokenMock is ERC20 {
    address public constant FEE_SINK = address(0xFEE);
    uint256 public immutable feeBps;

    constructor(uint256 _feeBps) ERC20("Fee-on-transfer Mock", "FEE-M") {
        feeBps = _feeBps;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, _msgSender(), value);
        uint256 fee = (value * feeBps) / 10_000;
        if (fee > 0) _transfer(from, FEE_SINK, fee);
        _transfer(from, to, value - fee);
        return true;
    }
}

/// @dev A treasury that can never receive ETH (no-receive multisig, paused
/// contract, ...). It can still call withdrawTreasury as msg.sender.
contract RevertingTreasury {
    IntentManager public target;

    function setTarget(IntentManager _target) external {
        target = _target;
    }

    function withdraw() external {
        target.withdrawTreasury();
    }

    receive() external payable {
        revert("treasury rejects ETH");
    }
}

/// @dev A treasury that re-enters withdrawTreasury from receive(). With
/// `swallow` set it catches the re-entry's failure so the outer call can
/// complete; without it the re-entry's revert bubbles up.
contract ReentrantTreasury {
    IntentManager public target;
    bool public swallow;
    bool public reenter;
    bool public reentryFailed;
    uint256 public receiveCount;
    uint256 public totalReceived;

    function setTarget(IntentManager _target, bool _swallow) external {
        target = _target;
        swallow = _swallow;
    }

    function withdraw() external {
        reenter = true;
        target.withdrawTreasury();
    }

    receive() external payable {
        receiveCount += 1;
        totalReceived += msg.value;
        if (reenter) {
            reenter = false;
            if (swallow) {
                try target.withdrawTreasury() {}
                catch {
                    reentryFailed = true;
                }
            } else {
                target.withdrawTreasury();
            }
        }
    }
}

contract IntentManagerV3Test is Test {
    IntentManager intentManager;

    address orchestrator = makeAddr("orchestrator");
    address treasury = makeAddr("treasury");
    address owner = makeAddr("owner");
    address user = makeAddr("user");
    address solver = makeAddr("solver");
    address stranger = makeAddr("stranger");

    uint256 constant AMOUNT = 1 ether;
    bytes32 constant DEST_WALLET = bytes32(uint256(uint160(address(0xBEEF))));
    uint64 constant DEST_CHAIN_ID = 1399811149;
    uint16 constant SLIPPAGE_BPS = 50;

    function setUp() public {
        intentManager = _deploy(treasury);
        vm.deal(user, 100 ether);
        vm.deal(solver, 100 ether);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    function _deploy(address _treasury) internal returns (IntentManager m) {
        m = new IntentManager(orchestrator, _treasury, owner);
        vm.prank(owner);
        m.setSolver(solver, true);
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 3600);
    }

    function _collateralFor(uint256 amount) internal pure returns (uint256) {
        return (amount * 150) / 100;
    }

    function _read(IntentManager m, bytes32 intentId)
        internal
        view
        returns (IntentManager.IntentStatus status, uint256 amount, address tokenAddress, uint256 collateralPosted)
    {
        (, amount, tokenAddress,,,,, status,, collateralPosted,,,) = m.intents(intentId);
    }

    function _submitNative(IntentManager m, uint256 amount) internal returns (bytes32 intentId) {
        vm.prank(user);
        intentId = m.submitIntent{value: amount}(address(0), amount, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
    }

    /// Native intent with solver collateral posted; returns the collateral.
    function _submitAndCollateralize(IntentManager m, uint256 amount)
        internal
        returns (bytes32 intentId, uint256 collateral)
    {
        intentId = _submitNative(m, amount);
        collateral = _collateralFor(amount);
        vm.prank(solver);
        m.postCollateral{value: collateral}(intentId);
    }

    function _submitToken(IntentManager m, FeeOnTransferTokenMock t, uint256 amount) internal returns (bytes32 intentId) {
        vm.startPrank(user);
        t.approve(address(m), amount);
        intentId = m.submitIntent(address(t), amount, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();
    }

    /// The contract's ETH must cover every pending treasury withdrawal plus the
    /// escrow (native intents) and collateral of every still-Pending intent.
    function _assertSolvent(IntentManager m, bytes32[] memory ids, address[] memory pendingHolders) internal view {
        uint256 owed;
        for (uint256 i = 0; i < pendingHolders.length; i++) {
            owed += m.pendingTreasuryWithdrawals(pendingHolders[i]);
        }
        for (uint256 i = 0; i < ids.length; i++) {
            (IntentManager.IntentStatus status, uint256 amount, address tokenAddress, uint256 collateral) = _read(m, ids[i]);
            if (status == IntentManager.IntentStatus.Pending) {
                owed += collateral;
                if (tokenAddress == address(0)) owed += amount;
            }
        }
        assertGe(address(m).balance, owed, "contract ETH < pending withdrawals + outstanding escrow/collateral");
    }

    function _ids(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function _holders(address a) internal pure returns (address[] memory holders) {
        holders = new address[](1);
        holders[0] = a;
    }

    // ══════════════════════ 1. Fee-on-transfer escrow ══════════════════════

    function test_v3_feeOnTransfer_submit_storesAmountActuallyReceived() public {
        FeeOnTransferTokenMock fee10 = new FeeOnTransferTokenMock(1_000); // 10%
        fee10.mint(user, 1_000);

        bytes32 intentId = _submitToken(intentManager, fee10, 100);

        (IntentManager.IntentStatus status, uint256 stored, address tokenAddress,) = _read(intentManager, intentId);
        assertEq(stored, 90, "stored amount must be what arrived, not the nominal 100");
        assertEq(fee10.balanceOf(address(intentManager)), stored, "contract token balance == stored amount");
        assertEq(fee10.balanceOf(fee10.FEE_SINK()), 10);
        assertEq(fee10.balanceOf(user), 900);
        assertEq(tokenAddress, address(fee10));
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Pending));
        assertEq(intentManager.dailyVolume(), 90, "volume counts the received amount");
    }

    function test_v3_feeOnTransfer_cancelIntent_refundsStoredAmount_andEmptiesContract() public {
        FeeOnTransferTokenMock fee10 = new FeeOnTransferTokenMock(1_000);
        fee10.mint(user, 1_000);
        bytes32 intentId = _submitToken(intentManager, fee10, 100);

        vm.warp(block.timestamp + 3600);
        vm.prank(user);
        intentManager.cancelIntent(intentId);

        assertEq(fee10.balanceOf(user), 1_000 - 100 + 90, "refund is exactly the stored 90");
        assertEq(fee10.balanceOf(address(intentManager)), 0, "contract token balance back to 0");
        (IntentManager.IntentStatus status,,,) = _read(intentManager, intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Expired));
    }

    /// Two intents of 100 each escrow 90 each (180 held). Confirming the first
    /// releases exactly 90 — never the nominal 100 — leaving exactly the
    /// second intent's 90, which can still be refunded in full.
    function test_v3_feeOnTransfer_confirmSettlement_releasesOnlyStoredAmount() public {
        FeeOnTransferTokenMock fee10 = new FeeOnTransferTokenMock(1_000);
        fee10.mint(user, 1_000);
        bytes32 first = _submitToken(intentManager, fee10, 100);
        bytes32 second = _submitToken(intentManager, fee10, 100);
        assertEq(fee10.balanceOf(address(intentManager)), 180);

        (,uint256 stored,,) = _read(intentManager, first);
        uint256 collateral = _collateralFor(stored); // 135 wei: based on the stored 90
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(first);
        uint256 solverEthBefore = solver.balance;

        vm.prank(orchestrator);
        intentManager.confirmSettlement(first, bytes32(uint256(1)));

        assertEq(fee10.balanceOf(solver), 90, "solver receives exactly the stored amount");
        assertEq(solver.balance, solverEthBefore + collateral, "collateral returned");
        (, uint256 secondStored,,) = _read(intentManager, second);
        assertEq(fee10.balanceOf(address(intentManager)), secondStored, "only the other intent's escrow remains");
        assertLe(fee10.balanceOf(solver), 180, "never more than the contract held");

        vm.warp(block.timestamp + 3600);
        vm.prank(user);
        intentManager.cancelIntent(second);
        assertEq(fee10.balanceOf(address(intentManager)), 0);
    }

    /// Single fee-token intent: without the v3 fix confirm would try to send
    /// the nominal 100 while holding 90 and revert; it must release 90.
    function test_v3_feeOnTransfer_confirmSettlement_singleIntent_neverExceedsHoldings() public {
        FeeOnTransferTokenMock fee10 = new FeeOnTransferTokenMock(1_000);
        fee10.mint(user, 1_000);
        bytes32 intentId = _submitToken(intentManager, fee10, 100);
        uint256 held = fee10.balanceOf(address(intentManager));

        vm.prank(solver);
        intentManager.postCollateral{value: _collateralFor(90)}(intentId);
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));

        assertEq(fee10.balanceOf(solver), held);
        assertEq(fee10.balanceOf(address(intentManager)), 0);
    }

    function test_v3_feeOnTransfer_fullFeeToken_revertsInvalidAmount() public {
        FeeOnTransferTokenMock fee100 = new FeeOnTransferTokenMock(10_000); // delivers 0
        fee100.mint(user, 1_000);

        vm.startPrank(user);
        fee100.approve(address(intentManager), 100);
        vm.expectRevert(IntentManager.InvalidAmount.selector);
        intentManager.submitIntent(address(fee100), 100, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();

        assertEq(fee100.balanceOf(user), 1_000, "whole call reverted: nothing taken");
        assertEq(intentManager.intentNonce(), 0);
    }

    // ═════════════════════════ 2. withdrawTreasury ═════════════════════════

    /// slash (intent A) + claimRefund (intent B): both collaterals accumulate
    /// in pendingTreasuryWithdrawals, nothing is pushed to the treasury.
    function _slashAndRefund() internal returns (bytes32 a, bytes32 b, uint256 colA, uint256 colB) {
        (a, colA) = _submitAndCollateralize(intentManager, AMOUNT);
        (b, colB) = _submitAndCollateralize(intentManager, 2 * AMOUNT);
        _assertSolvent(intentManager, _ids(a, b), _holders(treasury));

        vm.warp(block.timestamp + 3600);
        vm.prank(orchestrator);
        intentManager.slashSolver(a);
        assertEq(intentManager.pendingTreasuryWithdrawals(treasury), colA, "credited after slashSolver");
        _assertSolvent(intentManager, _ids(a, b), _holders(treasury));

        vm.warp(block.timestamp + 24 hours);
        vm.prank(user);
        intentManager.claimRefund(b);
        assertEq(intentManager.pendingTreasuryWithdrawals(treasury), colA + colB, "accumulates after claimRefund");
        _assertSolvent(intentManager, _ids(a, b), _holders(treasury));
    }

    function test_v3_withdrawTreasury_pendingCreditedBySlashAndClaimRefund() public {
        uint256 treasuryBefore = treasury.balance;
        (,, uint256 colA, uint256 colB) = _slashAndRefund();
        assertEq(treasury.balance, treasuryBefore, "nothing pushed to treasury");
        assertEq(address(intentManager).balance, colA + colB, "contract holds exactly the pending collateral");
    }

    function test_v3_withdrawTreasury_paysFullPendingOnce_thenZero() public {
        (bytes32 a, bytes32 b, uint256 colA, uint256 colB) = _slashAndRefund();
        uint256 treasuryBefore = treasury.balance;
        uint256 contractBefore = address(intentManager).balance;

        vm.prank(treasury);
        intentManager.withdrawTreasury();

        assertEq(treasury.balance, treasuryBefore + colA + colB, "full pending paid");
        assertEq(intentManager.pendingTreasuryWithdrawals(treasury), 0, "pending cleared");
        assertEq(address(intentManager).balance, contractBefore - colA - colB);
        _assertSolvent(intentManager, _ids(a, b), _holders(treasury));

        // Second call: no revert, no ETH moves.
        vm.prank(treasury);
        intentManager.withdrawTreasury();
        assertEq(treasury.balance, treasuryBefore + colA + colB, "second call pays nothing");
        assertEq(address(intentManager).balance, contractBefore - colA - colB);
        assertEq(intentManager.pendingTreasuryWithdrawals(treasury), 0);
    }

    function test_v3_withdrawTreasury_callerWithNothingPending_isNoop() public {
        (bytes32 a, bytes32 b, uint256 colA, uint256 colB) = _slashAndRefund();
        uint256 strangerBefore = stranger.balance;
        uint256 contractBefore = address(intentManager).balance;

        vm.prank(stranger);
        intentManager.withdrawTreasury();

        assertEq(stranger.balance, strangerBefore, "stranger receives nothing");
        assertEq(address(intentManager).balance, contractBefore, "no ETH leaves the contract");
        assertEq(intentManager.pendingTreasuryWithdrawals(treasury), colA + colB, "treasury's pending untouched");
        assertEq(intentManager.pendingTreasuryWithdrawals(stranger), 0);
        _assertSolvent(intentManager, _ids(a, b), _holders(treasury));
    }

    /// Nobody but the treasury address can pull the treasury's balance —
    /// including the privileged roles.
    function test_v3_withdrawTreasury_nonTreasuryCannotWithdrawTreasuryBalance() public {
        (,, uint256 colA, uint256 colB) = _slashAndRefund();
        uint256 contractBefore = address(intentManager).balance;
        address[4] memory callers = [stranger, owner, orchestrator, solver];

        for (uint256 i = 0; i < callers.length; i++) {
            uint256 before = callers[i].balance;
            vm.prank(callers[i]);
            intentManager.withdrawTreasury();
            assertEq(callers[i].balance, before, "caller received nothing");
        }

        assertEq(address(intentManager).balance, contractBefore);
        assertEq(intentManager.pendingTreasuryWithdrawals(treasury), colA + colB);

        vm.prank(treasury);
        intentManager.withdrawTreasury();
        assertEq(intentManager.pendingTreasuryWithdrawals(treasury), 0);
    }

    // ══════════════════════════ 3. Broken treasury ═════════════════════════

    function test_v3_brokenTreasury_slashSolver_stillSucceeds() public {
        RevertingTreasury bad = new RevertingTreasury();
        IntentManager m = _deploy(address(bad));
        bad.setTarget(m);

        (bytes32 intentId, uint256 collateral) = _submitAndCollateralize(m, AMOUNT);
        vm.warp(block.timestamp + 3600);
        uint256 userBefore = user.balance;

        vm.prank(orchestrator);
        m.slashSolver(intentId);

        assertEq(user.balance, userBefore + AMOUNT, "user refunded despite broken treasury");
        (IntentManager.IntentStatus status,,, uint256 collateralPosted) = _read(m, intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Slashed));
        assertEq(collateralPosted, 0);
        assertEq(m.pendingTreasuryWithdrawals(address(bad)), collateral, "collateral credited");
        assertEq(address(m).balance, collateral);
    }

    function test_v3_brokenTreasury_claimRefund_stillSucceeds() public {
        RevertingTreasury bad = new RevertingTreasury();
        IntentManager m = _deploy(address(bad));
        bad.setTarget(m);

        (bytes32 intentId, uint256 collateral) = _submitAndCollateralize(m, AMOUNT);
        vm.warp(block.timestamp + 3600 + 24 hours);
        uint256 userBefore = user.balance;

        vm.prank(user);
        m.claimRefund(intentId);

        assertEq(user.balance, userBefore + AMOUNT, "escape hatch works despite broken treasury");
        (IntentManager.IntentStatus status,,, uint256 collateralPosted) = _read(m, intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Refunded));
        assertEq(collateralPosted, 0);
        assertEq(m.pendingTreasuryWithdrawals(address(bad)), collateral, "collateral credited");
        assertEq(address(m).balance, collateral);
    }

    function test_v3_brokenTreasury_withdraw_revertsEthTransferFailed_pendingIntact() public {
        RevertingTreasury bad = new RevertingTreasury();
        IntentManager m = _deploy(address(bad));
        bad.setTarget(m);

        (bytes32 a, uint256 colA) = _submitAndCollateralize(m, AMOUNT);
        (bytes32 b, uint256 colB) = _submitAndCollateralize(m, AMOUNT);
        vm.warp(block.timestamp + 3600);
        vm.prank(orchestrator);
        m.slashSolver(a);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(user);
        m.claimRefund(b);
        uint256 pending = m.pendingTreasuryWithdrawals(address(bad));
        assertEq(pending, colA + colB);

        vm.expectRevert(IntentManager.EthTransferFailed.selector);
        bad.withdraw();

        // State after the revert: pending restored, ETH still in the contract.
        assertEq(m.pendingTreasuryWithdrawals(address(bad)), pending, "pending left intact");
        assertEq(address(m).balance, pending);
        assertEq(address(bad).balance, 0);
        _assertSolvent(m, _ids(a, b), _holders(address(bad)));
    }

    /// Re-entry bubbles up: the outer withdrawTreasury reverts, nothing is
    /// paid, pending stays intact.
    function test_v3_reentrantTreasury_reentryReverts_outerReverts_pendingIntact() public {
        ReentrantTreasury rt = new ReentrantTreasury();
        IntentManager m = _deploy(address(rt));
        rt.setTarget(m, false);

        (bytes32 a, uint256 colA) = _submitAndCollateralize(m, AMOUNT);
        vm.warp(block.timestamp + 3600);
        vm.prank(orchestrator);
        m.slashSolver(a);
        uint256 pending = m.pendingTreasuryWithdrawals(address(rt));
        assertEq(pending, colA);

        bool outerSucceeded;
        try rt.withdraw() {
            outerSucceeded = true;
        } catch {}

        if (outerSucceeded) {
            assertEq(address(rt).balance, pending, "succeeded: exactly one payout");
            assertEq(m.pendingTreasuryWithdrawals(address(rt)), 0);
        } else {
            assertEq(address(rt).balance, 0, "reverted: nothing paid");
            assertEq(m.pendingTreasuryWithdrawals(address(rt)), pending, "reverted: pending intact");
            assertEq(address(m).balance, pending);
        }
        assertLe(address(rt).balance, pending, "treasury never receives more than its pending amount");
        assertFalse(outerSucceeded, "observed: ReentrancyGuard makes the re-entry, and so the outer call, revert");
    }

    /// Re-entry failure swallowed: the outer call completes with exactly one
    /// payout of the pending amount; the re-entry itself never pays.
    function test_v3_reentrantTreasury_reentrySwallowed_exactlyOnePayout() public {
        ReentrantTreasury rt = new ReentrantTreasury();
        IntentManager m = _deploy(address(rt));
        rt.setTarget(m, true);

        (bytes32 a, uint256 colA) = _submitAndCollateralize(m, AMOUNT);
        (bytes32 b, uint256 colB) = _submitAndCollateralize(m, 2 * AMOUNT);
        vm.warp(block.timestamp + 3600);
        vm.startPrank(orchestrator);
        m.slashSolver(a);
        m.slashSolver(b);
        vm.stopPrank();
        uint256 pending = m.pendingTreasuryWithdrawals(address(rt));
        assertEq(pending, colA + colB);

        rt.withdraw();

        assertTrue(rt.reentryFailed(), "re-entry was blocked");
        assertEq(rt.receiveCount(), 1, "exactly one payout");
        assertEq(rt.totalReceived(), pending);
        assertEq(address(rt).balance, pending, "treasury never receives more than its pending amount");
        assertEq(m.pendingTreasuryWithdrawals(address(rt)), 0);
        assertEq(address(m).balance, 0);
        _assertSolvent(m, _ids(a, b), _holders(address(rt)));
    }
}
