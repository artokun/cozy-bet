# Base Sepolia deploy reference

The v2 escrow Solidity contract is now live on Base Sepolia, complementing
the Anchor program on Solana devnet. Bets can settle on either chain — see
the bi-chain dispatcher in `apps/bot/src/chain/`.

## Network

- **RPC:** https://sepolia.base.org
- **Chain ID:** 84532
- **Explorer:** https://sepolia.basescan.org

## Live addresses

| | Address | Notes |
|---|---|---|
| **CozyBetEscrow** | `0xffcC554C4157B9363ab561237e3cc02626775F71` | v2 contract w/ 4-owner treasury, draw, arbiter, per-side fee, termsHash |
| **USDC** (Circle native) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Faucet: https://faucet.circle.com (Base Sepolia) |
| **Resolver / Admin** | `0xB7667b7419bed0f015DC2a56490F7c5E9Cdd4624` | Hot wallet, admin == resolver == arbiter for testnet |
| **Treasury 1** | `0x4Ed9D7BC382e69e262A5415cA52954aAf0ed45d6` | artokun |
| **Treasury 2** | `0x131867e52d0c0c745758254E6F83f4beE4Cb10E9` | unc-cozy |
| **Treasury 3** | `0xA4304Fe0c7eF262747ea4b93de3C587E1080a3b1` | placeholder |
| **Treasury 4** | `0x6974CB63b4eC7f0Ca8D431215A18553f21b94c08` | placeholder |

## Deploy tx

`0x016eac75e3be9d236109a0db8363b4eb899fa1c1f85e0db6e94322dbd0b884e4` (block 40737056).

## Config snapshot

The Solidity constructor immutably sets `treasury_owners` (no per-bet override
needed — admin can rotate via `setTreasuryOwner(idx, newOwner)`). Other
defaults are set in the constructor:

```
defaultFeeBps = 250          // 2.5% per side
minDiscountedFeeBps = 150    // 1.5% per side floor (social-share discount)
arbiterMinFee = 100e6        // $100 USDC at 6 decimals
arbiterFeeBpsOfPot = 100     // 1% of pot
```

Admin can update via `setDefaultFeeBps`, `setMinDiscountedFeeBps`, `setArbiterFeeConfig`.

## Mainnet readiness

Same checklist as `docs/devnet.md` for Solana, but for Base mainnet:
- Generate fresh hot resolver key (don't reuse testnet)
- Replace 4 treasury addresses with real cofounder addresses via `setTreasuryOwner`
- USDC address on Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Migrate admin to a Safe multisig: deploy via https://app.safe.global on Base, set 2-of-3 / 3-of-5; admin transfers `DEFAULT_ADMIN_ROLE` to the Safe via `grantRole(DEFAULT_ADMIN_ROLE, safe) + revokeRole(DEFAULT_ADMIN_ROLE, oldAdmin)`
- Audit (basic 2nd-eye review minimum)
