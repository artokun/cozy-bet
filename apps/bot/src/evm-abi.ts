/**
 * Hand-rolled ABI fragments for the EVM (Base) contract calls the bot
 * makes. Lives here in a no-env-deps module so the IDL drift check
 * (apps/bot/scripts/check-evm-abi-sync.ts) and tests can import them
 * without triggering the bot's full env validation.
 *
 * These must stay subset-compatible with what Foundry generates at
 * apps/contracts/out/CozyBetEscrow.sol/CozyBetEscrow.json after
 * `forge build`. Drift = bot writeContract / readContract calls fail
 * at runtime with 'AbiFunctionNotFoundError' or unhelpful revert data.
 */

export const ESCROW_ABI = [
  {
    type: "function",
    name: "initializeBet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "challenger", type: "address" },
      { name: "accepter", type: "address" },
      { name: "termsHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "uint256" },
      { name: "winner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "arbiterResolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "uint256" },
      { name: "winner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "draw",
    stateMutability: "nonpayable",
    inputs: [{ name: "betId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "betId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setFeeBpsForSide",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "uint256" },
      { name: "side", type: "address" },
      { name: "newBps", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getBet",
    stateMutability: "view",
    inputs: [{ name: "betId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "challenger", type: "address" },
          { name: "accepter", type: "address" },
          { name: "challengerFeeBps", type: "uint16" },
          { name: "accepterFeeBps", type: "uint16" },
          { name: "challengerDeposited", type: "bool" },
          { name: "accepterDeposited", type: "bool" },
          { name: "status", type: "uint8" },
          { name: "winner", type: "address" },
          { name: "termsHash", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

export const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
