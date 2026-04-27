/**
 * Asserts the bot's hand-rolled ESCROW_ABI matches the Foundry-generated
 * ABI for CozyBetEscrow. Foundry's output at
 * apps/contracts/out/CozyBetEscrow.sol/CozyBetEscrow.json is the source
 * of truth (regenerated on every `forge build`). The bot only needs a
 * subset of the contract's surface, so this checks each entry in
 * ESCROW_ABI has a matching name + same input/output type signatures
 * upstream.
 *
 * Skips silently if the Foundry build hasn't run (CI without forge
 * isn't expected to have apps/contracts/out/).
 *
 *   pnpm --filter @cozy-bet/bot exec tsx scripts/check-evm-abi-sync.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESCROW_ABI } from "../src/evm-abi.js";

const here = dirname(fileURLToPath(import.meta.url));
const botRoot = dirname(here);
const repoRoot = dirname(dirname(botRoot));
const foundryJsonPath = join(
  repoRoot,
  "apps/contracts/out/CozyBetEscrow.sol/CozyBetEscrow.json",
);

if (!existsSync(foundryJsonPath)) {
  console.log("- foundry build not present (skip — apps/contracts/out/ is gitignored)");
  process.exit(0);
}

type AbiInput = { name?: string; type: string; components?: AbiInput[] };
type AbiEntry = {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiInput[];
  outputs?: AbiInput[];
};

const foundryJson = JSON.parse(readFileSync(foundryJsonPath, "utf8")) as {
  abi: AbiEntry[];
};
// Allow function overloads — Solidity differentiates by full param list.
// We match by name + matching input signature; reject only if NO overload
// at all matches the bot's hand-rolled entry.
const upstream = new Map<string, AbiEntry[]>();
for (const e of foundryJson.abi) {
  if (e.type === "function" && e.name) {
    const list = upstream.get(e.name) ?? [];
    list.push(e);
    upstream.set(e.name, list);
  }
}

/** Normalize an inputs/outputs list to a comparable shape: just types,
 *  recursively flattening tuple components. We don't care about input
 *  names — Solidity allows renaming params without breaking ABI compat. */
function sigShape(items: AbiInput[] | undefined): unknown {
  if (!items) return [];
  return items.map((i) =>
    i.type === "tuple" || i.type === "tuple[]"
      ? { type: i.type, components: sigShape(i.components) }
      : { type: i.type },
  );
}

let drift = 0;
for (const local of ESCROW_ABI) {
  if (local.type !== "function") continue;
  const fname = (local as { name?: string }).name;
  if (!fname) continue;
  const candidates = upstream.get(fname) ?? [];
  if (candidates.length === 0) {
    console.error(`✗ ${fname}: not found in foundry ABI`);
    drift++;
    continue;
  }
  const localInputs = JSON.stringify(sigShape((local as AbiEntry).inputs));
  const localOutputs = JSON.stringify(sigShape((local as AbiEntry).outputs));
  const matched = candidates.find(
    (up) =>
      JSON.stringify(sigShape(up.inputs)) === localInputs &&
      JSON.stringify(sigShape(up.outputs)) === localOutputs &&
      (local as AbiEntry).stateMutability === up.stateMutability,
  );
  if (!matched) {
    console.error(`✗ ${fname}: no overload in foundry ABI matches`);
    console.error(`    bot inputs:  ${localInputs}`);
    console.error(`    bot outputs: ${localOutputs}`);
    console.error(`    foundry options:`);
    for (const up of candidates) {
      console.error(
        `      - inputs ${JSON.stringify(sigShape(up.inputs))}, outputs ${JSON.stringify(sigShape(up.outputs))}, ${up.stateMutability}`,
      );
    }
    drift++;
    continue;
  }
  console.log(`✓ ${fname}`);
}

if (drift > 0) {
  console.error(
    `\n❌ EVM ABI drift detected — bot's ESCROW_ABI has ${drift} mismatch(es).`,
  );
  console.error(
    "   Update apps/bot/src/evm-abi.ts to match the contract, then re-run.",
  );
  process.exit(1);
}
console.log(`\n✅ all ${ESCROW_ABI.length} entries match foundry`);
