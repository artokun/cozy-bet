/**
 * GET /api/me — server-side proxy that resolves the current Discord
 * session, then fetches the user's profile from the bot using the
 * server-only ADMIN_API_TOKEN. The discordId is taken from the
 * signed session cookie, NEVER from a URL/header — that ensures a
 * caller can't see anyone else's profile.
 *
 * 401 if no session, 503 if env not configured, 502 on bot error.
 */
import { NextResponse } from "next/server";
import { readSession } from "../../../lib/session";

export async function GET() {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const botUrl = process.env.BOT_API_URL ?? "http://localhost:3001";
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "ADMIN_API_TOKEN not configured on the web server" },
      { status: 503 },
    );
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      `${botUrl}/api/users/${encodeURIComponent(session.discordId)}/profile`,
      {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      },
    );
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error: `bot api unreachable: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: `bot api ${upstream.status}: ${text.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const body = await upstream.json();
  // Inject the username from session so the page doesn't need a separate
  // lookup just for that.
  return NextResponse.json({ ...body, username: session.username });
}
