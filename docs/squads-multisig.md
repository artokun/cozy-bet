# Squads multisig — runbook

cozy-bet's Solana treasury and admin authority migrate from a single hot
wallet to Squads multisigs ahead of mainnet. This file is the ops runbook:
what to set up, when, and how to use it.

> **Status:** testnet only. Single hot resolver wallet today (DEFAULT_ADMIN
> on the program, signer for `resolve` / `draw` / `refund`). Squads setup
> below is the migration plan for **before** the first real money flows.

## Why Squads (not Safe)

Cozy-bet ships on both Solana and Base. For Base the EVM standard is Safe
(safe.global). For Solana we use **Squads** (https://squads.so) — same
mental model, native Solana implementation, supports Ledger via the Solana
app.

Each chain runs its own multisig family; they don't sign each other's
transactions. This document covers Solana / Squads. See the Base runbook
(separate file, TBD) for the Safe equivalent.

## Phase 1 — pre-mainnet (one Squads, 2-of-3)

**When:** before the first deposit of real (mainnet) USDC. Testnet stays
on the single hot wallet — speed matters more than custody safety there.

**Setup:**

1. Three team members each acquire a **Ledger Nano X** with the Solana
   app installed and physically separate locations (different cities
   if possible). Phrase backups stored offline, not on cloud drives.
2. Sign in to https://squads.so on Solana mainnet, create a new
   multisig with `Threshold = 2`, `Members = 3` (the three Ledger
   pubkeys).
3. Note the multisig vault's pubkey — this becomes the new program
   admin and the four-treasury-owners replacement target.
4. Run the on-chain admin rotation:
   - `update_authority(new_authority = <squads-vault-pubkey>)` —
     moves admin off the resolver.
     **⚠️ Status:** the current Solana program does **not** ship
     this instruction yet. Tracked as `cozy-bet-aom` and must land
     before Phase 1 can proceed. EVM side has no equivalent gap
     (OpenZeppelin AccessControl ships with `grantRole` /
     `renounceRole`).
   - `update_config(treasury_owners = [<squads-vault>; 4])` — point
     all four owners at the same vault for now (we'll split them
     in Phase 2). The 4-way split still works mechanically; it's
     just one wallet receiving all four shares.
5. Keep the resolver hot wallet as the **resolver** role only. It can
   call `resolve` / `draw` / `refund` / `arbiter_resolve` /
   `set_fee_bps_for_side` but it cannot rotate authority, change fee
   defaults, or move funds out of the program.

After Phase 1 the resolver wallet's worst-case compromise loses at most
the contention over a single bet's outcome, not access to the treasury.

## Phase 2 — production (hot + cold split)

**When:** treasury balance crosses ~$10k or you onboard a customer who
demands custody hygiene.

**Setup:**

- **Hot operational Squads** — `2-of-3`, ~$1–5k float. Used for ops
  expenses (RPC, infra, test tx top-ups). Same Ledger threshold as
  Phase 1; can be the same multisig from Phase 1 if its balance is
  small.
- **Cold treasury Squads** — `3-of-5`, holds the bulk of fees. Five
  Ledgers across team + advisors. Threshold is high enough that no
  two collocated keys can move funds.
- **Auto-sweep**: a small bot or cron tx that, when the hot Squads
  balance exceeds the threshold, builds a transfer `hot → cold`
  proposal in Squads. Two members approve to execute. Don't try to
  fully automate — the manual approval step is the value.
- Update `update_treasury_owners(new_owners = [<hot>, <cold>, <cold>, <cold>])`
  so 75% of fees flow to cold immediately (one share to hot for
  ops budget, three shares to cold for accumulation).

## Phase 3 — volume (programmatic signing)

**When:** monthly resolves > ~1k, or operator gas costs become a real
ops line item.

The Ledger-flow becomes a bottleneck. Options:

- **Turnkey** (https://turnkey.com) — programmatic Solana signers with
  policy guardrails. Useful for the resolver role specifically: bot
  asks Turnkey to sign with a per-bet allowlist policy. Treasury
  stays on Squads.
- **Squads Programmatic API** — Squads also has SDK paths for
  programmatic submission of pre-approved tx templates. Higher
  trust required.

Don't take this step until Phase 1 + 2 have been running smoothly for
weeks. The hot/cold split is what de-risks; programmatic signing
re-introduces signer-key handling.

## Cheatsheet for routine ops

These commands assume you have `solana-cli` configured and the
`solana-program/cli` admin commands wired up (TBD — currently we
use ad-hoc `pnpm tsx` scripts).

### Read on-chain admin state

```sh
solana program show <PROGRAM_ID> --url https://api.mainnet-beta.solana.com
# look for "Authority"
```

### Rotate admin to Squads vault

Run from a key that currently holds the program authority:

```sh
pnpm tsx scripts/rotate-admin.ts \
  --chain solana \
  --new-admin <SQUADS_VAULT_PUBKEY> \
  --cluster mainnet-beta
```

Status:
- The script is TBD (tracked alongside cozy-bet-aom).
- The on-chain instruction it calls (`update_authority`) is also
  TBD — `cozy-bet-aom` adds it.
- Once both land, this single command rotates the authority. Until
  then, do not run Phase 1 on mainnet.

### Change fee defaults via Squads

1. Squads UI → propose tx → "Custom instruction"
2. Paste IDL-encoded `set_fee_defaults(new_default_bps, new_min_bps)`
3. Other signers approve → execute.

### Withdraw fees from a treasury ATA

Treasury ATAs are SPL token accounts owned by the multisig vault.
Standard SPL transfer signed by the multisig:

1. Squads UI → propose tx → "Token transfer"
2. From: treasury ATA · To: external wallet · Amount: X mUSDC
3. Other signers approve → execute.

## Why not just use the resolver as the only signer?

Even on testnet the resolver-as-admin design has a sharp edge: anyone
who compromises the bot host can rotate admin to themselves and lock
us out. The Phase 1 migration (admin = Squads vault, resolver
demoted to bet-resolution-only) closes that. We do this **before**
real money so we don't have to do an emergency rotation later.

## Open follow-ups

- `cozy-bet-aom` — add `update_authority` to the Solana program.
  This is **load-bearing** for Phase 1. Until it lands, admin
  rotation on Solana is impossible without a program upgrade /
  redeploy.
- `scripts/rotate-admin.ts` shared between both chains (TBD).
- Base side documented separately in `docs/safe-multisig.md`.
