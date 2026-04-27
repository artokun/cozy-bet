# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

Bot + web typecheck:
```bash
pnpm --filter @cozy-bet/bot exec tsc --noEmit
pnpm --filter @cozy-bet/web exec tsc --noEmit
```

Solana program:
```bash
cd apps/program && anchor build                 # rust → bytecode + IDL
anchor test --skip-local-validator --provider.cluster localnet  # against running solana-test-validator
```

Solidity escrow:
```bash
cd apps/contracts && forge build && forge test
```

DB migrations (Postgres on docker port 5433):
```bash
pnpm db:up                                     # start docker
pnpm --filter @cozy-bet/db generate            # after schema.ts changes
pnpm --filter @cozy-bet/db migrate             # apply
```

Verifying both deployed contracts respond as expected (read-only, no funds spent):
```bash
pnpm testnet:smoke
```

Full bet-cycle test on testnet (spends a little testnet money):
```bash
pnpm testnet:lifecycle:solana                  # 0.05 SOL from resolver
RESOLVER_PRIVATE_KEY=0x... pnpm testnet:lifecycle:base  # 100 USDC + ~0.0005 ETH
```

## Architecture Overview

Bi-chain Discord betting bot. Each bet lives entirely on one chain:
- **Solana:** Anchor program at `nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt`
  on devnet. Per-bet PDA + vault, mockUSDC SPL token.
- **Base:** Solidity escrow at `0xffcC554C4157B9363ab561237e3cc02626775F71`
  on Base Sepolia. `mapping(betId => Bet)` storage, real testnet USDC.

Chain dispatch lives in `apps/bot/src/chain.ts` — flows.ts reads
`bet.chain` and routes initialize/resolve/draw/refund/arbiterResolve
to the Solana adapter (`solana.ts`) or EVM adapter (`evm.ts`).

Web app:
- `/link/[sessionId]?chain=solana|base` — wallet linking. Solana uses
  `@solana/wallet-adapter`; Base uses wagmi v3 + Coinbase Smart Wallet.
- `/fund/[betId]` — chain-aware deposit (Anchor on Solana,
  approve+deposit via wagmi on Base).
- `/admin/arbiter-cases` — read-only ops dashboard, gated by
  `ADMIN_API_TOKEN` bearer header.
- `/explorer` — public bet feed.

Bot has a Postgres state machine (Drizzle ORM, schema in
`packages/db/src/schema.ts`):
`Proposed → Accepted → Pending → Funded → Resolved/Drawn/Refunded` plus
`Canceled` and `Disputed`. Migrations are sequential — never edit a
landed migration; add a new one.

Watchdog (`apps/bot/src/watchdog.ts`) runs four ticks per interval:
pending-refund (off by default), 24h+2h deadline nudges, cancel-expirer,
stale-arbiter (admin nudge after 24h unclaimed).

LLM disambig: every `/saybet` runs through Anthropic Claude Haiku 4.5
to convert ambiguous phrasing into a canonical sentence. The keccak256
of that canonical is the on-chain `termsHash` — third parties reading
the explorer can verify what the bet was for.

## Conventions & Patterns

- **Issue tracker:** beads (`bd`). Read `bd prime` once. Don't use
  TodoWrite, TaskCreate, or markdown TODO lists. Don't write
  MEMORY.md files — `bd remember` for persistent knowledge.
- **Bet identifiers:** every bet has a 6-char shortcode (e.g. `K7M2RX`)
  alongside its bigint `id`. User-facing copy uses the shortcode;
  on-chain calls use the bigint.
- **Per-side fee bps:** default 250bps each side, floor 150bps
  (`MIN_DISCOUNTED_FEE_BPS`). `/share` discount drops to 150bps via
  `chainSetFeeBpsForSide`.
- **4-owner treasury:** fees split four ways at resolve time. Configure
  via `update_config` (Solana) or `setTreasuryOwner` (Base). Squads /
  Safe migration runbooks in `docs/`.
- **Chain-agnostic types in flows.ts:** `bet.chain` is `"solana" | "base"`,
  wallets are passed as strings (base58 / 0x-hex), the dispatcher
  parses to native types inside each adapter. Never bake chain
  branching into flows.ts — push it into chain.ts.
- **Idempotent state transitions:** anything driven by external state
  (deposits, on-chain status) reads on-chain truth on every tick.
  Web → bot callbacks are hints, not authority — bot re-fetches.
- **Termshash binding:** description (verbatim) + termsCanonical
  (LLM-disambig) + on-chain termsHash all carry together. Don't break
  this chain — it's the audit story.
- **Slash command file structure:** builders + handlers in
  `apps/bot/src/discord/commands.ts`, dispatcher in
  `apps/bot/src/discord/interactions.ts`. Adding a new command means
  building, registering in `commandDefinitions`, writing the handler,
  and adding a `case` in the router.
