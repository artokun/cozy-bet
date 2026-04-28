# cozy-bet

Two-party USDC escrow with mutual-consent or arbiter resolution, fronted by
a Discord bot. Status: testnet-only.

> This README is written for **an agent or engineer absorbing this code into
> another codebase** (saybet, in our case). It walks the Solidity contract
> first, then the rake / multisig story, then the tests and live-testnet
> evidence that the design works. Bot + web details are in `CLAUDE.md`.

## Live deployments

| Chain                     | Address                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| Base Sepolia escrow       | [`0xffcC554C4157B9363ab561237e3cc02626775F71`](https://sepolia.basescan.org/address/0xffcC554C4157B9363ab561237e3cc02626775F71) |
| Base Sepolia USDC         | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`                         |
| Solana devnet (reference) | `nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt`                        |

The Solidity escrow is the canonical implementation now; the Solana
Anchor program is preserved as a parallel reference under
`apps/program/`. New work goes on Base.

> **Heads-up on committed keypairs.** `apps/program/target/deploy/escrow-keypair.json`
> is the *program-ID keypair* (its pubkey IS the program address) — committed so
> anyone can rebuild against the same devnet program ID. It is **not** the upgrade
> authority. The upgrade authority is a separate keypair (`./keys/bot-resolver.json`,
> gitignored). Going to mainnet must use a freshly generated program keypair —
> never reuse this one. EVM private keys are never committed; only the public
> contract / treasury / USDC addresses appear in tracked `.env.devnet` etc.

## The contract — `apps/contracts/src/CozyBetEscrow.sol`

382 lines. OpenZeppelin `AccessControl` + `ReentrancyGuard`, single-token
ERC20 escrow. The whole bet lifecycle:

```
       initializeBet                deposit (×2)
None ────────────────► Pending ─────────────────► Funded
                          │                          │
                          │ refund                   ├─ resolve(winner) ──► Resolved
                          │                          ├─ draw            ──► Drawn
                          ▼                          ├─ arbiterResolve  ──► Resolved
                       Refunded                      └─ refund          ──► Refunded
```

Per-bet state (`mapping(uint256 => Bet)`):

```solidity
struct Bet {
    uint256 amount;          // each side's stake (pot = 2× amount)
    address challenger;
    address accepter;
    uint16  challengerFeeBps; // independent per side; default 250
    uint16  accepterFeeBps;   // independent per side; default 250
    bool    challengerDeposited;
    bool    accepterDeposited;
    BetStatus status;
    address winner;
    bytes32 termsHash;        // keccak256 of canonical bet terms (off-chain LLM disambig)
}
```

Three roles, granted at deploy time and rotatable via OZ AccessControl:

| Role                | Holder (testnet)                | Purpose                            |
| ------------------- | ------------------------------- | ---------------------------------- |
| `DEFAULT_ADMIN_ROLE`| `artokun` (`0x4Ed9…d45d6`)      | Mutate config + grant/revoke roles |
| `RESOLVER_ROLE`     | bot resolver (`0xB766…4624`)    | Init / resolve / draw / refund / fee discount |
| `ARBITER_ROLE`      | `artokun`                       | `arbiterResolve` (force-decide a Funded bet) |

Mainnet plan: `DEFAULT_ADMIN_ROLE` migrates to a Safe multisig before any
real money. Resolver stays hot (must auto-respond to Discord events).
Arbiter migrates to a small admin team — see "Multisig" below.

## The rake (treasury fee split)

Per-side fee, defaulting to 250bps each (2.5% total of pot). Each
side's bps is independent — one side can buy down their fee to 150bps
via `/share` (post the bet on X with `#cozybet`) without the other
side benefitting. The fee is taken at `resolve` / `arbiterResolve`
time and split four ways across `treasuryOwners[0..3]`.

The math (`_resolveCommon` in `CozyBetEscrow.sol:336`):

```solidity
uint256 pot         = b.amount * 2;
uint256 standardFee = (b.amount * b.challengerFeeBps
                    +  b.amount * b.accepterFeeBps) / 10000;
uint256 payout      = pot - standardFee - arbiterFee;

// 4-way split with the integer-division remainder routed to slot 0
uint256 perOwner   = standardFee / 4;
uint256 remainder  = standardFee - perOwner * 4;
for (uint256 i = 0; i < 4; i++) {
    uint256 share = perOwner + (i == 0 ? remainder : 0);
    if (share > 0) token.safeTransfer(treasuryOwners[i], share);
}
token.safeTransfer(winner, payout);
```

Worked examples (both sides at default 250bps, pot = 100 USDC = 50+50):

| Scenario                              | Pot   | Standard fee | Each owner | Winner pays out |
| ------------------------------------- | ----- | ------------ | ---------- | --------------- |
| Both default (250+250 bps)            | 100   | 2.50         | 0.625      | 97.50           |
| Challenger shared, accepter didn't    | 100   | 2.00         | 0.50       | 98.00           |
| Both shared (150+150 bps)             | 100   | 1.50         | 0.375      | 98.50           |
| Arbiter resolution (1% pot, ≥ $100)   | 100   | 2.50 + 100 floor → arbiter takes $100 fee | — | — — pot too small, reverts `PotTooSmallForArbiter` |
| Arbiter on a 50k pot                  | 50000 | 1250 (2.5%)  | 312.5      | 50000 − 1250 − 500 = 48250 |

Treasury-owner roster (committed at `docs/treasury-owners.md`):

| Slot | Owner       | Address                                      |
| ---- | ----------- | -------------------------------------------- |
| 1    | artokun     | `0x4Ed9D7BC382e69e262A5415cA52954aAf0ed45d6` |
| 2    | unc-cozy    | `0x131867e52d0c0c745758254E6F83f4beE4Cb10E9` |
| 3    | placeholder | `0xA4304Fe0c7eF262747ea4b93de3C587E1080a3b1` |
| 4    | placeholder | `0x6974CB63b4eC7f0Ca8D431215A18553f21b94c08` |

Slots 3 + 4 are testnet keypairs that need to be replaced with real
wallets (Coinbase Smart Wallet recommended) before mainnet.

Rotation is one tx per slot, `DEFAULT_ADMIN_ROLE` only:

```solidity
escrow.setTreasuryOwner(uint256 index, address newOwner);
```

## Multisig story

The contract uses OpenZeppelin's `AccessControl`, so multisig support
is implicit — any role can be granted to a Safe address, and the Safe
just needs to satisfy its own quorum to call into the escrow. No
contract changes required to bring a multisig online.

**Three layered multisig migrations**, in order of when they should
happen on mainnet:

1. **`DEFAULT_ADMIN_ROLE` → Safe multisig.** Any setting that isn't
   per-bet (`setDefaultFeeBps`, `setArbiterFeeConfig`, `setTreasuryOwner`,
   role grants/revokes) routes through this role. Highest impact —
   migrating it to a 2-of-3 (or 3-of-5) Safe is the day-zero ask.
   Runbook: `docs/safe-multisig.md`.

2. **`ARBITER_ROLE` → small admin team multisig.** Currently held by
   one address. Arbiter resolutions skim `max($100, 1% of pot)` from
   the pot, so the role can extract value if compromised. A 2-of-N
   multisig of trusted humans is the right model.

3. **Treasury owner slots → individual Safes per recipient (optional).**
   Each `treasuryOwners[i]` is just an address that receives 0.625% of
   each fee; they don't have any contract-level powers. Owners who
   want self-custody can each route their slot to their own Safe.

`RESOLVER_ROLE` stays a hot wallet — it has to auto-sign in response
to Discord events. It's gated by what it *can* do (init / resolve /
draw / refund / fee-discount only — never withdraw), so worst-case
compromise costs picking the wrong winner on existing bets, not
draining the escrow.

Additional hardening on mainnet: deploy the contract with `DEFAULT_ADMIN_ROLE`
already pointed at the Safe (don't deploy-then-rotate). Rotate
RESOLVER_ROLE to a fresh hot wallet quarterly.

Solana side has the same shape via the program's `update_authority`
instruction (single-step rotation, the current authority signs to
hand off — Squads multisig vault is the recommended target).
Runbook: `docs/squads-multisig.md`.

## Tests — Foundry/Anvil, 40 unit tests, 89% line coverage

```
$ cd apps/contracts && forge test
[…]
Suite result: ok. 40 passed; 0 failed; 0 skipped; finished in 28.88ms
```

Coverage:

| File                       | Lines           | Branches       | Funcs          |
| -------------------------- | --------------- | -------------- | -------------- |
| `src/CozyBetEscrow.sol`    | **89.39%** (118/132) | 65.85% (27/41) | 82.35% (14/17) |

What the suite covers (`apps/contracts/test/CozyBetEscrow.t.sol`, 549 lines):

- **Constructor & config** — zero-token / zero-admin / zero-owner reverts;
  default values; admin-only mutators.
- **Init** — happy path, both overloads (with/without `termsHash`),
  duplicate-id revert, same-participant revert, non-resolver revert,
  zero-amount revert, terms-hash event emission and storage.
- **Deposit** — both-sides-funded transitions to `Funded`; reverts on
  double-deposit, non-participant, and uninitialized bet.
- **Resolve** — happy path with 4-way fee split; remainder lands in
  slot 0; non-resolver / non-participant-winner / not-funded reverts.
- **Draw** — full-stake refund, no fee; not-funded revert.
- **Refund** — both sides refunded; one-sided deposit refunds only
  the depositor; reverts after resolve.
- **Per-side fee discount** — applies discount; floor enforcement
  (can't go below `minDiscountedFeeBps`); monotonic (can't increase);
  per-side math (one side discounted, other not).
- **Arbiter resolution** — `max(min, 1% of pot)` math on small + large
  pots; non-arbiter revert; pot-too-small revert.

## Live testnet evidence — `pnpm testnet:smoke`

Read-only smoke against the deployed contracts; runs in ~1.5s, costs
$0. Verifies the on-chain state matches the values committed in this
repo (program ID, treasury owners, fee config). CI runs this every
6h via `.github/workflows/testnet-smoke.yml`.

```
== Solana devnet ==
  ✓ program account exists  36 bytes
  ✓ config PDA initialized
  ✓ treasury_owners[0..3] match
  ✓ resolver matches
  ✓ default_fee_bps == 250
  ✓ min_discounted_fee_bps == 150
  ✓ arbiter_min_fee == 100e6
  ✓ arbiter_fee_bps_of_pot == 100

== Base Sepolia ==
  ✓ contract has bytecode  8138 bytes
  ✓ treasuryOwners(0..3) match
  ✓ token() matches USDC
  ✓ defaultFeeBps == 250
  ✓ minDiscountedFeeBps == 150
  ✓ arbiterMinFee == 100e6
  ✓ arbiterFeeBpsOfPot == 100
```

For full bet-cycle exercise on testnet (real txs, spends ~$0.05–0.50 of testnet funds):

```bash
pnpm testnet:lifecycle:solana                          # 0.05 SOL
RESOLVER_PRIVATE_KEY=0x... pnpm testnet:lifecycle:base  # 100 USDC + 0.0005 ETH
```

Each lifecycle script runs init → deposit (both sides) → resolve →
asserts on-chain payout amounts and treasury distribution.

## Repo layout — what to absorb

For an integrating agent, these are the load-bearing files in priority order:

```
apps/contracts/
  src/CozyBetEscrow.sol         ← the contract (382 lines, OZ-based)
  test/CozyBetEscrow.t.sol      ← 40 unit tests
  test/MockUSDC.sol             ← test ERC20 (mint/burn)
  script/Deploy.s.sol           ← Foundry deploy script
  foundry.toml + remappings.txt

apps/bot/src/                   ← Discord bot driving the contract
  flows.ts                      ← state machine; chain-agnostic
  chain.ts                      ← dispatcher (solana | base)
  evm.ts                        ← Base adapter (viem-based)
  solana.ts                     ← Solana adapter (anchor)
  watchdog.ts                   ← 5-tick background loop
  locks.ts                      ← TOCTOU lock sentinels

packages/db/src/schema.ts       ← Drizzle schema
packages/shared/src/            ← chain-agnostic types + IDL

scripts/
  testnet-smoke.ts              ← read-only on-chain verification
  testnet-lifecycle-{solana,base}.ts ← full bet-cycle exercise
  rotate-admin.ts               ← multisig handoff helper

docs/
  safe-multisig.md              ← Base/EVM multisig runbook
  squads-multisig.md            ← Solana multisig runbook
  treasury-owners.md            ← roster + slot rotation procedure
  base-sepolia.md               ← Base Sepolia deployment notes
  devnet.md                     ← Solana devnet deployment notes
  positioning.md                ← cozy-bet vs saybet architectural deltas
```

## Patterns worth lifting verbatim

These showed up under load (concurrent Discord users, race conditions,
cross-chain divergence). Skip them at your peril:

- **Per-side fee bps** — independent per participant. Lets one side
  earn a discount without coupling it to the other side. See
  `setFeeBpsForSide` and the `_resolveCommon` math.

- **`termsHash` binding** — every bet's `termsHash` is
  `keccak256(canonical sentence from LLM disambiguation)`. The
  description (verbatim user input), the canonical (LLM output), and
  the on-chain hash are all carried together. A third party reading
  the explorer can verify what the bet was for. The bot pre-flights
  via `/preview-terms`.

- **TOCTOU lock sentinels** — anything that does (read state) → (irreversible
  external call) → (write state) has a race window. We close it via atomic
  conditional UPDATE+returning with a `PENDING:<reason>:<unix-ms>` sentinel
  (see `apps/bot/src/locks.ts` + `flows.ts:claimResolutionLock`). Watchdog
  tick #5 clears stuck locks via the embedded timestamp.

- **Drift checks** — three scripts that fail-fast if upstream artifacts
  diverge from what the bot ships:
  - `apps/program/scripts/check-idl-sync.ts` — Anchor IDL vs `packages/shared`
  - `apps/bot/scripts/check-evm-abi-sync.ts` — Foundry ABI vs hand-rolled bot ABI (handles overloads)
  - `packages/db/scripts/check-schema.ts` — Drizzle schema vs migrations
  All three run as part of `pnpm preflight`.

- **Atomic claim → external call → finalize** — see `applyShareDiscount`
  in `flows.ts`. Same shape needed for any one-shot redemption.

## Build & test (locally)

```bash
# Solidity contract
cd apps/contracts
forge build && forge test                  # 40 tests, ~30ms
forge coverage                             # 89% line coverage

# Solana program
cd apps/program
anchor build && anchor test                # localnet ledger

# Bot + web (TS)
pnpm install
pnpm typecheck                             # bot + web
pnpm test                                  # 79 unit tests across 13 files

# All-in-one pre-PR check
pnpm preflight                             # typecheck + tests + drift checks
```

## Quickstart (run the whole stack locally)

```bash
pnpm install
cp .env.example .env             # fill Discord creds + RPC URLs

# Postgres
pnpm db:up && pnpm db:migrate

# Verify deployed contracts respond as expected (read-only, $0)
pnpm testnet:smoke

# Bot + web
pnpm dev:web                                              # http://localhost:3000
cloudflared tunnel --url http://localhost:3000            # set WEB_PUBLIC_URL
pnpm dev:bot                                              # registers slash commands
```

## Prereqs

- Node 20+, pnpm 9+
- Docker (Postgres)
- **Foundry** (`forge`, `anvil`) — for the Solidity contract
- Rust + `solana-cli` + `anchor-cli` 0.31 — for the Solana reference impl
- `cloudflared` — exposes localhost:3000 so Discord DMs reach it

## Beads issue tracker

This project uses `bd` (beads) for issue tracking. Run `bd prime` for
workflow context. Don't use TodoWrite or markdown TODO lists.
