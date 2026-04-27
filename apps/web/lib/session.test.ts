/**
 * Pure unit tests for session.ts sign/verify + isAdminId. Runs via
 * `node --import tsx --test apps/web/lib/session.test.ts` — no test
 * framework, just node:test built-in (Node 20+).
 *
 * Skips the `readSession` path (which calls next/headers and would
 * need a Next.js test harness).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signSession,
  verifySession,
  isAdminId,
  freshExpiry,
  sanitizeNext,
  type SessionPayload,
} from "./session";

const SECRET = "a".repeat(64);

test("signSession + verifySession round-trip", () => {
  const payload: SessionPayload = {
    discordId: "123456789",
    username: "alice",
    expiresAt: Date.now() + 60_000,
  };
  const cookie = signSession(payload, SECRET);
  const verified = verifySession(cookie, SECRET);
  assert.deepEqual(verified, payload);
});

test("verifySession returns null on tampered payload", () => {
  const payload: SessionPayload = {
    discordId: "123456789",
    username: "alice",
    expiresAt: Date.now() + 60_000,
  };
  const cookie = signSession(payload, SECRET);
  // Flip a character in the payload segment but keep the signature.
  const [body, sig] = cookie.split(".");
  // Mutate the b64url payload — flip a known-safe char.
  const tampered = body!.replace(/[a-z]/, "Z") + "." + sig!;
  if (tampered === cookie) {
    // Couldn't mutate (no lowercase chars) — try a different position.
    assert.fail("could not produce a tampered payload");
  }
  assert.equal(verifySession(tampered, SECRET), null);
});

test("verifySession returns null on tampered signature", () => {
  const payload: SessionPayload = {
    discordId: "123456789",
    username: "alice",
    expiresAt: Date.now() + 60_000,
  };
  const cookie = signSession(payload, SECRET);
  const [body, sig] = cookie.split(".");
  const tamperedSig = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
  assert.equal(verifySession(`${body}.${tamperedSig}`, SECRET), null);
});

test("verifySession returns null with wrong secret", () => {
  const payload: SessionPayload = {
    discordId: "123456789",
    username: "alice",
    expiresAt: Date.now() + 60_000,
  };
  const cookie = signSession(payload, SECRET);
  assert.equal(verifySession(cookie, "different-secret"), null);
});

test("verifySession returns null when expired", () => {
  const payload: SessionPayload = {
    discordId: "123456789",
    username: "alice",
    expiresAt: Date.now() - 1, // already expired
  };
  const cookie = signSession(payload, SECRET);
  assert.equal(verifySession(cookie, SECRET), null);
});

test("verifySession returns null on malformed input", () => {
  assert.equal(verifySession("", SECRET), null);
  assert.equal(verifySession("no-dot", SECRET), null);
  // Three-or-more segments must be rejected (extra dots could otherwise
  // be silently dropped by split-and-destructure).
  assert.equal(verifySession("a.b.c", SECRET), null);
  assert.equal(verifySession("only.one.dot.too.many", SECRET), null);
  assert.equal(verifySession("garbage.garbage", SECRET), null);
});

test("sanitizeNext blocks open-redirect inputs", () => {
  // Allowed: same-origin absolute paths.
  assert.equal(sanitizeNext("/admin/arbiter-cases"), "/admin/arbiter-cases");
  assert.equal(sanitizeNext("/explorer"), "/explorer");

  // Blocked: protocol-relative ("//evil.example") collapses to fallback.
  assert.equal(sanitizeNext("//evil.example/bad"), "/admin/arbiter-cases");
  // Blocked: full URLs.
  assert.equal(
    sanitizeNext("https://evil.example/bad"),
    "/admin/arbiter-cases",
  );
  assert.equal(
    sanitizeNext("http://evil.example/bad"),
    "/admin/arbiter-cases",
  );
  // Blocked: missing leading slash.
  assert.equal(sanitizeNext("admin/arbiter-cases"), "/admin/arbiter-cases");
  // Blocked: empty / null / undefined.
  assert.equal(sanitizeNext(null), "/admin/arbiter-cases");
  assert.equal(sanitizeNext(undefined), "/admin/arbiter-cases");
  assert.equal(sanitizeNext(""), "/admin/arbiter-cases");
  // Blocked: just "/" which would be ambiguous (could re-trigger SSO loop).
  assert.equal(sanitizeNext("/"), "/admin/arbiter-cases");
});

test("isAdminId honors comma-separated env list", () => {
  const orig = process.env.ADMIN_DISCORD_IDS;
  process.env.ADMIN_DISCORD_IDS = "100, 200,300 ";
  try {
    assert.equal(isAdminId("100"), true);
    assert.equal(isAdminId("200"), true);
    assert.equal(isAdminId("300"), true);
    assert.equal(isAdminId("400"), false);
    assert.equal(isAdminId(""), false);
  } finally {
    process.env.ADMIN_DISCORD_IDS = orig;
  }
});

test("isAdminId returns false when env is unset", () => {
  const orig = process.env.ADMIN_DISCORD_IDS;
  delete process.env.ADMIN_DISCORD_IDS;
  try {
    assert.equal(isAdminId("100"), false);
  } finally {
    process.env.ADMIN_DISCORD_IDS = orig;
  }
});

test("freshExpiry returns ~7 days in the future", () => {
  const now = Date.now();
  const expiry = freshExpiry();
  const days = (expiry - now) / (24 * 60 * 60 * 1000);
  assert.ok(days >= 6.99 && days <= 7.01, `expected ~7 days, got ${days}`);
});
