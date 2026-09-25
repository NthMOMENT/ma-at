// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IntentManager} from "../src/IntentManager.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {ERC20NoReturnMock} from "@openzeppelin/contracts/mocks/token/ERC20NoReturnMock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Mirrors real USDT-style tokens whose transfer/transferFrom don't return a
// bool — exercises IntentManager's use of SafeERC20 rather than a raw
// IERC20 call, which would revert trying to decode a missing return value.
contract NoReturnTokenMock is ERC20NoReturnMock {
    constructor() ERC20("Tether-like Mock", "USDT-M") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

/// @dev Legitimately holds both the orchestrator role and (for the slash test)
/// the intent-owner/solver role, so a reentrant call it makes back into
/// IntentManager passes every access-control check and is stopped by
/// ReentrancyGuard alone — not by NotOrchestrator/NotIntentOwner, which would
/// prove nothing about reentrancy specifically.
contract ReentrantAttacker {
    IntentManager public target;
    bytes32 public intentId;
    bool public attackConfirm;
    bool public attackSlash;
    bool public attackClaim;

    constructor(IntentManager _target) {
        target = _target;
    }

    function setIntent(bytes32 _intentId) external {
        intentId = _intentId;
    }

    function armConfirm() external {
        attackConfirm = true;
    }

    function armSlash() external {
        attackSlash = true;
    }

    function armClaim() external {
        attackClaim = true;
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

    function confirmSettlement(bytes32 _intentId, bytes32 proofHash) external {
        target.confirmSettlement(_intentId, proofHash);
    }

    function slashSolver(bytes32 _intentId) external {
        target.slashSolver(_intentId);
    }

    function claimRefund(bytes32 _intentId) external {
        target.claimRefund(_intentId);
    }

    receive() external payable {
        if (attackConfirm) {
            attackConfirm = false;
            target.confirmSettlement(intentId, bytes32(uint256(1)));
        } else if (attackSlash) {
            attackSlash = false;
            target.slashSolver(intentId);
        } else if (attackClaim) {
            attackClaim = false;
            target.claimRefund(intentId);
        }
    }
}

contract IntentManagerTest is Test {
    IntentManager intentManager;
    ERC20Mock token;
    NoReturnTokenMock noReturnToken;

    address orchestrator = makeAddr("orchestrator");
    address treasury = makeAddr("treasury");
    address owner = makeAddr("owner");
    address user = makeAddr("user");
    address solver = makeAddr("solver");

    uint256 constant AMOUNT = 1 ether;
    bytes32 constant DEST_WALLET = bytes32(uint256(uint160(address(0xBEEF))));
    uint64 constant DEST_CHAIN_ID = 1399811149;
    uint16 constant SLIPPAGE_BPS = 50;

    // v1's on-chain values — v2 must not change either.
    bytes32 constant V1_INTENT_CREATED_TOPIC0 = 0x1633e7e54ae0b855365938679d6532826f20b065ed71f076c885b24249decd99;
    bytes4 constant V1_SUBMIT_INTENT_SELECTOR = 0xa766d36d;

    function setUp() public {
        intentManager = new IntentManager(orchestrator, treasury, owner);
        token = new ERC20Mock();
        noReturnToken = new NoReturnTokenMock();

        vm.prank(owner);
        intentManager.setSolver(solver, true);

        vm.deal(user, 100 ether);
        vm.deal(solver, 100 ether);
        token.mint(user, 1000 ether);
        noReturnToken.mint(user, 1000 ether);
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 3600);
    }

    function _intent(bytes32 intentId) internal view returns (address intentOwner, uint256 amount, address tokenAddress) {
        (
            intentOwner,
            amount,
            tokenAddress,
            /* destinationWallet */,
            /* destinationChainId */,
            /* expiry */,
            /* slippageBps */,
            /* status */,
            /* solver */,
            /* collateralPosted */,
            /* zkProofHash */,
            /* createdAt */,
            /* settledAt */
        ) = intentManager.intents(intentId);
    }

    function _full(bytes32 intentId)
        internal
        view
        returns (IntentManager.IntentStatus status, address intentSolver, uint256 collateralPosted)
    {
        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            status,
            intentSolver,
            collateralPosted,
            ,
            ,
        ) = intentManager.intents(intentId);
    }

    function _submitNative() internal returns (bytes32 intentId) {
        vm.prank(user);
        intentId = intentManager.submitIntent{value: AMOUNT}(
            address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );
    }

    function _collateralFor(uint256 amount) internal pure returns (uint256) {
        return (amount * 150) / 100;
    }

    // ── Native ETH path (unchanged behaviour) ──────────────────────────────

    function test_submitIntent_native_escrowsEth() public {
        vm.prank(user);
        bytes32 intentId = intentManager.submitIntent{value: AMOUNT}(
            address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );

        (address intentOwner, uint256 amount, address tokenAddress) = _intent(intentId);
        assertEq(intentOwner, user);
        assertEq(amount, AMOUNT);
        assertEq(tokenAddress, address(0));
        assertEq(address(intentManager).balance, AMOUNT);
    }

    function test_submitIntent_native_revertsOnValueMismatch() public {
        vm.prank(user);
        vm.expectRevert(IntentManager.IncorrectValue.selector);
        intentManager.submitIntent{value: AMOUNT - 1}(
            address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );
    }

    // ── ERC20 path (new) ────────────────────────────────────────────────────

    function test_submitIntent_erc20_pullsViaTransferFrom() public {
        vm.startPrank(user);
        token.approve(address(intentManager), AMOUNT);
        bytes32 intentId =
            intentManager.submitIntent(address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();

        (, uint256 amount, address tokenAddress) = _intent(intentId);
        assertEq(amount, AMOUNT);
        assertEq(tokenAddress, address(token));
        assertEq(token.balanceOf(address(intentManager)), AMOUNT);
        assertEq(token.balanceOf(user), 1000 ether - AMOUNT);
    }

    function test_submitIntent_erc20_revertsIfEthAttached() public {
        vm.startPrank(user);
        token.approve(address(intentManager), AMOUNT);
        vm.expectRevert(IntentManager.IncorrectValue.selector);
        intentManager.submitIntent{value: 1}(
            address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );
        vm.stopPrank();
    }

    function test_submitIntent_erc20_revertsWithoutApproval() public {
        vm.prank(user);
        vm.expectRevert();
        intentManager.submitIntent(address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
    }

    /// @dev Real USDT doesn't return a bool from transfer/transferFrom — this
    /// would revert on a raw IERC20 call; SafeERC20 handles it correctly.
    function test_submitIntent_erc20_noReturnToken_succeedsViaSafeERC20() public {
        vm.startPrank(user);
        // NoReturnTokenMock's approve() also returns no data (like real USDT
        // historically) — a normal typed call here would revert trying to
        // decode a missing bool, same class of issue this test is targeting.
        (bool approveOk,) = address(noReturnToken).call(
            abi.encodeWithSignature("approve(address,uint256)", address(intentManager), AMOUNT)
        );
        assertTrue(approveOk);
        bytes32 intentId = intentManager.submitIntent(
            address(noReturnToken), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );
        vm.stopPrank();

        assertEq(noReturnToken.balanceOf(address(intentManager)), AMOUNT);
        (, uint256 amount, address tokenAddress) = _intent(intentId);
        assertEq(amount, AMOUNT);
        assertEq(tokenAddress, address(noReturnToken));
    }

    // ── cancelIntent releases the correct asset ────────────────────────────

    function test_cancelIntent_native_refundsEth() public {
        vm.prank(user);
        bytes32 intentId = intentManager.submitIntent{value: AMOUNT}(
            address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );

        vm.warp(block.timestamp + 3601);
        uint256 before = user.balance;
        vm.prank(user);
        intentManager.cancelIntent(intentId);
        assertEq(user.balance, before + AMOUNT);
    }

    function test_cancelIntent_erc20_refundsToken() public {
        vm.startPrank(user);
        token.approve(address(intentManager), AMOUNT);
        bytes32 intentId =
            intentManager.submitIntent(address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();

        vm.warp(block.timestamp + 3601);
        uint256 before = token.balanceOf(user);
        vm.prank(user);
        intentManager.cancelIntent(intentId);
        assertEq(token.balanceOf(user), before + AMOUNT);
    }

    // ── confirmSettlement releases the correct asset AND collateral to the solver (v2) ──

    function test_confirmSettlement_native_paysSolverEthPlusCollateral() public {
        vm.prank(user);
        bytes32 intentId = intentManager.submitIntent{value: AMOUNT}(
            address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );

        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        uint256 before = solver.balance;
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));
        // v2: solver gets back the escrow AND its collateral, not escrow alone.
        assertEq(solver.balance, before + AMOUNT + collateral);
    }

    function test_confirmSettlement_erc20_paysSolverToken_andReturnsNativeCollateral() public {
        vm.startPrank(user);
        token.approve(address(intentManager), AMOUNT);
        bytes32 intentId =
            intentManager.submitIntent(address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();

        // Collateral is still native ETH even though the intent is ERC20-denominated.
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        uint256 tokenBefore = token.balanceOf(solver);
        uint256 ethBefore = solver.balance;
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));
        assertEq(token.balanceOf(solver), tokenBefore + AMOUNT);
        assertEq(solver.balance, ethBefore + collateral);
    }

    // ── slashSolver refunds the user in the intent's asset, collateral stays native ──

    function test_slashSolver_erc20_refundsUserToken_andSlashesNativeCollateral() public {
        vm.startPrank(user);
        token.approve(address(intentManager), AMOUNT);
        bytes32 intentId =
            intentManager.submitIntent(address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();

        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3601);
        uint256 userTokenBefore = token.balanceOf(user);
        uint256 treasuryEthBefore = treasury.balance;

        vm.prank(orchestrator);
        intentManager.slashSolver(intentId);

        assertEq(token.balanceOf(user), userTokenBefore + AMOUNT);
        assertEq(treasury.balance, treasuryEthBefore + collateral);
    }

    // ══════════════════════════ v2 money-flow tests (6C) ══════════════════════════

    /// Happy path: submit -> solver posts 150% -> orchestrator confirms -> solver
    /// receives escrow + full collateral; contract balance for that intent = 0.
    function test_v2_happyPath_fullMoneyFlow() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);

        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);
        assertEq(address(intentManager).balance, AMOUNT + collateral);

        uint256 solverBefore = solver.balance;
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));

        assertEq(solver.balance, solverBefore + AMOUNT + collateral);
        assertEq(address(intentManager).balance, 0);

        (IntentManager.IntentStatus status,, uint256 collateralPosted) = _full(intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Settled));
        assertEq(collateralPosted, 0);
    }

    /// Double-pay closed: after confirm, owner cancelIntent reverts.
    function test_v2_doublePayClosed_cancelRevertsAfterConfirm() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));

        vm.warp(block.timestamp + 3601);
        vm.prank(user);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        intentManager.cancelIntent(intentId);
    }

    /// Cancel still works for an intent with no solver, after expiry.
    function test_v2_cancelIntent_noSolver_afterExpiry_stillWorks() public {
        bytes32 intentId = _submitNative();
        vm.warp(block.timestamp + 3601);
        uint256 before = user.balance;
        vm.prank(user);
        intentManager.cancelIntent(intentId);
        assertEq(user.balance, before + AMOUNT);
    }

    /// Stranger postCollateral reverts; approved solver succeeds.
    function test_v2_postCollateral_strangerReverts_approvedSolverSucceeds() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        address stranger = makeAddr("stranger");
        vm.deal(stranger, collateral);

        vm.prank(stranger);
        vm.expectRevert(IntentManager.NotApprovedSolver.selector);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);
        (, address intentSolver,) = _full(intentId);
        assertEq(intentSolver, solver);
    }

    /// confirmSettlement succeeds after expiry (v2 drops the expiry check).
    function test_v2_confirmSettlement_succeedsAfterExpiry() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3601);

        uint256 solverBefore = solver.balance;
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));
        assertEq(solver.balance, solverBefore + AMOUNT + collateral);
    }

    /// Slash after expiry: user gets escrow, treasury gets collateral (native path).
    function test_v2_slashSolver_afterExpiry_nativePath() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3601);
        uint256 userBefore = user.balance;
        uint256 treasuryBefore = treasury.balance;
        vm.prank(orchestrator);
        intentManager.slashSolver(intentId);

        assertEq(user.balance, userBefore + AMOUNT);
        assertEq(treasury.balance, treasuryBefore + collateral);
    }

    /// Slash before expiry reverts.
    function test_v2_slashSolver_beforeExpiry_reverts() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.prank(orchestrator);
        vm.expectRevert(IntentManager.IntentNotExpired.selector);
        intentManager.slashSolver(intentId);
    }

    /// Slash after confirm reverts (status no longer Pending).
    function test_v2_slashSolver_afterConfirm_reverts() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));

        vm.warp(block.timestamp + 3601);
        vm.prank(orchestrator);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        intentManager.slashSolver(intentId);
    }

    /// Only owner can setOrchestrator; old orchestrator loses rights immediately.
    function test_v2_setOrchestrator_onlyOwner_andRotatesRights() public {
        address newOrchestrator = makeAddr("newOrchestrator");

        vm.prank(user);
        vm.expectRevert(IntentManager.NotAdmin.selector);
        intentManager.setOrchestrator(newOrchestrator);

        vm.prank(owner);
        intentManager.setOrchestrator(newOrchestrator);
        assertEq(intentManager.orchestrator(), newOrchestrator);

        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.prank(orchestrator); // old orchestrator — must have lost rights
        vm.expectRevert(IntentManager.NotOrchestrator.selector);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));

        vm.prank(newOrchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));
    }

    /// Only owner can setSolver.
    function test_v2_setSolver_onlyOwner() public {
        address stranger = makeAddr("stranger2");
        vm.prank(user);
        vm.expectRevert(IntentManager.NotAdmin.selector);
        intentManager.setSolver(stranger, true);

        vm.prank(owner);
        intentManager.setSolver(stranger, true);
        assertTrue(intentManager.approvedSolvers(stranger));

        vm.prank(owner);
        intentManager.setSolver(stranger, false);
        assertFalse(intentManager.approvedSolvers(stranger));
    }

    /// IntentCreated topic0 identical to v1 — both the recomputed keccak of the
    /// signature string AND the actual emitted log from live v2 bytecode.
    function test_v2_intentCreated_topic0_identicalToV1() public {
        assertEq(
            keccak256("IntentCreated(bytes32,address,uint256,address,bytes32,uint64,uint64,uint16)"),
            V1_INTENT_CREATED_TOPIC0
        );

        vm.recordLogs();
        _submitNative();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(intentManager) && logs[i].topics[0] == V1_INTENT_CREATED_TOPIC0) {
                found = true;
                break;
            }
        }
        assertTrue(found, "IntentCreated topic0 emitted by v2 does not match v1");
    }

    /// submitIntent's function selector identical to v1's on-chain selector.
    function test_v2_submitIntent_selector_identicalToV1() public {
        assertEq(intentManager.submitIntent.selector, V1_SUBMIT_INTENT_SELECTOR);
    }

    /// Reentrancy attempt on confirmSettlement fails. The attacker legitimately
    /// holds BOTH the orchestrator role and the solver role, so the reentrant
    /// call it fires from its receive() hook is blocked purely by
    /// ReentrancyGuard, not by an access-control check.
    function test_v2_reentrancy_confirmSettlement_blocked() public {
        ReentrantAttacker attacker = new ReentrantAttacker(intentManager);
        vm.deal(address(attacker), 10 ether);

        vm.prank(owner);
        intentManager.setOrchestrator(address(attacker));
        vm.prank(owner);
        intentManager.setSolver(address(attacker), true);

        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        attacker.postCollateral{value: collateral}(intentId);

        attacker.setIntent(intentId);
        attacker.armConfirm();

        // The reentrant inner call reverts (ReentrancyGuard); that failure
        // propagates through the ETH transfer's low-level call as `ok == false`,
        // so the whole outer confirmSettlement reverts with EthTransferFailed.
        vm.expectRevert(IntentManager.EthTransferFailed.selector);
        attacker.confirmSettlement(intentId, bytes32(uint256(1)));

        (IntentManager.IntentStatus status,,) = _full(intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Pending));
    }

    /// Reentrancy attempt on slashSolver fails, same reasoning: the attacker is
    /// legitimately both the orchestrator and the intent owner (refund recipient).
    function test_v2_reentrancy_slashSolver_blocked() public {
        ReentrantAttacker attacker = new ReentrantAttacker(intentManager);
        vm.deal(address(attacker), 10 ether);

        vm.prank(owner);
        intentManager.setOrchestrator(address(attacker));

        bytes32 intentId = attacker.submit{value: AMOUNT}(AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);

        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3601);

        attacker.setIntent(intentId);
        attacker.armSlash();

        vm.expectRevert(IntentManager.EthTransferFailed.selector);
        attacker.slashSolver(intentId);

        (IntentManager.IntentStatus status,,) = _full(intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Pending));
    }

    // ══════════════════════════ claimRefund tests ══════════════════════════

    function test_v2_claimRefund_worksAfterExpiryPlusGrace_balancesCorrect() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3600 + 24 hours + 1);

        uint256 userBefore = user.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(user);
        intentManager.claimRefund(intentId);

        assertEq(user.balance, userBefore + AMOUNT);
        assertEq(treasury.balance, treasuryBefore + collateral);

        (IntentManager.IntentStatus status,, uint256 collateralPosted) = _full(intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Refunded));
        assertEq(collateralPosted, 0);
    }

    /// Past expiry but not yet past expiry + REFUND_GRACE — must still revert.
    function test_v2_claimRefund_revertsBeforeGraceElapsed() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3601);
        vm.prank(user);
        vm.expectRevert(IntentManager.IntentNotExpired.selector);
        intentManager.claimRefund(intentId);
    }

    function test_v2_claimRefund_revertsForNonOwner() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3600 + 24 hours + 1);

        address stranger = makeAddr("refundStranger");
        vm.prank(stranger);
        vm.expectRevert(IntentManager.NotIntentOwner.selector);
        intentManager.claimRefund(intentId);
    }

    function test_v2_claimRefund_revertsAfterConfirm() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));

        vm.warp(block.timestamp + 3600 + 24 hours + 1);
        vm.prank(user);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        intentManager.claimRefund(intentId);
    }

    function test_v2_claimRefund_revertsAfterSlash() public {
        bytes32 intentId = _submitNative();
        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3601);
        vm.prank(orchestrator);
        intentManager.slashSolver(intentId);

        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(user);
        vm.expectRevert(IntentManager.IntentNotPending.selector);
        intentManager.claimRefund(intentId);
    }

    /// Reentrancy attempt on claimRefund fails. Unlike confirm/slash, claimRefund
    /// has no role gate beyond intent.owner — the attacker just needs to
    /// legitimately be that owner, which it is by submitting its own intent.
    function test_v2_reentrancy_claimRefund_blocked() public {
        ReentrantAttacker attacker = new ReentrantAttacker(intentManager);
        vm.deal(address(attacker), 10 ether);

        bytes32 intentId = attacker.submit{value: AMOUNT}(AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);

        uint256 collateral = _collateralFor(AMOUNT);
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        vm.warp(block.timestamp + 3600 + 24 hours + 1);

        attacker.setIntent(intentId);
        attacker.armClaim();

        vm.expectRevert(IntentManager.EthTransferFailed.selector);
        attacker.claimRefund(intentId);

        (IntentManager.IntentStatus status,,) = _full(intentId);
        assertEq(uint8(status), uint8(IntentManager.IntentStatus.Pending));
    }
}
