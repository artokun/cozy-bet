/**
 * Asserts schema.ts hasn't drifted from migrations/. Runs drizzle-kit
 * generate (idempotent: emits "No schema changes, nothing to migrate 😴"
 * when up-to-date) and fails if it would produce a new migration.
 *
 * Catches the case where a contributor edits schema.ts but forgets
 * `pnpm db:generate`. Typed queries against ungenerated columns fail
 * at runtime; we'd rather fail at PR time.
 *
 *   pnpm tsx packages/db/scripts/check-schema.ts
 *
 * On drift, the developer should:
 *   1. Run `pnpm --filter @cozy-bet/db generate` and commit the new
 *      migration + meta files (intentional schema change), OR
 *   2. `git checkout HEAD -- packages/db/src/schema.ts` (revert).
 *
 * The script does NOT auto-clean drizzle-kit's side-effects (it touches
 * meta/_journal.json + writes meta/<n>_snapshot.json before we can stop
 * it). Cleaning those silently would mask state for CI; explicit revert
 * is safer.
 */
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = dirname(here);
const migrationsDir = join(dbRoot, "migrations");

const before = new Set(readdirSync(migrationsDir));

let output: string;
try {
  output = execSync("pnpm exec drizzle-kit generate", {
    cwd: dbRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e: unknown) {
  console.error("drizzle-kit generate threw:");
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const after = new Set(readdirSync(migrationsDir));
const added = [...after].filter((f) => !before.has(f));

if (added.length > 0 || !/No schema changes/i.test(output)) {
  console.error(
    "\n❌ schema drift detected — schema.ts has changes that aren't reflected in migrations/.",
  );
  if (added.length > 0) {
    console.error(`   New files generated: ${added.join(", ")}`);
  }
  console.error(
    "\n   To fix: either run `pnpm --filter @cozy-bet/db generate` and commit",
  );
  console.error(
    "   the new migration + meta files (intentional change), OR revert with",
  );
  console.error(
    "   `git checkout HEAD -- packages/db/src/schema.ts packages/db/migrations/`.",
  );
  process.exit(1);
}

console.log("✅ schema.ts is in sync with migrations/");
