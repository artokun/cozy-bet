# Devnet deploy reference

The v2 escrow program is live on Solana devnet. This file records the
addresses + tx hashes so anyone (or future-me) can pick up where we left off.

## Network: Solana devnet

- **RPC:** https://api.devnet.solana.com
- **Explorer:** https://explorer.solana.com/?cluster=devnet

## Live addresses

| | Address | Notes |
|---|---|---|
| **Program ID** | `nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt` | Same ID as localnet (program keypair shared). |
| **Upgrade authority** | `BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7` | Bot resolver wallet — controls program upgrades. |
| **Config PDA** | derived | `seeds = ["config"]`. `program.account.config.fetch(configPda)` |
| **mockUSDC mint** | `C9zcTJjJTs4HHWrVFfuc5pP1BbYj8dYeM8mfHNMduVKp` | Created by `scripts/mint-mock-usdc.ts`. Authority = bot resolver, so we can mint more freely. 6 decimals. |
| **Resolver wallet** | `BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7` | Signs initialize_bet / resolve / draw / refund. Hot wallet, key in `keys/bot-resolver.json`. |
| **Arbiter wallet** | same as resolver | For MVP. Fork into separate keypair for mainnet. |
| **Treasury owners 1–4** | see `.env.devnet` | Placeholder Solana keypairs. Swap for real cofounder addresses pre-mainnet via `update_config`. |

## Deploy txs

| Op | Tx |
|---|---|
| `anchor deploy` | `51JjuvaH98RYxXLEz76BtkEcfNBAzvbCTYndcFdjxxvBfvxGXwq5kQrUatL7yDV1rbRDuPFY55qyqfs7K6Rw8rQr` |
| mockUSDC mint create | (in faucet logs) — see `scripts/mint-mock-usdc.ts` output |
| `initialize_config` | `42JmggNgfC96dwNEGP3Mpt6CJKvAMGXTgPSuUMu5fEdbF3kwN4hCKd68Zs4SES9kerZpFF3CJETG9hz89XoDGSYh` |

## Config snapshot

```
treasury_owner_1: 8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7iS
treasury_owner_2: GjGeCuRyDjLbcPLxXkBPgj8bDZZqvg3pUhfSixUavnPo
treasury_owner_3: FqfuSY2y2TeAqvidFsj2yozrs8fa47yFRSV3C1Cv256g
treasury_owner_4: 5ZaM72ERr5QgffzcogpFNACWg1YHS8mMsMM8f3UCMQZ7
resolver:        BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7
arbiter:         BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7
default_fee_bps: 250
min_discounted_fee_bps: 150
arbiter_min_fee: 100_000_000   (= $100 USDC at 6 decimals)
arbiter_fee_bps_of_pot: 100    (= 1%)
```

## Running against devnet

```bash
set -a && source .env.devnet && set +a
# fill in DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID / DISCORD_TEST_GUILD_ID
# (re-export them after pasting)

pnpm db:up && pnpm db:migrate
pnpm --filter @cozy-bet/bot register     # register slash commands
pnpm dev:web &                            # http://localhost:3000
cloudflared tunnel --url http://localhost:3000  # paste URL into WEB_PUBLIC_URL
pnpm dev:bot
```

## Mainnet readiness — what changes

- Generate fresh resolver + arbiter keypairs (don't reuse devnet hot keys).
- Replace 4 treasury owner addresses with real cofounder addresses via
  `escrow.updateConfig(...)` admin call.
- Replace mockUSDC mint with **Circle's native USDC on Solana mainnet**:
  `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. Update `MOCK_USDC_MINT`
  env var (rename to `BET_USDC_MINT` for clarity at that point).
- Pre-fund resolver with mainnet SOL — ~0.5 SOL covers many thousand resolves.
- Migrate DEFAULT_ADMIN role to a Squads multisig (cozy-bet-pi2).
- Run the contract through an audit (or at minimum a 2nd-eye review).

## Resolver wallet — devnet balance after deploy

~2.23 SOL remaining (started at 5, deploy + setup consumed ~2.77). Plenty for
months of testnet operations. Top up via https://faucet.solana.com if it gets
low.
