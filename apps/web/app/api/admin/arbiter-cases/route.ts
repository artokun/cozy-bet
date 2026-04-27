/**
 * GET /api/admin/arbiter-cases (web-side proxy)
 *
 * Server-side fetch of the bot's admin endpoint, gated by the user's
 * Discord OAuth session being in ADMIN_DISCORD_IDS. The bot's bearer
 * token (ADMIN_API_TOKEN) lives in server env only — never exposed to
 * the browser.
 *
 * 401 if no valid session, 403 if logged in but not admin, 503 if
 * either ADMIN_API_TOKEN or BOT_API_URL isn't configured.
 */
import { NextResponse } from "next/server";
import { isAdminId, readSession } from "../../../../lib/session";

export async function GET() {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  if (!isAdminId(session.discordId)) {
    return NextResponse.json(
      { error: "not authorized — your Discord ID is not in ADMIN_DISCORD_IDS" },
      { status: 403 },
    );
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
    upstream = await fetch(`${botUrl}/api/admin/arbiter-cases`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `bot api unreachable: ${e instanceof Error ? e.message : String(e)}` },
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
  const json = await upstream.json();
  return NextResponse.json(json);
}
