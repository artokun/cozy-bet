// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CozyBetEscrow} from "../src/CozyBetEscrow.sol";

/**
 * Deploy CozyBetEscrow to a target network.
 *
 *   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast \
 *     --private-key $RESOLVER_PRIVATE_KEY
 *
 * Reads the 4 treasury addresses + admin + USDC mint from env vars.
 */
contract Deploy is Script {
    function run() external {
        // Base Sepolia native USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
        address usdc = vm.envAddress("USDC_ADDRESS");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address[4] memory owners = [
            vm.envAddress("TREASURY_OWNER_1"),
            vm.envAddress("TREASURY_OWNER_2"),
            vm.envAddress("TREASURY_OWNER_3"),
            vm.envAddress("TREASURY_OWNER_4")
        ];
        vm.startBroadcast();
        CozyBetEscrow escrow = new CozyBetEscrow(IERC20(usdc), owners, admin);
        // Constructor grants DEFAULT_ADMIN + RESOLVER + ARBITER to admin.
        // For testnet, set admin == resolver (single hot key). For mainnet,
        // admin should be a Safe multisig that grants RESOLVER_ROLE to the
        // bot's hot resolver wallet via a separate post-deploy tx.
        vm.stopBroadcast();

        console2.log("CozyBetEscrow deployed at:", address(escrow));
        console2.log("USDC:", usdc);
        console2.log("Admin (also resolver/arbiter):", admin);
    }
}
