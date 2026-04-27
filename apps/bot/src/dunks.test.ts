/**
 * Pure unit tests for dunks.ts. Run via `pnpm --filter @cozy-bet/bot test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDunkEnv, getDunks, _resetCacheForTests } from "./dunks.js";

test("parseDunkEnv parses newline-delimited url|label", () => {
  const raw = [
    "https://example.com/a.gif|Mic drop",
    "https://example.com/b.gif|Cool walk",
  ].join("\n");
  const out = parseDunkEnv(raw);
  assert.deepEqual(out, [
    { url: "https://example.com/a.gif", label: "Mic drop" },
    { url: "https://example.com/b.gif", label: "Cool walk" },
  ]);
});

test("parseDunkEnv tolerates Windows line endings + blank lines", () => {
  const raw = [
    "https://example.com/a.gif|First",
    "",
    "  ", // whitespace-only line
    "https://example.com/b.gif|Second",
  ].join("\r\n");
  const out = parseDunkEnv(raw);
  assert.deepEqual(out, [
    { url: "https://example.com/a.gif", label: "First" },
    { url: "https://example.com/b.gif", label: "Second" },
  ]);
});

test("parseDunkEnv defaults missing label to 'GIF'", () => {
  const out = parseDunkEnv("https://example.com/a.gif");
  assert.deepEqual(out, [{ url: "https://example.com/a.gif", label: "GIF" }]);
});

test("parseDunkEnv skips lines without url", () => {
  const raw = ["|orphan label", "https://example.com/a.gif|Real"].join("\n");
  const out = parseDunkEnv(raw);
  assert.deepEqual(out, [
    { url: "https://example.com/a.gif", label: "Real" },
  ]);
});

test("parseDunkEnv returns null on empty/null/whitespace input", () => {
  assert.equal(parseDunkEnv(""), null);
  assert.equal(parseDunkEnv(null), null);
  assert.equal(parseDunkEnv(undefined), null);
  // All-whitespace yields zero parseable entries → null (so caller uses fallback).
  assert.equal(parseDunkEnv("\n  \n\n"), null);
});

test("getDunks falls back to default list when DUNK_GIFS unset", () => {
  const orig = process.env.DUNK_GIFS;
  delete process.env.DUNK_GIFS;
  _resetCacheForTests();
  try {
    const dunks = getDunks();
    assert.ok(dunks.length > 0, "default list should be non-empty");
    assert.ok(
      dunks.every((d) => typeof d.url === "string" && typeof d.label === "string"),
      "every entry has url + label",
    );
  } finally {
    if (orig !== undefined) process.env.DUNK_GIFS = orig;
    _resetCacheForTests();
  }
});

test("getDunks honors DUNK_GIFS env override", () => {
  const orig = process.env.DUNK_GIFS;
  process.env.DUNK_GIFS = "https://override.example/x.gif|Custom";
  _resetCacheForTests();
  try {
    assert.deepEqual(getDunks(), [
      { url: "https://override.example/x.gif", label: "Custom" },
    ]);
  } finally {
    if (orig === undefined) delete process.env.DUNK_GIFS;
    else process.env.DUNK_GIFS = orig;
    _resetCacheForTests();
  }
});

test("getDunks falls back to default when env is malformed (zero parseable)", () => {
  const orig = process.env.DUNK_GIFS;
  process.env.DUNK_GIFS = "|just-a-label\n|another";
  _resetCacheForTests();
  try {
    const dunks = getDunks();
    assert.ok(
      dunks.length > 0 && dunks[0]!.label !== "just-a-label",
      "should fall through to default list, not the orphan-label entries",
    );
  } finally {
    if (orig === undefined) delete process.env.DUNK_GIFS;
    else process.env.DUNK_GIFS = orig;
    _resetCacheForTests();
  }
});
