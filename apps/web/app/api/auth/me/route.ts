/**
 * GET /api/auth/me — return the current session payload (or null) so the
 * client can render the appropriate "logged in / not logged in" UI without
 * exposing the cookie itself.
 */
import { NextResponse } from "next/server";
import { isAdminId, readSession } from "../../../../lib/session";

export async function GET() {
  const session = await readSession();
  if (!session) return NextResponse.json({ session: null });
  return NextResponse.json({
    session: {
      discordId: session.discordId,
      username: session.username,
      expiresAt: session.expiresAt,
      isAdmin: isAdminId(session.discordId),
    },
  });
}
