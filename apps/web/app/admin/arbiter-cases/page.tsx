"use client";
/**
 * Admin: arbiter case list. Read-only viewer for collected evidence.
 *
 * Auth: Discord OAuth session (cookie). Page calls /api/auth/me on mount;
 * if no session, prompts a login. If session but Discord ID not in
 * ADMIN_DISCORD_IDS, shows "not authorized". Data fetch goes through
 * /api/admin/arbiter-cases (web-side proxy) which adds the server-only
 * bearer token before forwarding to the bot — admin token never reaches
 * the browser.
 *
 * Decide actions still happen in Discord (/arbiter-claim, /arbiter-decide).
 */
import { useCallback, useEffect, useState } from "react";

type Evidence = {
  actorDiscordId: string;
  text: string;
  attachments: string[];
  createdAt: string;
};

type ArbiterCase = {
  id: string;
  chain: "solana" | "base";
  shortcode: string;
  status: string;
  amount: string;
  description: string;
  termsCanonical: string | null;
  challengerId: string;
  accepterId: string | null;
  challengerClaimsWinner: string | null;
  accepterClaimsWinner: string | null;
  arbiterRequestedAt: string | null;
  arbiterRequestedBy: string | null;
  arbiterDiscordId: string | null;
  guildId: string;
  channelId: string;
  announceMessageId: string | null;
  winnerId: string | null;
  resolutionTxSig: string | null;
  resolvedAt: string | null;
  evidence: Evidence[];
};

type SessionInfo = {
  discordId: string;
  username: string;
  expiresAt: number;
  isAdmin: boolean;
};

export default function ArbiterCasesPage() {
  const [session, setSession] = useState<SessionInfo | null | undefined>(
    undefined,
  );
  const [cases, setCases] = useState<ArbiterCase[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Resolve session on mount.
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setSession(j.session))
      .catch(() => setSession(null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/arbiter-cases", { cache: "no-store" });
      if (r.status === 401) {
        setErr("Session expired. Please log in again.");
        setSession(null);
        return;
      }
      if (r.status === 403) {
        setErr("Your Discord ID is not in ADMIN_DISCORD_IDS.");
        return;
      }
      if (r.status === 503) {
        const j = (await r.json()) as { error: string };
        setErr(j.error);
        return;
      }
      if (!r.ok) {
        setErr(`Fetch failed: ${r.status}`);
        return;
      }
      const json = (await r.json()) as { cases: ArbiterCase[] };
      setCases(json.cases);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load if signed in + admin.
  useEffect(() => {
    if (session?.isAdmin) void load();
  }, [session, load]);

  return (
    <main className="container" style={{ maxWidth: 980 }}>
      <div className="card">
        <h1>Arbiter cases (admin)</h1>
        <p className="muted">
          Read-only viewer. To take action, run{" "}
          <code>/arbiter-claim</code> / <code>/arbiter-decide</code> in
          Discord.
        </p>

        {session === undefined && (
          <p className="muted" style={{ marginTop: 12 }}>
            Checking session…
          </p>
        )}

        {session === null && (
          <div style={{ marginTop: 16 }}>
            <a
              href="/api/auth/discord/login"
              className="primary"
              style={{
                display: "inline-block",
                padding: "8px 14px",
                borderRadius: 6,
                background: "#5865F2",
                color: "white",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Log in with Discord
            </a>
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              Sign-in opens Discord, returns here on approval. Only Discord
              IDs listed in <code>ADMIN_DISCORD_IDS</code> can view the
              evidence below.
            </p>
          </div>
        )}

        {session && !session.isAdmin && (
          <div className="status err" style={{ marginTop: 16 }}>
            Signed in as <code>@{session.username}</code> but your Discord
            ID is not in <code>ADMIN_DISCORD_IDS</code>.
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                setSession(null);
              }}
              style={{ marginLeft: 12 }}
            >
              Log out
            </button>
          </div>
        )}

        {session?.isAdmin && (
          <>
            <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
              Signed in as <code>@{session.username}</code> ·{" "}
              <button
                onClick={async () => {
                  await fetch("/api/auth/logout", { method: "POST" });
                  setSession(null);
                  setCases(null);
                }}
                style={{ marginLeft: 4 }}
              >
                Log out
              </button>
              {" · "}
              <button onClick={load} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </p>
          </>
        )}

        {err && (
          <div className="status err" style={{ marginTop: 12 }}>
            {err}
          </div>
        )}

        {cases && cases.length === 0 && (
          <p className="muted" style={{ marginTop: 24 }}>
            No arbiter cases yet.
          </p>
        )}
        {cases && cases.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <p className="muted" style={{ fontSize: 13 }}>
              {cases.length} case{cases.length === 1 ? "" : "s"} (most
              recent first).
            </p>
            {cases.map((c) => (
              <CaseCard key={c.id} c={c} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function CaseCard({ c }: { c: ArbiterCase }) {
  const stake = (Number(BigInt(c.amount)) / 1e6).toFixed(2);
  const chainLabel = c.chain === "solana" ? "Solana" : "Base";
  const announceLink = c.announceMessageId
    ? `https://discord.com/channels/${c.guildId}/${c.channelId}/${c.announceMessageId}`
    : null;
  const phase = c.resolvedAt
    ? "RESOLVED"
    : c.arbiterDiscordId
      ? "CLAIMED"
      : "AWAITING-CLAIM";
  const phaseColor =
    phase === "AWAITING-CLAIM"
      ? "#e0533b"
      : phase === "CLAIMED"
        ? "#f6c744"
        : "#2ebe6f";
  return (
    <div
      style={{
        border: "1px solid #2a2a35",
        borderRadius: 10,
        padding: 14,
        marginTop: 14,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <code style={{ fontSize: 14, fontWeight: 600 }}>#{c.shortcode}</code>
        <span
          style={{
            background: phaseColor,
            color: "#0b0b10",
            fontSize: 12,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 6,
          }}
        >
          {phase}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {chainLabel} · {stake} USDC each
        </span>
        {announceLink && (
          <a
            href={announceLink}
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", fontSize: 13 }}
          >
            open in Discord →
          </a>
        )}
      </div>

      <div style={{ marginTop: 8, fontSize: 14 }}>
        <strong>Terms:</strong> "{c.description}"
      </div>
      {c.termsCanonical && c.termsCanonical !== c.description && (
        <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          Canonical: {c.termsCanonical}
        </div>
      )}

      <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        <strong>Challenger:</strong> {short(c.challengerId)}
        {c.challengerClaimsWinner && (
          <> (claims winner: {short(c.challengerClaimsWinner)})</>
        )}
        {" · "}
        <strong>Accepter:</strong>{" "}
        {c.accepterId ? short(c.accepterId) : "(open)"}
        {c.accepterClaimsWinner && (
          <> (claims winner: {short(c.accepterClaimsWinner)})</>
        )}
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        <strong>Requested:</strong>{" "}
        {c.arbiterRequestedAt
          ? new Date(c.arbiterRequestedAt).toLocaleString()
          : "?"}{" "}
        by {c.arbiterRequestedBy ? short(c.arbiterRequestedBy) : "?"}
        {" · "}
        <strong>Arbiter:</strong>{" "}
        {c.arbiterDiscordId
          ? short(c.arbiterDiscordId)
          : "(unclaimed)"}
        {c.winnerId && (
          <>
            {" · "}
            <strong>Winner:</strong> {short(c.winnerId)}
          </>
        )}
      </div>

      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer" }}>
          Evidence ({c.evidence.length})
        </summary>
        {c.evidence.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            No evidence collected yet.
          </p>
        ) : (
          <div style={{ marginTop: 6 }}>
            {c.evidence.map((ev, i) => (
              <div
                key={i}
                style={{
                  fontSize: 13,
                  padding: "8px 0",
                  borderBottom: "1px solid #2a2a35",
                }}
              >
                <div className="muted" style={{ marginBottom: 4 }}>
                  {short(ev.actorDiscordId)} ·{" "}
                  {new Date(ev.createdAt).toLocaleString()}
                </div>
                {ev.text && <div>{ev.text}</div>}
                {ev.attachments.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {ev.attachments.map((url, j) => (
                      <a
                        key={j}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ marginRight: 8, fontSize: 12 }}
                      >
                        attachment {j + 1}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}

function short(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
