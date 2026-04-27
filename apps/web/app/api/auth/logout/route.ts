/**
 * POST /api/auth/logout — clear the session cookie. Doesn't revoke the
 * Discord access token (we never persist it; it expired with the cookie's
 * 7d TTL anyway).
 */
import { NextResponse } from "next/server";
import { clearSessionCookie } from "../../../../lib/session";

export async function POST() {
  return new NextResponse(null, {
    status: 204,
    headers: { "set-cookie": clearSessionCookie() },
  });
}
