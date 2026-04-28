/**
 * Test vectors that lock the TS rake helper to the on-chain contract math.
 *
 * Any failure here means rake.ts has drifted from
 * apps/contracts/src/CozyBetEscrow.sol — fix rake.ts (the contract is
 * canonical), then update or add an equivalent assertion in
 * apps/contracts/test/CozyBetEscrow.t.sol so both sides stay in sync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeArbiterFee, computeRake } from "./rake.js";

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

test("default 250+250 bps on a 100 USDC pot — even 4-way split", () => {
  // 50 USDC each side, both default 2.5% bps.
  const r = computeRake({
    amount: USDC(50),
    challengerFeeBps: 250,
    accepterFeeBps: 250,
  });
  assert.equal(r.pot, USDC(100));
  assert.equal(r.standardFee, USDC(2.5));
  assert.equal(r.perOwnerBase, USDC(0.625));
  assert.equal(r.remainder, 0n);
  assert.equal(r.treasuryShare0, USDC(0.625));
  assert.equal(r.treasuryShare1to3, USDC(0.625));
  assert.equal(r.winnerPayout, USDC(97.5));
});

test("one side discounted (250 / 150 bps) — combined fee = 200 bps of one stake", () => {
  // Challenger discounted via /share, accepter at default.
  const r = computeRake({
    amount: USDC(50),
    challengerFeeBps: 150,
    accepterFeeBps: 250,
  });
  // 50 * 150/10000 + 50 * 250/10000 = 0.75 + 1.25 = 2.00
  assert.equal(r.standardFee, USDC(2));
  assert.equal(r.perOwnerBase, USDC(0.5));
  assert.equal(r.winnerPayout, USDC(98));
});

test("both sides discounted (150 + 150 bps) — minimum rake", () => {
  const r = computeRake({
    amount: USDC(50),
    challengerFeeBps: 150,
    accepterFeeBps: 150,
  });
  assert.equal(r.standardFee, USDC(1.5));
  assert.equal(r.perOwnerBase, USDC(0.375));
  assert.equal(r.winnerPayout, USDC(98.5));
});

test("integer-division remainder routes to slot 0", () => {
  // Pick a pot where (amount * cBps + amount * aBps) / 10000 doesn't
  // cleanly divide by 4. Stake = 1 atom per side, both at 250 bps:
  //   standardFee = (1 * 250 + 1 * 250) / 10000 = 0  (truncated)
  // Try a stake that produces a small but nonzero, non-multiple-of-4 fee:
  //   amount = 7, bps = 250 each
  //   standardFee = (7 * 250 + 7 * 250) / 10000 = 3500 / 10000 = 0  (still truncated)
  // Need a larger amount. Stake = 401 atoms per side, 250+250 bps:
  //   standardFee = (401 * 250 + 401 * 250) / 10000 = 200500 / 10000 = 20
  //   perOwnerBase = 20 / 4 = 5, remainder = 0
  // Tweak to get a remainder. 403 atoms per side:
  //   standardFee = (403 * 500) / 10000 = 201500 / 10000 = 20  (still 20)
  // 421 per side: 210500 / 10000 = 21
  //   perOwnerBase = 21 / 4 = 5, remainder = 1 ✓
  const r = computeRake({
    amount: 421n,
    challengerFeeBps: 250,
    accepterFeeBps: 250,
  });
  assert.equal(r.standardFee, 21n);
  assert.equal(r.perOwnerBase, 5n);
  assert.equal(r.remainder, 1n);
  assert.equal(r.treasuryShare0, 6n); // 5 + 1
  assert.equal(r.treasuryShare1to3, 5n);
  // Sum of all 4 owners' shares = standardFee, exactly.
  assert.equal(r.treasuryShare0 + 3n * r.treasuryShare1to3, r.standardFee);
});

test("invariant: pot = winnerPayout + standardFee + arbiterFee", () => {
  for (const stake of [USDC(10), USDC(50), USDC(1000), USDC(99999)]) {
    for (const cBps of [150, 200, 250]) {
      for (const aBps of [150, 250]) {
        const r = computeRake({
          amount: stake,
          challengerFeeBps: cBps,
          accepterFeeBps: aBps,
        });
        assert.equal(
          r.pot,
          r.winnerPayout + r.standardFee + r.arbiterFee,
          `failed at stake=${stake} cBps=${cBps} aBps=${aBps}`,
        );
      }
    }
  }
});

test("invariant: 4 owners + slot-0 remainder = standardFee", () => {
  for (const stake of [USDC(7), USDC(123.456789), USDC(1000), 421n]) {
    const r = computeRake({
      amount: stake,
      challengerFeeBps: 250,
      accepterFeeBps: 250,
    });
    assert.equal(
      r.treasuryShare0 + 3n * r.treasuryShare1to3,
      r.standardFee,
      `failed at stake=${stake}`,
    );
  }
});

test("arbiter fee is taken on top of standard fee", () => {
  // Pot = 50000 USDC, both sides default. Arbiter fee = 1% of pot.
  const arbiterFee = computeArbiterFee({ pot: USDC(50000) });
  // 1% of 50000 = 500, well above the 100 floor.
  assert.equal(arbiterFee, USDC(500));
  const r = computeRake({
    amount: USDC(25000),
    challengerFeeBps: 250,
    accepterFeeBps: 250,
    arbiterFee,
  });
  // standardFee = 25000 * 500 / 10000 = 1250
  assert.equal(r.standardFee, USDC(1250));
  assert.equal(r.winnerPayout, USDC(50000 - 1250 - 500));
});

test("computeArbiterFee — small pot hits the $100 floor", () => {
  // 1% of $1000 pot = $10, but floor is $100.
  assert.equal(computeArbiterFee({ pot: USDC(1000) }), USDC(100));
});

test("computeArbiterFee — large pot uses bps-of-pot", () => {
  // 1% of $20000 = $200, beats the $100 floor.
  assert.equal(computeArbiterFee({ pot: USDC(20000) }), USDC(200));
});

test("computeArbiterFee — exactly at the breakeven (10000 USDC pot)", () => {
  // 1% of $10000 = $100 — equal to the floor; either branch returns 100.
  assert.equal(computeArbiterFee({ pot: USDC(10000) }), USDC(100));
});

test("computeArbiterFee — custom config overrides", () => {
  // 50 USDC floor, 5% of pot.
  assert.equal(
    computeArbiterFee({
      pot: USDC(1000),
      arbiterMinFee: USDC(50),
      arbiterFeeBpsOfPot: 500,
    }),
    USDC(50), // 5% of 1000 = 50, equal to floor
  );
  assert.equal(
    computeArbiterFee({
      pot: USDC(2000),
      arbiterMinFee: USDC(50),
      arbiterFeeBpsOfPot: 500,
    }),
    USDC(100), // 5% of 2000 = 100, beats 50 floor
  );
});
