import { strict as assert } from "node:assert";
import { test } from "node:test";
import { serializeForUser, _resetUserMutex } from "./userMutex.js";

test("serializes tasks for the same user", async () => {
  _resetUserMutex();
  const order: string[] = [];
  const t1 = serializeForUser("alice", async () => {
    await new Promise((r) => setTimeout(r, 50));
    order.push("a1");
  });
  const t2 = serializeForUser("alice", async () => {
    order.push("a2");
  });
  await Promise.all([t1, t2]);
  assert.deepEqual(order, ["a1", "a2"]);
});

test("does not serialize across users", async () => {
  _resetUserMutex();
  const order: string[] = [];
  const t1 = serializeForUser("alice", async () => {
    await new Promise((r) => setTimeout(r, 50));
    order.push("alice");
  });
  const t2 = serializeForUser("bob", async () => {
    order.push("bob");
  });
  await Promise.all([t1, t2]);
  // bob doesn't wait for alice
  assert.equal(order[0], "bob");
});

test("returned promise rejects when inner task throws, but queue continues", async () => {
  _resetUserMutex();
  let secondRan = false;
  const t1 = serializeForUser("carol", async () => {
    throw new Error("boom");
  });
  const t2 = serializeForUser("carol", async () => {
    secondRan = true;
  });
  await assert.rejects(t1, /boom/);
  await t2;
  assert.equal(secondRan, true);
});
