/**
 * GET /api/auth/discord/login
 *
 * Redirects the browser to Discord's OAuth2 authorize URL with the bot's
 * client ID + redirect URI. After the user approves, Discord 302's back to
 * /api/auth/discord/callback with `code` + `state`.
 *
 * `state` is a random nonce stored in a short-lived cookie so the callback
 * can verify the round-trip wasn't spoofed (CSRF guard).
 *
 * Returns 503 if DISCORD_OAUTH_CLIENT_ID isn't set so the operator gets a
 * clear "OAuth not configured" message instead of a Discord-side error.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

const STATE_COOKIE = "cozy-bet-oauth-state";

export async function GET(req: Request) {
  const clientId = process.env.DISCORD_OAUTH_CLIENT_ID;
  const redirectBase = process.env.WEB_PUBLIC_URL ?? "http://localhost:3000";
  const redirectUri = `${redirectBase}/api/auth/discord/callback`;
  if (!clientId) {
    return new NextResponse(
      JSON.stringify({
        error:
          "DISCORD_OAUTH_CLIENT_ID not set — admin login is disabled. See docs/discord-oauth.md to register an app.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  if (!process.env.SESSION_SECRET) {
    return new NextResponse(
      JSON.stringify({
        error: "SESSION_SECRET not set — set a long random value in env",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  // Allow ?next=/some/path to bounce back after login; default /admin/arbiter-cases.
  const url = new URL(req.url);
  const next = url.searchParams.get("next") ?? "/admin/arbiter-cases";
  const state = randomBytes(16).toString("base64url");
  const stateCookie = `${STATE_COOKIE}=${encodeURIComponent(JSON.stringify({ state, next }))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${
    process.env.NODE_ENV === "production" ? "; Secure" : ""
  }`;

  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "none");

  return new NextResponse(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": stateCookie,
    },
  });
}
