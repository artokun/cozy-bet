/**
 * GET /api/auth/discord/callback?code=...&state=...
 *
 * Discord redirects here after the user approves the OAuth consent screen.
 * Steps:
 *  1. Verify `state` matches the value we stashed in cookie at login time.
 *  2. Exchange `code` for an access token via the Discord token endpoint.
 *  3. Fetch /users/@me with the access token to learn discord_id +
 *     username.
 *  4. Sign a session cookie with that discord_id + 7d TTL.
 *  5. Redirect to the post-login `next` URL (default /admin/arbiter-cases).
 *
 * NOTE: this route does NOT itself check ADMIN_DISCORD_IDS — the admin
 * pages do that. We just attest the Discord identity here. Non-admins
 * can still get a session, they just won't have access to /admin/*.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  freshExpiry,
  makeSessionCookie,
  sanitizeNext,
} from "../../../../../lib/session";

const STATE_COOKIE = "cozy-bet-oauth-state";

export async function GET(req: Request) {
  const clientId = process.env.DISCORD_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  const redirectBase = process.env.WEB_PUBLIC_URL ?? "http://localhost:3000";
  const redirectUri = `${redirectBase}/api/auth/discord/callback`;
  if (!clientId || !clientSecret || !sessionSecret) {
    return NextResponse.json(
      { error: "OAuth env not fully configured" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  }

  // Verify state from the login-time cookie. Discord's redirect doesn't
  // forward our cookies if we set them with SameSite=Strict, but Lax allows
  // cookies on top-level navigations (which OAuth callbacks are).
  const cookieHeader = req.headers.get("cookie") ?? "";
  const stateCookie = parseCookie(cookieHeader, STATE_COOKIE);
  if (!stateCookie) {
    return NextResponse.json(
      { error: "missing state cookie — login flow may have expired" },
      { status: 400 },
    );
  }
  let stashed: { state: string; next: string };
  try {
    stashed = JSON.parse(stateCookie);
  } catch {
    return NextResponse.json({ error: "bad state cookie" }, { status: 400 });
  }
  // Timing-safe state comparison. The risk is theoretical (the attacker
  // doesn't repeatedly probe this endpoint) but the rest of the codebase
  // uses timingSafeEqual for HMAC checks — keep the convention consistent
  // so a future reader doesn't trip over the inconsistency.
  const stashedBuf = Buffer.from(stashed.state);
  const stateBuf = Buffer.from(state);
  if (
    stashedBuf.length !== stateBuf.length ||
    !timingSafeEqual(stashedBuf, stateBuf)
  ) {
    return NextResponse.json({ error: "state mismatch" }, { status: 400 });
  }

  // Exchange the code for a token.
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      return NextResponse.json(
        { error: `discord token exchange failed: ${tokenRes.status} ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const tokenJson = (await tokenRes.json()) as { access_token: string };
    accessToken = tokenJson.access_token;
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `token fetch error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  // Fetch the user.
  let me: { id: string; username: string };
  try {
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!meRes.ok) {
      return NextResponse.json(
        { error: `discord /users/@me failed: ${meRes.status}` },
        { status: 502 },
      );
    }
    me = (await meRes.json()) as { id: string; username: string };
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `users fetch error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const expiresAt = freshExpiry();
  const sessionCookie = makeSessionCookie(
    {
      discordId: me.id,
      username: me.username,
      expiresAt,
    },
    sessionSecret,
  );

  // Clear the state cookie + set the session cookie. We can pass two
  // Set-Cookie headers via Headers#append.
  // Re-sanitize stashed.next defensively, even though login validated it.
  // The cookie is HMAC-signed (integrity), not policy-checked — a future
  // refactor that bypasses login (e.g. tests, programmatic flows) won't
  // accidentally introduce an open redirect here.
  const headers = new Headers({ location: sanitizeNext(stashed.next) });
  headers.append("set-cookie", sessionCookie);
  headers.append(
    "set-cookie",
    `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );

  return new NextResponse(null, { status: 302, headers });
}

function parseCookie(header: string, name: string): string | null {
  for (const piece of header.split(";")) {
    const [k, ...v] = piece.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
