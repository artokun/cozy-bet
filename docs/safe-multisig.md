# Safe multisig — Base runbook

Companion to `docs/squads-multisig.md`. Cozy-bet ships on both Solana
and Base; on Base the multisig standard is **Safe** (https://safe.global).

> **Status:** testnet only. Base Sepolia deployment runs on a single
> hot resolver wallet (DEFAULT_ADMIN_ROLE + RESOLVER_ROLE +
> ARBITER_ROLE). Safe migration below is the plan for **before** the
> first real money flows on Base mainnet.

## Phase 1 — pre-mainnet (one Safe, 2-of-3)

**When:** before the first deposit of real (mainnet) USDC on Base.

**Setup:**

1. Same three Ledger Nano Xs as the Squads phase (use the EVM
   address derived from each Ledger via the Ethereum app, NOT the
   Solana addresses).
2. Sign in to https://app.safe.global on Base mainnet, deploy a new
   Safe with `Threshold = 2`, `Owners = 3` (the three Ledger
   addresses).
3. Note the Safe's address — this becomes the new program admin
   (DEFAULT_ADMIN_ROLE + ARBITER_ROLE) and the four-treasury-owners
   replacement target.
4. Run the on-chain admin rotation. Unlike Solana, the Solidity
   contract uses OpenZeppelin's `AccessControl` so this works
   without contract changes:
   ```
   // From the resolver wallet (current admin):
   escrow.grantRole(DEFAULT_ADMIN_ROLE, <SAFE_ADDRESS>);
   escrow.grantRole(ARBITER_ROLE, <SAFE_ADDRESS>);
   escrow.renounceRole(DEFAULT_ADMIN_ROLE, <RESOLVER_ADDRESS>);
   escrow.renounceRole(ARBITER_ROLE, <RESOLVER_ADDRESS>);
   ```
5. Move the four treasury owners to the Safe (one Safe owner for
   each of the four shares):
   ```
   // Each call from the Safe (now admin):
   escrow.setTreasuryOwner(0, <SAFE_ADDRESS>);
   escrow.setTreasuryOwner(1, <SAFE_ADDRESS>);
   escrow.setTreasuryOwner(2, <SAFE_ADDRESS>);
   escrow.setTreasuryOwner(3, <SAFE_ADDRESS>);
   ```
6. Keep the resolver hot wallet as the **RESOLVER_ROLE** holder
   only. It can call `initializeBet` / `resolve` / `draw` /
   `refund` / `setFeeBpsForSide` but cannot rotate roles, change
   fees, or move funds out of the contract.

After Phase 1 the resolver wallet's worst-case compromise loses at
most the contention over a single bet's outcome, not access to the
treasury.

## Phase 2 — production (hot + cold split)

Mirrors the Squads Phase 2 plan:

- **Hot operational Safe** — `2-of-3`, ~$1–5k float. Same Ledger
  threshold as Phase 1; can be the Phase 1 Safe if its balance is
  small.
- **Cold treasury Safe** — `3-of-5`, holds the bulk of fees. Five
  Ledgers across team + advisors, threshold high enough that no two
  collocated keys can move funds.
- **Auto-sweep**: small bot or cron-triggered tx that, when the hot
  Safe USDC balance exceeds threshold, builds a transfer
  `hot → cold` proposal in the Safe UI. Two members approve to
  execute. Manual approval is the value — don't fully automate.
- Update treasury owners so 75% of fees flow to cold immediately:
  ```
  escrow.setTreasuryOwner(0, <HOT_SAFE>);
  escrow.setTreasuryOwner(1, <COLD_SAFE>);
  escrow.setTreasuryOwner(2, <COLD_SAFE>);
  escrow.setTreasuryOwner(3, <COLD_SAFE>);
  ```

## Phase 3 — volume (programmatic signing)

- **Turnkey** (https://turnkey.com) supports EVM signers with policy
  guardrails. Useful for the resolver role: bot asks Turnkey to
  sign with a per-bet allowlist policy. Treasury stays on the Safe.
- **Safe Modules / Zodiac** can encode pre-approved tx templates
  for routine ops (e.g. fee withdrawals up to a per-tx cap),
  reducing the number of manual approvals without giving up the
  multisig safety net.

Don't take this step until Phases 1 + 2 have run smoothly for
weeks.

## Cheatsheet for routine ops

All admin txs are submitted through the Safe UI as a "Custom
contract interaction" with the deployed escrow address.

### Read on-chain admin state

```sh
# replace addresses for your deployment
cast call <ESCROW_ADDR> 'hasRole(bytes32,address)(bool)' \
  $(cast keccak "DEFAULT_ADMIN_ROLE") <SAFE_OR_RESOLVER_ADDR> \
  --rpc-url https://mainnet.base.org
```

### Rotate admin to Safe

From the current admin wallet (resolver during Phase 0, Safe in
Phase 1+):

```sh
# Grant first, then renounce — never renounce-before-grant or
# you'll brick admin.
cast send <ESCROW_ADDR> 'grantRole(bytes32,address)' \
  $(cast keccak "DEFAULT_ADMIN_ROLE") <SAFE_ADDR> \
  --private-key $RESOLVER_PRIVATE_KEY --rpc-url https://mainnet.base.org

cast send <ESCROW_ADDR> 'renounceRole(bytes32,address)' \
  $(cast keccak "DEFAULT_ADMIN_ROLE") <RESOLVER_ADDR> \
  --private-key $RESOLVER_PRIVATE_KEY --rpc-url https://mainnet.base.org
```

### Change fee defaults via Safe

1. Safe UI → New transaction → Contract interaction
2. Contract address: `<ESCROW_ADDR>`. ABI: pull from
   `apps/contracts/out/CozyBetEscrow.sol/CozyBetEscrow.json`.
3. Method: `setDefaultFeeBps(newBps)` or
   `setMinDiscountedFeeBps(newBps)` or
   `setArbiterFeeConfig(newMinFee, newBpsOfPot)`.
4. Other signers approve → execute.

### Withdraw fees from a treasury address

Treasury addresses are EOAs (or Safes) named in the contract's
`treasuryOwners[i]` slots. They receive USDC directly on
`resolve` / `arbiterResolve`. To withdraw, the treasury wallet (or
Safe) submits a standard ERC20 transfer:

```
USDC.transfer(<destination>, <amount>);
```

If the treasury is a Safe, this goes through Safe UI as an "ERC20
transfer" tx — straightforward.

### Rotate resolver / arbiter

Resolver and arbiter rotation works the same way as admin
rotation:

```
escrow.grantRole(RESOLVER_ROLE, <NEW_RESOLVER>);
escrow.revokeRole(RESOLVER_ROLE, <OLD_RESOLVER>);
```

The Safe (admin) signs both. Use this when rotating a hot resolver
key — e.g. after a suspected compromise, or migrating from EOA to
Turnkey.

## What's the same vs Squads

| Ops concern               | Solana / Squads                | Base / Safe                              |
| ------------------------- | ------------------------------ | ---------------------------------------- |
| Pre-mainnet threshold     | 2-of-3, three Ledgers          | 2-of-3, three Ledgers                    |
| Cold-storage threshold    | 3-of-5                         | 3-of-5                                   |
| Hardware wallets          | Ledger Solana app              | Ledger Ethereum app                      |
| Admin rotation surface    | _Needs `update_authority`_ ⚠️  | OpenZeppelin `AccessControl` (works now) |
| Resolver/arbiter rotation | `update_config(resolver, …)`   | `grantRole` / `revokeRole`               |
| Per-tx approval UI        | https://squads.so              | https://app.safe.global                  |
| Treasury withdrawal       | SPL transfer signed by vault   | ERC20 transfer signed by Safe            |

The Solana side currently has a gap: `update_authority` is not
implemented, so admin rotation requires a contract change. Tracked
as `cozy-bet-aom` — must land before the Squads Phase 1 migration.
EVM has no equivalent gap (AccessControl ships with all the needed
primitives).

## Open follow-ups

- `cozy-bet-aom` — add `update_authority` to the Solana program
  before mainnet.
- A `scripts/rotate-admin.ts` helper that takes `--chain base|solana`
  + `--new-admin <addr>` and runs the right sequence on either
  chain (cast/foundry on Base, Anchor `update_*` on Solana).
