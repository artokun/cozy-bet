# Discord OAuth setup

The web app's `/admin/*` pages gate access on a Discord OAuth session
whose resolved Discord ID appears in `ADMIN_DISCORD_IDS`. Setup is
one-time per environment.

## 1. Register a Discord application

1. Sign in at https://discord.com/developers/applications.
2. Click **New Application**, name it `cozy-bet (dev)` /
   `cozy-bet (prod)` etc. Same app can be reused across environments
   if redirect URIs are listed for each.
3. **OAuth2 → Redirects:** add the callback URL for every environment
   you'll deploy to:
   ```
   http://localhost:3000/api/auth/discord/callback
   https://<your-cloudflared-tunnel>/api/auth/discord/callback
   https://<prod-domain>/api/auth/discord/callback
   ```
4. **OAuth2 → General:** copy the **Client ID** and **Client Secret**.
5. (No bot user needed for OAuth login. The cozy-bet bot user is a
   separate application — keep them as separate apps so you can
   rotate either independently.)

## 2. Configure web env

In `apps/web/.env`:

```
DISCORD_OAUTH_CLIENT_ID=<from step 4>
DISCORD_OAUTH_CLIENT_SECRET=<from step 4>
WEB_PUBLIC_URL=https://<your-domain>
SESSION_SECRET=<long random string, see below>
ADMIN_DISCORD_IDS=<comma-separated discord user ids, same as bot>
ADMIN_API_TOKEN=<same as bot>
BOT_API_URL=http://localhost:3001
```

Generate `SESSION_SECRET`:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Rotate `SESSION_SECRET` to invalidate every existing session.

## 3. Verify

1. Restart the web app (`pnpm dev:web`).
2. Visit `/admin/arbiter-cases`.
3. Click **Log in with Discord** → consent screen → redirected back.
4. If your Discord ID is in `ADMIN_DISCORD_IDS`, the page auto-loads
   the case list. Otherwise you'll see "your Discord ID is not in
   ADMIN_DISCORD_IDS" — add it on the bot side too and restart.

## How the flow works

```
browser                    web                       discord
  │                         │                          │
  ├─ GET /admin/...         │                          │
  │  /api/auth/me           │                          │
  │  no session             │                          │
  │ ◄─ shows "Log in"       │                          │
  │                         │                          │
  ├─ click Log in ─►/api/auth/discord/login            │
  │                         │  302 ──► discord.com/oauth2/authorize
  │ ◄─────────────────────────────302──┘
  │                         │                          │
  ├─ GET .../callback?code=&state=                     │
  │                         │ POST /oauth2/token ─────►│
  │                         │ ◄── access_token ────────│
  │                         │ GET /users/@me  ────────►│
  │                         │ ◄── { id, username } ────│
  │                         │ HMAC-sign cookie         │
  │ ◄── Set-Cookie + 302 to /admin/arbiter-cases       │
  │                         │                          │
  ├─ GET /api/admin/arbiter-cases                      │
  │                         │ readSession + isAdminId  │
  │                         │ fetch bot /api/admin/...  with ADMIN_API_TOKEN
  │                         │ ◄── case list ───────────│  bot
  │ ◄── case list           │                          │
```

The session cookie is HMAC-SHA256 signed with `SESSION_SECRET`. Payload
is `{ discordId, username, expiresAt }` — no Discord access token is
stored. The 7-day TTL auto-expires the session. Logout (`POST
/api/auth/logout`) clears the cookie locally.

## Threat notes

- The session cookie is HttpOnly + SameSite=Lax, so it's not readable
  from JS and isn't sent on cross-site subresource requests. Top-level
  navigations (which OAuth callbacks are) still carry it.
- The admin token (`ADMIN_API_TOKEN`) lives only in server env. The
  browser never sees it; the bot's CORS rules also reject the admin
  endpoint from non-`WEB_PUBLIC_URL` origins.
- Rotating `SESSION_SECRET` invalidates every session — use this if
  you suspect a leak. No DB cleanup needed.
- Rotating `DISCORD_OAUTH_CLIENT_SECRET` is independent of session
  rotation: existing sessions remain valid, but new logins must use
  the new secret.

## What this replaces

The earlier admin page used a static `ADMIN_API_TOKEN` bearer pasted
into a textbox + persisted in `localStorage`. That worked but exposed
the token to any XSS in the admin's browser. OAuth removes that
attack surface — the browser never holds the bearer token.

The wallet-link DM nonce flow (`/link/[sessionId]`) is **not**
affected by this change. Those nonces are bot-issued, single-use, and
bound to a specific Discord ID — they're already authenticated by the
bot's DM. Replacing them with OAuth is a separate (lower-priority)
follow-up.
