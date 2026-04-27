# Positioning

> **cozy-bet is the version saybet wanted to be.** Same idea — bridging
> online larps with real stakes — built on a non-custodial, smart-contract
> escrow instead of trusted operator buckets.

The "bridging online larps with real stakes" framing comes from saybet.
Credit where due.

## What's different

| Concern              | Saybet                                   | cozy-bet                                          |
| -------------------- | ---------------------------------------- | ------------------------------------------------- |
| Custody              | Operator-held buckets per chain          | Non-custodial — funds in per-bet PDA / contract   |
| Multi-chain          | Manual + CCTP rebalances run by operator | Mayan / Squid aggregator (burn-and-mint via CCTP) |
| Trust model          | Trust the operator not to rug            | Trust the contract — operator can't move funds    |
| Terms binding        | Off-chain DB only                        | EIP-712 typed-data sigs + on-chain `termsHash`    |
| Dispute path         | Operator-mediated                        | On-chain `arbiterResolve` with public fee + audit |
| Regulatory posture   | Money-transmitter risk                   | No funds in operator's custody → much lower risk  |

## Why this matters

- **No rug-pull surface.** The bot's resolver wallet has authority to call
  `resolve` / `draw` / `refund` / `arbiter_resolve` — but never to drain
  vaults to itself. Worst case the bot is compromised, it picks the wrong
  winner; it can't steal the pot.
- **Auditable arbiter fees.** When a bet is escalated, the contract
  enforces `max($100, 1% of pot)` as the arbiter fee, paid out of the pot
  before settlement. No hidden cuts; participants see the exact fee in
  the bet card before requesting an arbiter.
- **Lower regulatory exposure.** We never hold user funds. The operator
  is a relayer + decision-router; the smart contract is the escrow. This
  removes most money-transmitter posture concerns we'd otherwise carry.
- **Self-evident terms.** Every bet's `termsHash` is the keccak256 of the
  LLM-disambiguated canonical sentence. The user-visible description, the
  canonical, and the on-chain hash are bound together — a third party
  reading the explorer can verify what the bet was for.

## Architectural family tree

Saybet evaluated three smart-contract shapes for its Phase 3:

- **(A)** Shared escrow with `mapping(betId => Bet)` ← recommended
- **(B)** EIP-1167 minimal-proxy clones per bet
- **(C)** Hybrid vault + per-bet ERC-721 terms NFT

cozy-bet shipped (A) on both chains: a single program / contract per
chain with a `bets[betId]` storage layout. PDAs (Solana) and the
`bets` mapping (Solidity) carry both bet state and the per-side fee
schedule. This is what saybet would have looked like if it had been
greenfielded today.

## What stays the same

- Two-party USDC stakes — symmetric, no oracle.
- LLM disambiguation up front so terms are unambiguous before deposit.
- Counter-proposal / mutual cancel / draw-claim flows kept as-is.
- Discord-first UX with the web app for wallet-link and deposit only.

## What's new on top

- **Bi-chain settlement.** A bet is fully on Solana _or_ Base. Users
  pick at `/saybet` time; the cozy-bet bot routes via a chain
  dispatcher (`apps/bot/src/chain.ts`) to either the Anchor program
  or the Solidity escrow.
- **Per-side fee bps.** Each side's fee can be reduced independently
  (e.g. for share-on-X discounts), down to a 150bps floor. Default is
  250bps each.
- **4-owner treasury split.** Fees are split four ways at resolve
  time so operator + community + ops + audit can sit in different
  multisigs.
- **Deadline + watchdog nudges.** 24h / 2h reminders before the
  deadline; cancel-request expirer.
- **Reliability scores.** Users earn a public reliability rating
  based on past resolve behavior.
- **Arbiter pipeline.** `/requestarbiter` → `/arbiter-claim` → DM
  evidence collection → `/arbiter-review` → `/arbiter-decide` calling
  `arbiterResolve` on-chain.

## Roadmap deltas vs saybet

- **Multi-currency ingest** is a 2026Q3 lift (deposit ETH/SOL/etc.,
  aggregator quotes to USDC, deposit the converted amount). Saybet's
  approach was operator-rebalanced; ours is aggregator-routed.
- **Squads / Safe multisig** for the treasury wallets. Saybet ran a
  hot operator wallet; we'll move treasury to multisig before
  mainnet.
- **EIP-712 signed resolve confirmation** is a Phase 3+ optimization;
  current Discord-driven resolve already sidesteps user gas.

## Tech choices

- **Solana program**: Anchor 0.31, deployed at
  `nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt` on devnet.
- **Base contract**: Solidity 0.8.x via Foundry, deployed at
  `0xffcC554C4157B9363ab561237e3cc02626775F71` on Base Sepolia.
- **Bot**: Node 20 + discord.js v14 + Drizzle (Postgres) + viem +
  @coral-xyz/anchor.
- **Web**: Next.js 15 App Router + wagmi v3 + @solana/wallet-adapter,
  Coinbase Smart Wallet by default for Base.
- **LLM**: Anthropic Claude Haiku 4.5 for disambig.
