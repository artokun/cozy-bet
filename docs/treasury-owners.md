# Treasury owner roster

Each owner receives **0.625%** of every bet's standard fee (4 × 0.625% = 2.5%
total, default). The contract distributes evenly on every `resolve` /
`arbiterResolve` call.

These addresses are committed *only here* (not in `.env`, which is gitignored).
The on-chain truth lives in `CozyBetEscrow.treasuryOwners(0..3)` after deploy.

## Roster (Base Sepolia + planned mainnet)

| Slot | Owner | Address | Source |
|---|---|---|---|
| 1 | **artokun** | `0x4Ed9D7BC382e69e262A5415cA52954aAf0ed45d6` | personal wallet |
| 2 | **unc-cozy** | `0x131867e52d0c0c745758254E6F83f4beE4Cb10E9` | personal wallet |
| 3 | _placeholder_ | `0xA4304Fe0c7eF262747ea4b93de3C587E1080a3b1` | testnet keypair, swap before mainnet |
| 4 | _placeholder_ | `0x6974CB63b4eC7f0Ca8D431215A18553f21b94c08` | testnet keypair, swap before mainnet |

## How to swap an owner

1. New owner generates an EVM address (Coinbase Smart Wallet recommended)
2. Admin calls `escrow.setTreasuryOwner(slotIndex, newAddress)` — single tx,
   only `DEFAULT_ADMIN_ROLE` can do this
3. Update this file + the `TREASURY_OWNER_<n>` env var

## Roles other than treasury

- **DEFAULT_ADMIN_ROLE**: artokun (`0x4Ed9…d45d6`) — controls config + role grants. Should migrate to a Safe multisig before mainnet.
- **RESOLVER_ROLE**: bot resolver (`0xB766…4624`) — automated signer, hot wallet.
- **ARBITER_ROLE**: artokun for MVP. Will expand to admin team for mainnet.
