// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IntentManager} from "../src/IntentManager.sol";

/// @notice Deploys IntentManager v2.
/// @dev Run with `--interactive` (see the command below) so the owner's private
/// key is typed at a prompt and never touches disk. The broadcaster that key
/// resolves to becomes BOTH the transaction sender AND the contract's `owner`
/// — checked against EXPECTED_OWNER (and against Foundry's default sender, in
/// case --interactive was skipped/misconfigured) before anything is deployed.
/// orchestrator, treasury, and the one initial approved solver are read from
/// env var ADDRESSES only (never keys):
///   EXPECTED_OWNER, ORCHESTRATOR_ADDRESS, TREASURY_ADDRESS, INITIAL_SOLVER_ADDRESS
contract DeployV2 is Script {
    /// @dev Foundry's default script sender — a real deploy must never use it.
    address constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    function run() external {
        address expectedOwner = vm.envAddress("EXPECTED_OWNER");
        address orchestratorAddr = vm.envAddress("ORCHESTRATOR_ADDRESS");
        address treasuryAddr = vm.envAddress("TREASURY_ADDRESS");
        address initialSolverAddr = vm.envAddress("INITIAL_SOLVER_ADDRESS");

        vm.startBroadcast();
        address ownerAddr = msg.sender; // the --interactive-typed key IS the owner

        require(ownerAddr == expectedOwner, "DeployV2: broadcaster != EXPECTED_OWNER");
        require(ownerAddr != FOUNDRY_DEFAULT_SENDER, "DeployV2: refusing to deploy as Foundry's default sender");

        IntentManager intentManager = new IntentManager(orchestratorAddr, treasuryAddr, ownerAddr);
        intentManager.setSolver(initialSolverAddr, true);
        vm.stopBroadcast();

        require(intentManager.owner() == expectedOwner, "DeployV2: post-deploy owner mismatch");
        require(intentManager.orchestrator() == orchestratorAddr, "DeployV2: post-deploy orchestrator mismatch");
        require(intentManager.treasury() == treasuryAddr, "DeployV2: post-deploy treasury mismatch");
        require(intentManager.approvedSolvers(initialSolverAddr), "DeployV2: post-deploy initial solver not approved");

        console.log("IntentManager v2:    ", address(intentManager));
        console.log("owner (broadcaster): ", ownerAddr);
        console.log("orchestrator:        ", orchestratorAddr);
        console.log("treasury:            ", treasuryAddr);
        console.log("initial solver:      ", initialSolverAddr);
    }
}
