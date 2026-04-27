/**
 * Curated trash-talk GIF list for the post-resolve "dunk picker" DM.
 * Winner picks one; bot posts it in the bet's channel.
 *
 * Replaceable at runtime via the env var DUNK_GIFS (newline-separated
 * "url|label" lines) without redeploying. If the env var is empty or
 * malformed, we fall back to this hardcoded list.
 */
export type Dunk = { url: string; label: string };

const DEFAULT_DUNKS: Dunk[] = [
  {
    url: "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExdXJqdHV6c3hhMTRtaTd5dHl3ZjBzbWMzbXFwOWN0OXp1bnB6OW55ciZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3o7TKsQ8UQ0vJOvB4I/giphy.gif",
    label: "Mic drop",
  },
  {
    url: "https://media1.giphy.com/media/l2QDM9Jnim1YVILXa/giphy.gif",
    label: "Smug nod",
  },
  {
    url: "https://media1.giphy.com/media/3o6gE9aTAkVyB1pLL2/giphy.gif",
    label: "Pointing laugh",
  },
  {
    url: "https://media1.giphy.com/media/QWvra259h4LCvdJnxP/giphy.gif",
    label: "Dramatic point",
  },
  {
    url: "https://media1.giphy.com/media/3oz8xRapjuwfMJ2NJK/giphy.gif",
    label: "Air guitar",
  },
  {
    url: "https://media1.giphy.com/media/xUOxfh6ZM6ZMNXVRna/giphy.gif",
    label: "Money rain",
  },
  {
    url: "https://media1.giphy.com/media/26FPJGjhefSJuaRhu/giphy.gif",
    label: "Crab walk",
  },
  {
    url: "https://media1.giphy.com/media/Jpg6Ee70VJoaY/giphy.gif",
    label: "Bow down",
  },
  {
    url: "https://media1.giphy.com/media/HeoCs5xPqLvcs/giphy.gif",
    label: "Slow clap",
  },
  {
    url: "https://media1.giphy.com/media/H4uE6w9G1uK4M/giphy.gif",
    label: "Easy money",
  },
];

/** Parse the DUNK_GIFS env var format: newline-delimited "url|label" lines.
 *  Empty lines and lines without a url are skipped. Missing label defaults
 *  to "GIF". Returns null if the input is empty or yields no parseable
 *  entries — caller falls back to DEFAULT_DUNKS. Pure function, no env
 *  access — testable. */
export function parseDunkEnv(raw: string | null | undefined): Dunk[] | null {
  if (!raw) return null;
  const parsed = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [url, label] = line.split("|").map((s) => s?.trim());
      if (!url) return null;
      return { url, label: label || "GIF" } as Dunk;
    })
    .filter((d): d is Dunk => d !== null);
  return parsed.length > 0 ? parsed : null;
}

let _cache: Dunk[] | null = null;

export function getDunks(): Dunk[] {
  if (_cache) return _cache;
  _cache = parseDunkEnv(process.env.DUNK_GIFS) ?? DEFAULT_DUNKS;
  return _cache;
}

/** Reset the module-level cache. Test-only — production code never needs
 *  this since DUNK_GIFS doesn't change between bot restarts. */
export function _resetCacheForTests(): void {
  _cache = null;
}
