/**
 * Cookie-based admin session for cozy-bet's web app. Signed with HMAC-SHA256
 * over a secret in env.SESSION_SECRET — no JWT lib needed. Cookie payload is
 * `{ discordId, username, expiresAt }` base64url-encoded; signature is the
 * trailing segment.
 *
 * Used by the Discord OAuth flow (apps/web/app/api/auth/discord/...) and
 * the /admin/* server components that gate on the resolved Discord ID
 * being in env.ADMIN_DISCORD_IDS.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "cozy-bet-session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type SessionPayload = {
  discordId: string;
  username: string;
  /** Unix ms */
  expiresAt: number;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function signSession(p: SessionPayload, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(p)));
  const sig = sign(payload, secret);
  return `${payload}.${sig}`;
}

export function verifySession(
  raw: string,
  secret: string,
): SessionPayload | null {
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  let valid = false;
  try {
    valid = timingSafeEqual(fromB64url(sig), fromB64url(expected));
  } catch {
    return null;
  }
  if (!valid) return null;
  let parsed: SessionPayload;
  try {
    parsed = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed?.discordId !== "string" ||
    typeof parsed?.expiresAt !== "number" ||
    parsed.expiresAt < Date.now()
  ) {
    return null;
  }
  return parsed;
}

/** Read the current session from request cookies. Returns null if missing,
 *  malformed, expired, or no SESSION_SECRET configured. */
export async function readSession(): Promise<SessionPayload | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return verifySession(raw, secret);
}

/** Make a Set-Cookie header for a fresh session. */
export function makeSessionCookie(p: SessionPayload, secret: string): string {
  const value = signSession(p, secret);
  const maxAge = Math.max(0, Math.floor((p.expiresAt - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function freshExpiry(): number {
  return Date.now() + SESSION_TTL_MS;
}

/** True iff the resolved Discord ID is in the comma-separated env list. */
export function isAdminId(discordId: string): boolean {
  const list = process.env.ADMIN_DISCORD_IDS ?? "";
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(discordId);
}
