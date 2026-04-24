# cozy-bet — local setup

Everything up to the point of deploying the program is done. This doc lists the **remaining external steps** you need to take, then the exact commands to finish.

---

## What's already built

- Monorepo (pnpm workspaces): `apps/{bot,web,program}`, `packages/{db,shared}`, `scripts/`
- Anchor escrow program compiled (`apps/program/target/deploy/escrow.so`)
  - Program ID: `nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt`
  - IDL + TS types exported to `packages/shared/src/`
- Postgres running in Docker on port **5433** (note: your host has a local Postgres on 5432). Schema migrated.
- Next.js wallet UI ready (link + fund + bet-status routes)
- Discord bot ready (slash commands: `/saybet`, `/mybets`, `/resolve`, `/cancel`, `/linkwallet`; Accept/Decline buttons; web callbacks; on-chain initializeBet/resolve/refund flows).
- Bot has an optional guild allowlist (`DISCORD_GUILD_ALLOWLIST`) and user allowlist (`USER_ALLOWLIST_ENABLED=true` + `allowlist` DB table) for closed-group posture.

## What you still need to do

### 1. Devnet SOL (blocks deploy)
CLI faucet was rate-limited when I tried. Use the web faucet:

- https://faucet.solana.com
- Airdrop **5 SOL** each to:
  - `BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7` (bot resolver + deployer)
  - `8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7iS` (treasury — needs a tiny bit for ATA rent)
  - Your own Solflare devnet wallet (for testing as challenger/accepter)
  - (Optional) a second test wallet you control, to drive the accepter side

### 2. Discord app + bot token
- Create an app: https://discord.com/developers/applications → New Application (any name).
- **Bot** tab → "Reset Token" → copy token
- **General Information** tab → copy Application ID
- **OAuth2 → URL Generator**: scopes = `bot`, `applications.commands`; bot permissions = `Send Messages`, `Embed Links`, `Read Message History` (permission integer = `83968`)
- Open the generated URL → invite to a test server where you have two accounts
- Copy the test server's **Guild ID** (Settings → Advanced → Developer Mode in Discord → right-click server → Copy ID)

### 3. Fill in .env
```bash
cp .env.example .env
```
Then edit `.env` with:
- `DISCORD_BOT_TOKEN=` (from above)
- `DISCORD_APPLICATION_ID=` (from above)
- `DISCORD_TEST_GUILD_ID=` (guild ID)
- Leave `MOCK_USDC_MINT=` blank for now — step 5 fills it.

---

## Finish commands (run in order once SOL + Discord are ready)

### 4. Deploy the program to devnet
```bash
cd apps/program
anchor deploy --provider.cluster devnet
```
Writes out the deploy tx. Program ID in `.env` is already correct.

### 5. Create mockUSDC mint + fund test wallets
Pass the wallet pubkeys you want mUSDC minted to (your Solflare + any test accounts):
```bash
cd /Users/art/code/cozy-bet
pnpm tsx scripts/mint-mock-usdc.ts <solflare_pubkey> <test_wallet_2_pubkey>
```
Paste the printed `MOCK_USDC_MINT` into `.env`.

### 6. Initialize program config on-chain
```bash
pnpm tsx scripts/init-config.ts
```
Sets treasury + resolver + fee_bps=250 on the Config PDA.

### 7. Register Discord slash commands
```bash
pnpm --filter @cozy-bet/bot register
```
Commands show up instantly in your test guild.

### 8. Start services
In three terminals:

```bash
# terminal 1 — Next.js wallet UI
pnpm dev:web

# terminal 2 — cloudflared tunnel (paste the URL into WEB_PUBLIC_URL in .env and kill+restart the bot)
cloudflared tunnel --url http://localhost:3000

# terminal 3 — Discord bot
pnpm dev:bot
```

### 9. Run the bet flow
From your main Discord account in the test server:
```
/linkwallet      → DMs a link to sign-message with Solflare
/saybet user:@SecondAccount amount:10 description:"I'll win at 1v1"
```
Second account clicks Accept → both get fund links DM'd → both deposit → channel posts "🔒 Bet Locked" → both run `/resolve bet_id:<id> winner:@Me` → on-chain payout.

**Slash command reference:**
- `/saybet user amount description` — challenge someone
- `/mybets` — list your active bets
- `/resolve bet_id winner` — record your winner claim; resolves when both sides match
- `/cancel bet_id` — refund (mutual cancel)
- `/linkwallet` — get a sign-message link to register your wallet
- `/adminresolve bet_id winner` *(admin only)* — force-resolve a disputed bet
- `/reconcile bet_id` *(admin only)* — re-sync a bet's DB state from on-chain truth

Set `ADMIN_DISCORD_IDS` in `.env` (comma-separated) to enable admin commands.

### 10. Verify on-chain
Every tx signature is logged in the Discord messages and stored in the DB's `bet_events` table. Inspect at:
- https://explorer.solana.com/address/nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt?cluster=devnet

---

## Local smoke test (already done, repeatable)

Everything has been validated against a local test-validator. To re-run:
```bash
# terminal 1
solana-test-validator --reset
# terminal 2
solana airdrop 100 BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7 --url http://127.0.0.1:8899
solana airdrop 100 8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7iS --url http://127.0.0.1:8899
cd apps/program && anchor deploy --provider.cluster localnet
cd apps/program && ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  ANCHOR_WALLET=../../keys/bot-resolver.json anchor test --skip-local-validator --skip-deploy --skip-build
cd ../..
set -a && source .env.localnet && set +a
pnpm tsx scripts/e2e-smoke.ts
pnpm tsx scripts/e2e-bot-flows.ts
pnpm tsx scripts/e2e-dispute.ts
```

All scripts pass (Anchor TS: 5/5, e2e-smoke: 4/4 scenarios, e2e-bot-flows: full resolve path, e2e-dispute: dispute + admin override). Winner balance lands on 1047.5 mUSDC exactly in both resolve paths.

## Known follow-ups

- Automated sports-API resolution — not in MVP; all bets resolve via mutual consent + admin override on dispute.
- Mainnet readiness: swap `MOCK_USDC_MINT` for real USDC, run a contract audit, add KYC/geo-blocking middleware if opening to non-friends.
- HMAC on bot ↔ web API (`BOT_API_SECRET` is in .env.example but not yet enforced).
- Timeout-based auto-refund watchdog.
