# cozy-bet

Discord crypto-escrow betting bot — Solana devnet MVP.

Two users "say bet" in Discord; each deposits mockUSDC into an Anchor escrow; winner gets paid out automatically (minus 2.5% treasury fee).

## Stack

- **Chain:** Solana devnet (Anchor program, SPL token)
- **Bot:** Node.js + discord.js v14 + TypeScript
- **Web:** Next.js App Router + @solana/wallet-adapter
- **DB:** Postgres + Drizzle ORM
- **Monorepo:** pnpm workspaces

## Prereqs

- Node 20+, pnpm 9+
- Docker (for Postgres)
- Rust + `solana-cli` + `anchor-cli` 0.31
- `cloudflared` (for exposing the Next.js app to Discord DMs during local dev)

## First-run

```bash
pnpm install
cp .env.example .env                    # fill in Discord creds + keypair paths
pnpm tsx scripts/generate-keys.ts       # writes ./keys/*.json, prints pubkeys
# — airdrop 5 devnet SOL to each printed pubkey via solfaucet.com —
pnpm db:up && pnpm db:migrate
pnpm program:build && pnpm program:deploy
pnpm tsx scripts/mint-mock-usdc.ts      # creates mockUSDC mint + ATAs, prints MOCK_USDC_MINT
pnpm dev:web                            # http://localhost:3000
cloudflared tunnel --url http://localhost:3000    # paste URL into WEB_PUBLIC_URL
pnpm dev:bot                            # registers slash commands + connects gateway
```

See `plans/let-s-build-it-*.md` for the full architecture.
