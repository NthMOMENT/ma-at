// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title IntentManager
/// @notice Source-chain (Arbitrum Sepolia / Robinhood Chain testnet) contract for Maat.
/// Users escrow ETH here to express a cross-chain intent; solvers overcollateralize
/// and front the destination-chain payout; the off-chain orchestrator confirms
/// settlement (or slashes a non-performing solver) once a ZK proof of the
/// destination-chain event is verified off-chain.
contract IntentManager is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum IntentStatus {
        Pending,
        Settled,
        Expired,
        Slashed,
        Refunded
    }

    struct Intent {
        address owner;
        uint256 amount;
        /// @dev address(0) = native ETH; any other address = ERC20 token escrowed via transferFrom.
        address tokenAddress;
        /// @dev Destination address, encoded per destinationChainId's VM:
        ///   - EVM chains: abi.encode(address) → left-padded bytes32 (address in the low 20 bytes).
        ///   - Solana (chainId 1399811149): UTF-8 bytes of the base58 pubkey string,
        ///     right-padded with zeros to 32 bytes.
        ///   - TRON Nile (chainId 3448148188): UTF-8 bytes of the base58 address string,
        ///     right-padded with zeros to 32 bytes.
        /// The orchestrator uses destinationChainId to pick the right decoding.
        bytes32 destinationWallet;
        uint64 destinationChainId;
        uint64 expiry;
        uint16 slippageBps;
        IntentStatus status;
        address solver;
        uint256 collateralPosted;
        bytes32 zkProofHash;
        uint256 createdAt;
        uint256 settledAt;
    }

    mapping(bytes32 => Intent) public intents;
    uint256 public intentNonce;

    /// @dev No longer immutable (v2) — owner-rotatable via setOrchestrator so a
    /// compromised or retiring orchestrator key can be replaced without redeploying.
    address public orchestrator;
    address public immutable treasury;
    address public immutable owner;

    /// @dev v2: solvers must be explicitly approved by owner before they may
    /// postCollateral — replaces v1's "first caller with the right collateral wins".
    mapping(address => bool) public approvedSolvers;

    uint256 public constant COLLATERAL_RATIO = 150;

    /// @dev v2: grace period after expiry before the intent owner can pull the
    /// escape hatch (claimRefund) if the orchestrator never confirms or slashes.
    uint256 public constant REFUND_GRACE = 24 hours;

    uint256 public dailyVolume;
    uint256 public dailyVolumeLimit;
    uint256 public lastVolumeReset;
    uint256 public constant VOLUME_WINDOW = 24 hours;

    event IntentCreated(
        bytes32 indexed intentId,
        address indexed sender,
        uint256 amount,
        address tokenAddress,
        bytes32 destinationWallet,
        uint64 destinationChainId,
        uint64 expiry,
        uint16 slippageBps
    );
    event CollateralPosted(bytes32 indexed intentId, address indexed solver, uint256 collateralAmount);
    event IntentSettled(bytes32 indexed intentId, address indexed solver, uint256 amount, bytes32 zkProofHash);
    event SolverSlashed(bytes32 indexed intentId, address indexed solver, uint256 collateralSlashed, address treasury);
    event IntentCancelled(bytes32 indexed intentId, address indexed user, uint256 amount);
    event CircuitBreakerTriggered(uint256 amount, uint256 dailyVolume, uint256 dailyVolumeLimit);
    event DailyVolumeLimitUpdated(uint256 newLimit);
    event OrchestratorChanged(address indexed previousOrchestrator, address indexed newOrchestrator);
    event SolverApproved(address indexed solver, bool approved);
    event CollateralReturned(bytes32 indexed intentId, address indexed solver, uint256 amount);
    event IntentRefunded(bytes32 indexed intentId, address indexed owner, uint256 amount, uint256 collateral);

    error InvalidAmount();
    error ExpiryInPast();
    error IncorrectValue();
    error DailyVolumeLimitExceeded();
    error IntentDoesNotExist();
    error SolverAlreadyPosted();
    error IntentExpired();
    error IntentNotExpired();
    error InsufficientCollateral();
    error NotOrchestrator();
    error NotAdmin();
    error NotIntentOwner();
    error IntentNotPending();
    error NoSolver();
    error EthTransferFailed();
    error ZeroAddress();
    error NotApprovedSolver();

    modifier onlyOrchestrator() {
        if (msg.sender != orchestrator) revert NotOrchestrator();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != owner) revert NotAdmin();
        _;
    }

    constructor(address _orchestrator, address _treasury, address _owner) {
        if (_orchestrator == address(0) || _treasury == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        orchestrator = _orchestrator;
        treasury = _treasury;
        owner = _owner;
        dailyVolumeLimit = type(uint256).max;
        lastVolumeReset = block.timestamp;
    }

    /// @notice User escrows ETH (tokenAddress == address(0)) or an ERC20 token
    /// (tokenAddress == token contract, pulled via transferFrom) and creates a
    /// cross-chain intent.
    function submitIntent(
        address tokenAddress,
        uint256 amount,
        bytes32 destinationWallet,
        uint64 destinationChainId,
        uint64 expiry,
        uint16 slippageBps
    ) external payable whenNotPaused nonReentrant returns (bytes32 intentId) {
        if (amount == 0) revert InvalidAmount();
        if (expiry <= block.timestamp) revert ExpiryInPast();

        if (tokenAddress == address(0)) {
            if (msg.value != amount) revert IncorrectValue();
        } else {
            if (msg.value != 0) revert IncorrectValue();
            IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);
        }

        if (block.timestamp > lastVolumeReset + VOLUME_WINDOW) {
            dailyVolume = 0;
            lastVolumeReset = block.timestamp;
        }
        if (dailyVolume + amount > dailyVolumeLimit) {
            emit CircuitBreakerTriggered(amount, dailyVolume, dailyVolumeLimit);
            revert DailyVolumeLimitExceeded();
        }
        dailyVolume += amount;

        intentId = keccak256(abi.encodePacked(msg.sender, intentNonce, block.timestamp));
        intentNonce += 1;

        intents[intentId] = Intent({
            owner: msg.sender,
            amount: amount,
            tokenAddress: tokenAddress,
            destinationWallet: destinationWallet,
            destinationChainId: destinationChainId,
            expiry: expiry,
            slippageBps: slippageBps,
            status: IntentStatus.Pending,
            solver: address(0),
            collateralPosted: 0,
            zkProofHash: bytes32(0),
            createdAt: block.timestamp,
            settledAt: 0
        });

        emit IntentCreated(
            intentId, msg.sender, amount, tokenAddress, destinationWallet, destinationChainId, expiry, slippageBps
        );
    }

    /// @notice Solver overcollateralizes against a pending intent.
    /// @dev Collateral is always posted in native ETH, regardless of the intent's
    /// tokenAddress. For ERC20-denominated intents, COLLATERAL_RATIO is applied to
    /// intent.amount's raw token-unit count, not its ETH-equivalent value — this
    /// produces a meaningless collateral requirement across assets of differing
    /// price/decimals until real cross-asset (oracle-based) collateralization is added.
    /// @dev v2: caller must be an owner-approved solver (see setSolver) — no longer
    /// "first correctly-collateralized caller wins".
    function postCollateral(bytes32 intentId) external payable whenNotPaused nonReentrant {
        if (!approvedSolvers[msg.sender]) revert NotApprovedSolver();
        Intent storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentDoesNotExist();
        if (intent.solver != address(0)) revert SolverAlreadyPosted();
        if (block.timestamp >= intent.expiry) revert IntentExpired();

        uint256 required = (intent.amount * COLLATERAL_RATIO) / 100;
        if (msg.value != required) revert InsufficientCollateral();

        intent.solver = msg.sender;
        intent.collateralPosted = msg.value;

        emit CollateralPosted(intentId, msg.sender, msg.value);
    }

    /// @notice Orchestrator confirms an off-chain-verified ZK proof, releases the
    /// escrowed user funds to the solver as reimbursement/reward, and returns the
    /// solver's posted collateral in full.
    /// @dev v2: no expiry check — the destination-chain delivery this confirms may
    /// have been proven after the source-chain intent's expiry passed; expiry only
    /// gates cancelIntent/slashSolver, not a legitimate late confirmation.
    function confirmSettlement(bytes32 intentId, bytes32 zkProofHash) external onlyOrchestrator nonReentrant {
        Intent storage intent = intents[intentId];
        if (intent.status != IntentStatus.Pending) revert IntentNotPending();
        if (intent.solver == address(0)) revert NoSolver();

        intent.status = IntentStatus.Settled;
        intent.zkProofHash = zkProofHash;
        intent.settledAt = block.timestamp;

        address solver = intent.solver;
        uint256 amount = intent.amount;
        uint256 collateral = intent.collateralPosted;
        intent.collateralPosted = 0;

        _releaseFunds(solver, amount, intent.tokenAddress);

        (bool ok,) = payable(solver).call{value: collateral}("");
        if (!ok) revert EthTransferFailed();

        emit IntentSettled(intentId, solver, amount, zkProofHash);
        emit CollateralReturned(intentId, solver, collateral);
    }

    /// @notice Orchestrator slashes a solver that failed to deliver before expiry.
    function slashSolver(bytes32 intentId) external onlyOrchestrator nonReentrant {
        Intent storage intent = intents[intentId];
        if (intent.status != IntentStatus.Pending) revert IntentNotPending();
        if (block.timestamp < intent.expiry) revert IntentNotExpired();
        if (intent.solver == address(0)) revert NoSolver();

        intent.status = IntentStatus.Slashed;

        address solver = intent.solver;
        address user = intent.owner;
        uint256 amount = intent.amount;
        uint256 collateral = intent.collateralPosted;
        intent.collateralPosted = 0;

        _releaseFunds(user, amount, intent.tokenAddress);

        // Collateral is always native ETH (see postCollateral), independent of the intent's asset.
        (bool okTreasury,) = payable(treasury).call{value: collateral}("");
        if (!okTreasury) revert EthTransferFailed();

        emit SolverSlashed(intentId, solver, collateral, treasury);
    }

    /// @notice User reclaims escrow for an intent that expired with no solver.
    function cancelIntent(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        if (intent.owner != msg.sender) revert NotIntentOwner();
        if (intent.status != IntentStatus.Pending) revert IntentNotPending();
        if (block.timestamp < intent.expiry) revert IntentNotExpired();
        if (intent.solver != address(0)) revert SolverAlreadyPosted();

        intent.status = IntentStatus.Expired;

        uint256 amount = intent.amount;
        _releaseFunds(msg.sender, amount, intent.tokenAddress);

        emit IntentCancelled(intentId, msg.sender, amount);
    }

    /// @notice Escape hatch for an intent a solver collateralized but the
    /// orchestrator never confirmed or slashed, even REFUND_GRACE after expiry —
    /// covers an orchestrator that's down, buggy, or has simply abandoned the
    /// intent. Refunds escrow to the owner and forfeits the solver's collateral
    /// to treasury, same disposition as slashSolver.
    /// @dev Not whenNotPaused: a pause must never trap user funds.
    function claimRefund(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        if (intent.owner != msg.sender) revert NotIntentOwner();
        if (intent.status != IntentStatus.Pending) revert IntentNotPending();
        if (intent.solver == address(0)) revert NoSolver();
        if (block.timestamp < intent.expiry + REFUND_GRACE) revert IntentNotExpired();

        intent.status = IntentStatus.Refunded;
        uint256 amount = intent.amount;
        uint256 collateral = intent.collateralPosted;
        intent.collateralPosted = 0;

        _releaseFunds(msg.sender, amount, intent.tokenAddress);

        (bool okTreasury,) = payable(treasury).call{value: collateral}("");
        if (!okTreasury) revert EthTransferFailed();

        emit IntentRefunded(intentId, msg.sender, amount, collateral);
    }

    /// @dev Releases an intent's escrowed `amount` — native ETH if tokenAddress is
    /// address(0), otherwise the ERC20 token at tokenAddress. Used by confirmSettlement,
    /// slashSolver, and cancelIntent; never for collateral, which is always native ETH.
    function _releaseFunds(address to, uint256 amount, address tokenAddress) internal {
        if (tokenAddress == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(tokenAddress).safeTransfer(to, amount);
        }
    }

    // ------------------- Admin -------------------

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    function setDailyVolumeLimit(uint256 newLimit) external onlyAdmin {
        dailyVolumeLimit = newLimit;
        emit DailyVolumeLimitUpdated(newLimit);
    }

    /// @notice Rotates the orchestrator role. The previous orchestrator loses all
    /// rights (confirmSettlement/slashSolver) the moment this call lands.
    function setOrchestrator(address newOrchestrator) external onlyAdmin {
        if (newOrchestrator == address(0)) revert ZeroAddress();
        address previous = orchestrator;
        orchestrator = newOrchestrator;
        emit OrchestratorChanged(previous, newOrchestrator);
    }

    /// @notice Approves or revokes a solver's ability to call postCollateral.
    function setSolver(address solver, bool approved) external onlyAdmin {
        if (solver == address(0)) revert ZeroAddress();
        approvedSolvers[solver] = approved;
        emit SolverApproved(solver, approved);
    }
}
