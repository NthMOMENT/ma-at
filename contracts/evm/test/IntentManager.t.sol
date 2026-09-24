// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
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

    function setUp() public {
        intentManager = new IntentManager(orchestrator, treasury, owner);
        token = new ERC20Mock();
        noReturnToken = new NoReturnTokenMock();

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

    // ── confirmSettlement releases the correct asset to the solver ────────

    function test_confirmSettlement_native_paysSolverEth() public {
        vm.prank(user);
        bytes32 intentId = intentManager.submitIntent{value: AMOUNT}(
            address(0), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS
        );

        uint256 collateral = (AMOUNT * 150) / 100;
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        uint256 before = solver.balance;
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));
        assertEq(solver.balance, before + AMOUNT);
    }

    function test_confirmSettlement_erc20_paysSolverToken() public {
        vm.startPrank(user);
        token.approve(address(intentManager), AMOUNT);
        bytes32 intentId =
            intentManager.submitIntent(address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();

        // Collateral is still native ETH even though the intent is ERC20-denominated.
        uint256 collateral = (AMOUNT * 150) / 100;
        vm.prank(solver);
        intentManager.postCollateral{value: collateral}(intentId);

        uint256 before = token.balanceOf(solver);
        vm.prank(orchestrator);
        intentManager.confirmSettlement(intentId, bytes32(uint256(1)));
        assertEq(token.balanceOf(solver), before + AMOUNT);
    }

    // ── slashSolver refunds the user in the intent's asset, collateral stays native ──

    function test_slashSolver_erc20_refundsUserToken_andSlashesNativeCollateral() public {
        vm.startPrank(user);
        token.approve(address(intentManager), AMOUNT);
        bytes32 intentId =
            intentManager.submitIntent(address(token), AMOUNT, DEST_WALLET, DEST_CHAIN_ID, _expiry(), SLIPPAGE_BPS);
        vm.stopPrank();

        uint256 collateral = (AMOUNT * 150) / 100;
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
}
