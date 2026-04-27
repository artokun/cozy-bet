/**
 * Source-level regex scan to assert that every slash command registered
 * with Discord has a matching entry in the routing dispatcher. If someone
 * adds a SlashCommandBuilder + commandDefinitions entry but forgets to
 * extend slashRoutes, Discord still sees the command but invocations
 * silently no-op.
 *
 * The test reads the source files directly (no module imports) so it
 * doesn't pull in env validation. It's coarse — a regex of `.setName("...")`
 * + `slashRoutes` keys — but catches the realistic mistake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const commandsSrc = readFileSync(resolve(here, "commands.ts"), "utf8");
const interactionsSrc = readFileSync(
  resolve(here, "interactions.ts"),
  "utf8",
);

/** Top-level slash-command names — only the outermost SlashCommandBuilder
 *  .setName(...). Sub-options also use .setName(); we filter those out
 *  by only matching `new SlashCommandBuilder()\n  .setName("...")` shape
 *  via the .toJSON() registration list instead.
 *
 *  Easier: parse the commandDefinitions array literal — every entry is
 *  `<name>.toJSON(),` and the prior `.setName("X")` belongs to that
 *  exported builder. Cleanest: regex out names from inside the
 *  `commandDefinitions: ... = [` block.
 */
function extractRegisteredNames(src: string): string[] {
  const startIdx = src.indexOf("commandDefinitions");
  if (startIdx === -1) return [];
  const open = src.indexOf("[", startIdx);
  const close = src.indexOf("];", open);
  const block = src.slice(open, close);
  // Each line: `  saybet.toJSON(),` — the const name is what we want.
  // Map from const name back to its .setName(...) call earlier in the file.
  const constNames = Array.from(block.matchAll(/(\w+)\.toJSON\(\)/g)).map(
    (m) => m[1]!,
  );
  // For each const, find `export const <name> = new SlashCommandBuilder()`
  // and then the immediately-following .setName("...").
  const names: string[] = [];
  for (const c of constNames) {
    const re = new RegExp(
      `export const ${c} = new SlashCommandBuilder\\(\\)\\s*\\.setName\\("([^"]+)"\\)`,
    );
    const m = src.match(re);
    if (m) names.push(m[1]!);
  }
  return names;
}

function extractRoutedNames(src: string): string[] {
  const startIdx = src.indexOf("export const slashRoutes");
  if (startIdx === -1) return [];
  const open = src.indexOf("{", startIdx);
  const close = src.indexOf("};", open);
  const block = src.slice(open, close);
  // Keys: bare-word `saybet:` or quoted `"open-bets":`.
  const out: string[] = [];
  for (const m of block.matchAll(/(?:^|\n)\s+(?:"([^"]+)"|(\w+))\s*:/g)) {
    out.push((m[1] ?? m[2])!);
  }
  return out;
}

test("every registered slash command has a routing entry", () => {
  const registered = extractRegisteredNames(commandsSrc);
  const routed = extractRoutedNames(interactionsSrc);
  assert.ok(registered.length > 0, "should find at least one registered command");
  assert.ok(routed.length > 0, "should find at least one routed command");
  const routedSet = new Set(routed);
  const missing = registered.filter((n) => !routedSet.has(n));
  assert.deepEqual(
    missing,
    [],
    `commands registered with Discord but unrouted: ${missing.join(", ")}`,
  );
});

test("no routing entry without a registered command (no orphans)", () => {
  const registered = new Set(extractRegisteredNames(commandsSrc));
  const routed = extractRoutedNames(interactionsSrc);
  const orphans = routed.filter((n) => !registered.has(n));
  assert.deepEqual(
    orphans,
    [],
    `routed commands without a Discord registration: ${orphans.join(", ")}`,
  );
});
