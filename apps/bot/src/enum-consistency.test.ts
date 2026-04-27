/**
 * Cross-package enum consistency. Three places define lifecycle values
 * that have to match:
 *
 *   - packages/shared BetStatus / Chain (TypeScript const objects, used
 *     by the bot's Discord-side logic)
 *   - packages/db betStatusEnum / chainEnum (Postgres enums via Drizzle's
 *     pgEnum, used in row types + queries)
 *   - apps/program/programs/escrow/src/lib.rs BetStatus (Anchor enum,
 *     mirrored on-chain — checked indirectly via the IDL)
 *
 * If any drift, behavior diverges silently: the bot might write a state
 * the DB rejects, or the DB might allow a state the bot doesn't handle.
 *
 * This test compares the first two (the Anchor enum check would need
 * the IDL parsing which is heavier; deferred).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BetStatus } from "@cozy-bet/shared";
import { betStatusEnum, chainEnum } from "@cozy-bet/db";

test("BetStatus values match betStatusEnum (db) values", () => {
  const shared = new Set(Object.values(BetStatus));
  // pgEnum exposes enumValues as a readonly array.
  const db = new Set(betStatusEnum.enumValues);
  const sharedOnly = [...shared].filter((v) => !db.has(v));
  const dbOnly = [...db].filter((v) => !shared.has(v));
  assert.deepEqual(
    sharedOnly,
    [],
    `BetStatus has values missing from db enum: ${sharedOnly.join(", ")}`,
  );
  assert.deepEqual(
    dbOnly,
    [],
    `db enum has values missing from BetStatus: ${dbOnly.join(", ")}`,
  );
});

test("chainEnum (db) is exactly { solana, base }", () => {
  // The chain enum is also referenced indirectly by the bot's `Chain`
  // type alias (apps/bot/src/chain.ts). If a third chain is ever added,
  // every dispatcher branch needs an update; lock in the current set.
  assert.deepEqual([...chainEnum.enumValues].sort(), ["base", "solana"]);
});
