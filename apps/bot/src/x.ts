/**
 * X (Twitter) v2 API helper for /confirm-share verification. We only need
 * one endpoint: GET /2/tweets/{id} with author expansion + text. Bearer
 * token is app-level (not user OAuth) — the user self-attests their handle
 * via /linktwitter, we just check the tweet exists, was authored by that
 * handle, and contains our hashtag.
 *
 * If X_BEARER_TOKEN is unset, isConfigured() returns false and the caller
 * should reject /confirm-share rather than trust user-submitted URLs.
 *
 * Note: env access is deliberately lazy (read inside each function) so the
 * module-level import of this file doesn't trigger zod validation of the
 * full bot env schema. That keeps parseTweetId trivially testable.
 */

export function isConfigured(): boolean {
  return Boolean(process.env.X_BEARER_TOKEN);
}

export type TweetCheckResult =
  | { ok: true; authorUsername: string; text: string; tweetId: string }
  | { ok: false; reason: string };

const TWEET_URL_RE =
  /^https?:\/\/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i;

export function parseTweetId(url: string): string | null {
  const m = url.match(TWEET_URL_RE);
  return m?.[1] ?? null;
}

export async function fetchTweet(tweetId: string): Promise<TweetCheckResult> {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) {
    return { ok: false, reason: "X_BEARER_TOKEN not configured" };
  }
  const url = `https://api.x.com/2/tweets/${encodeURIComponent(tweetId)}?expansions=author_id&user.fields=username&tweet.fields=text`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
  } catch (e: unknown) {
    return {
      ok: false,
      reason: `network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      reason: `X API ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }
  const json = (await res.json()) as {
    data?: { id: string; text: string; author_id?: string };
    includes?: { users?: Array<{ id: string; username: string }> };
    errors?: Array<{ title?: string; detail?: string }>;
  };
  if (!json.data) {
    const err = json.errors?.[0];
    return {
      ok: false,
      reason: err?.detail ?? err?.title ?? "tweet not found",
    };
  }
  const author = json.includes?.users?.find(
    (u) => u.id === json.data!.author_id,
  );
  if (!author) {
    return { ok: false, reason: "tweet author not in expansion" };
  }
  return {
    ok: true,
    authorUsername: author.username,
    text: json.data.text,
    tweetId: json.data.id,
  };
}

/** Verify a /share-d tweet meets the discount criteria. */
export async function verifyShareTweet(args: {
  tweetUrl: string;
  expectedHandle: string; // no leading @
  requiredHashtag: string; // e.g. "#cozybet"
}): Promise<{ ok: true; tweetId: string } | { ok: false; reason: string }> {
  const tweetId = parseTweetId(args.tweetUrl);
  if (!tweetId) {
    return { ok: false, reason: "URL doesn't look like a tweet link" };
  }
  const result = await fetchTweet(tweetId);
  if (!result.ok) return result;
  if (
    result.authorUsername.toLowerCase() !==
    args.expectedHandle.replace(/^@/, "").toLowerCase()
  ) {
    return {
      ok: false,
      reason: `tweet author @${result.authorUsername} doesn't match your linked handle @${args.expectedHandle.replace(/^@/, "")}`,
    };
  }
  if (
    !result.text
      .toLowerCase()
      .includes(args.requiredHashtag.toLowerCase())
  ) {
    return {
      ok: false,
      reason: `tweet must include ${args.requiredHashtag}`,
    };
  }
  return { ok: true, tweetId: result.tweetId };
}
