/**
 * Asserts the IDL + types in packages/shared match what's currently in
 * apps/program/target/. Catches the case where a developer ran `anchor
 * build` directly (bypassing `pnpm program:build` which auto-runs
 * idl:export) and forgot to re-export.
 *
 * Skips silently if target/ doesn't exist (CI without the Solana
 * toolchain isn't expected to have a build).
 *
 *   pnpm --filter @cozy-bet/program idl:check-sync
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const programRoot = dirname(here);
const repoRoot = dirname(dirname(programRoot));

const pairs = [
  {
    label: "idl.json",
    target: join(programRoot, "target/idl/escrow.json"),
    shared: join(repoRoot, "packages/shared/src/idl.json"),
  },
  {
    label: "idl-types.ts",
    target: join(programRoot, "target/types/escrow.ts"),
    shared: join(repoRoot, "packages/shared/src/idl-types.ts"),
  },
];

let drifted = 0;
let skipped = 0;
for (const p of pairs) {
  if (!existsSync(p.target)) {
    skipped++;
    continue;
  }
  if (!existsSync(p.shared)) {
    console.error(`✗ ${p.label}: shared copy missing at ${p.shared}`);
    drifted++;
    continue;
  }
  const targetSrc = readFileSync(p.target, "utf8");
  const sharedSrc = readFileSync(p.shared, "utf8");
  if (targetSrc !== sharedSrc) {
    console.error(`✗ ${p.label}: target/ differs from packages/shared/src/`);
    drifted++;
  } else {
    console.log(`✓ ${p.label}: in sync`);
  }
}

if (skipped === pairs.length) {
  console.log("- target/ not built (skip — anchor build hasn't run locally)");
  process.exit(0);
}
if (drifted > 0) {
  console.error(
    `\n❌ IDL drift detected. Run \`pnpm --filter @cozy-bet/program idl:export\` to sync.`,
  );
  process.exit(1);
}
console.log("\n✅ IDL is in sync");
