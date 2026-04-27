/**
 * USDC atom (6-decimal) → human display string. Matches the bot's
 * formatAmount in apps/bot/src/discord/render.ts. Accepts bigint OR
 * the string form returned by the bot's JSON API (every BigInt-typed
 * column gets serialized as a string before fetch).
 *
 * Pure function — easy to test if we add a web/lib/format.test.ts later.
 */
export function formatUsdcAtoms(atoms: bigint | string | number): string {
  const big = typeof atoms === "bigint" ? atoms : BigInt(atoms);
  return (Number(big) / 1e6).toFixed(2);
}
