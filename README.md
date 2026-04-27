# cozy-bet

Discord crypto-escrow betting bot. Two users "say bet" in chat; each deposits
USDC into a smart-contract escrow; the winner gets paid out automatically
minus a small treasury fee.

> Bridging online larps with real stakes. (Framing credit: saybet — see
> [`docs/positioning.md`](docs/positioning.md) for the architectural
> deltas.)

**Status:** testnet only.
- Solana devnet program: `nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt`
- Base Sepolia escrow: `0xffcC554C4157B9363ab561237e3cc02626775F71`

## What it does

- `/saybet @user 50 "Lakers win tonight"` opens a challenge.
- The other side clicks Accept; both get a DM link to deposit USDC on
  whichever chain the bet lives on (Solana or Base, picked at create
  time).
- When both deposit, the bet is locked.
- Both sides `/resolve @winner`. Same winner from both → contract pays
  out. Different winners → bet freezes (Disputed) and either side can
  `/requestarbiter` to escalate to an admin.

## Stack

- **Chains:** Solana (Anchor program, SPL token) + Base (Solidity via
  Foundry, ERC20 USDC). Each bet lives entirely on one chain.
- **Bot:** Node 20 + discord.js v14 + TypeScript + Drizzle (Postgres).
- **Web:** Next.js 15 App Router. Solana via @solana/wallet-adapter,
  Base via wagmi v3 + Coinbase Smart Wallet.
- **LLM disambig:** Anthropic Claude Haiku 4.5 — converts ambiguous
  bet phrasing into a canonical sentence bound on-chain via
  keccak256(`termsHash`).
- **Monorepo:** pnpm workspaces.

## Slash commands

**Bet flow**
- `/saybet [@user] <amount> <description> [chain]` — start a challenge
  (omit `@user` for an open bet; `chain` defaults to your preferred).
- `/counter <bet_id> [amount] [description]` — counter-propose before
  either side accepts.
- `/resolve <bet_id> @winner` — claim a winner.
- `/draw <bet_id>` — both agree it's a tie.
- `/cancel <bet_id>` — request mutual cancel (counterparty must agree).
- `/share <bet_id>` + `/confirm-share <bet_id> <tweet_url>` — post on
  X with `#cozybet`, drop your fee bps from 250 → 150.

**Account**
- `/linkwallet [chain]` — link Solana or Base wallet (one-time per chain).
- `/linktwitter <handle>` — register your X handle for share verification.
- `/balance` — your linked wallets + USDC balances.

**Info**
- `/status <bet_id>` — full bet detail with chain badge, claims,
  arbiter state.
- `/mybets` — your active bets.
- `/open-bets` — claimable open bets in this server.
- `/leaderboard [by:won|wagered|winrate]` — server leaderboard.
- `/help` — quick reference.

**Disputes / admin**
- `/requestarbiter <bet_id>` — escalate to an admin (max($100, 1% pot)
  fee from pot).
- `/arbiter-claim` / `/arbiter-review` / `/arbiter-decide` — admin only.
- `/adminresolve` / `/reconcile` / `/preview-terms` — admin only.

## Repo layout

```
cozy-bet/
├── apps/
│   ├── program/          # Anchor program (Solana)
│   ├── contracts/        # Solidity escrow (Base) via Foundry
│   ├── bot/              # discord.js bot + Drizzle DB + watchdog
│   └── web/              # Next.js App Router
├── packages/
│   ├── db/               # Drizzle schema + migrations
│   └── shared/           # IDL + chain-agnostic types
├── docs/
│   ├── positioning.md    # cozy-bet vs saybet
│   ├── squads-multisig.md   # Solana ops runbook
│   ├── safe-multisig.md     # Base ops runbook
│   ├── devnet.md / base-sepolia.md / treasury-owners.md
└── scripts/
    ├── testnet-smoke.ts          # read-only verification
    ├── testnet-lifecycle-solana.ts
    ├── testnet-lifecycle-base.ts
    └── rotate-admin.ts           # multisig handoff
```

## Quickstart (local dev)

```bash
pnpm install
cp .env.example .env             # fill in Discord creds, RPC URLs, etc.

# Postgres
pnpm db:up && pnpm db:migrate

# Verify deployed contracts respond as expected (read-only, no funds spent)
pnpm testnet:smoke

# Bot + web
pnpm dev:web                     # http://localhost:3000
cloudflared tunnel --url http://localhost:3000   # set WEB_PUBLIC_URL
pnpm dev:bot                     # registers slash commands + connects gateway
```

For full bet-cycle exercise on testnet (spends ~$0.05–0.50 of testnet
funds per run):

```bash
RESOLVER_PRIVATE_KEY=0x... pnpm testnet:lifecycle:base    # 100 USDC + 0.0005 ETH
pnpm testnet:lifecycle:solana                              # 0.05 SOL
```

CI runs the smoke test on every push/PR + every 6h to catch drift; see
`.github/workflows/testnet-smoke.yml`.

## Prereqs

- Node 20+, pnpm 9+
- Docker (for Postgres)
- Rust + `solana-cli` + `anchor-cli` 0.31 (for the Solana program)
- Foundry (`forge`) for the Solidity escrow
- `cloudflared` for the dev tunnel that lets Discord DMs reach
  `localhost:3000`

## Conventions

- Issue tracker: **bd (beads)** — see `bd prime` or `CLAUDE.md`. Don't
  use TodoWrite or markdown TODO lists.
- Every bet is bound to its terms via on-chain `termsHash` =
  keccak256(canonical sentence from the LLM). The verbatim user
  description, the canonical, and the hash are all carried together.
- Per-side fee bps. Default 250bps each side. `/share` discount drops
  it to 150bps. Floor 150bps (`MIN_DISCOUNTED_FEE_BPS`).
- 4-owner treasury split. Configurable via `update_config` (Solana) or
  `setTreasuryOwner` (Base).
- Watchdog ticks: pending-refund (off by default), 24h+2h deadline
  nudges, cancel-expirer, stale-arbiter (admin nudge after 24h
  unclaimed).

## Open follow-ups

See `bd ready` for the tracked queue. Key items not yet shipped:
- Discord OAuth login on the web (cozy-bet-xw5) — supersedes the
  bearer-token gate on `/admin/arbiter-cases`.
- Mayan/Squid aggregator widget for cross-chain ingest (cozy-bet-lfh).
- ComfyUI face-swap winner GIFs (cozy-bet-32p) — fallback is the
  static dunk-GIF picker that ships today.
- Multi-currency ingest (deposit ETH/SOL/etc., aggregator quotes to
  USDC) — cozy-bet-b34.
- Side bets / spectator co-betting — cozy-bet-25u.
