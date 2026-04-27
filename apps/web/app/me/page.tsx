"use client";
/**
 * /me — signed-in user's profile. Shows linked wallets (Solana + Base),
 * X handle, fee status (250bps default; 150bps after a verified share),
 * reliability score, active bets, and recent history. Auth: Discord
 * OAuth session cookie. Page calls /api/me which proxies through the
 * web server with the server-only ADMIN_API_TOKEN.
 */
import { useCallback, useEffect, useState } from "react";

type ProfileBet = {
  id: string;
  chain: "solana" | "base";
  shortcode: string;
  status: string;
  amount: string;
  description: string;
  opponent: string | null;
  side: "challenger" | "accepter";
  winnerId: string | null;
  myShareDiscount: boolean;
  createdAt: string;
  resolvedAt: string | null;
  guildId: string;
  channelId: string;
  announceMessageId: string | null;
};

type Profile = {
  discordId: string;
  xHandle: string | null;
  walletPubkey: string | null;
  evmAddress: string | null;
  preferredChain: "solana" | "base" | null;
  linkedAt: string | null;
  resolveEvents: number;
  resolveScoreGood: number;
  sharesVerified: number;
  won: number;
  drew: number;
  activeCount: number;
  historyCount: number;
};

type MePayload = {
  username: string;
  profile: Profile;
  active: ProfileBet[];
  history: ProfileBet[];
};

export default function MePage() {
  const [data, setData] = useState<MePayload | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/me", { cache: "no-store" });
      if (r.status === 401) {
        setData(null);
        return;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? `Fetch failed: ${r.status}`);
        return;
      }
      setData((await r.json()) as MePayload);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === undefined) {
    return (
      <main className="container">
        <div className="card">Loading…</div>
      </main>
    );
  }

  if (data === null) {
    return (
      <main className="container">
        <div className="card">
          <h1>Sign in</h1>
          <p className="muted">Connect your Discord to see your profile.</p>
          <a
            href="/api/auth/discord/login?next=/me"
            className="primary"
            style={{
              display: "inline-block",
              padding: "8px 14px",
              borderRadius: 6,
              background: "#5865F2",
              color: "white",
              textDecoration: "none",
              fontWeight: 600,
              marginTop: 12,
            }}
          >
            Log in with Discord
          </a>
        </div>
      </main>
    );
  }

  const p = data.profile;
  const reliability =
    p.resolveEvents > 0
      ? `${p.resolveScoreGood}/${p.resolveEvents} on-time`
      : "no bets yet";

  return (
    <main className="container" style={{ maxWidth: 980 }}>
      <div className="card">
        <h1>@{data.username}</h1>
        <p className="muted">
          Discord ID <code>{p.discordId}</code>
          {p.linkedAt && (
            <> · first linked {new Date(p.linkedAt).toLocaleDateString()}</>
          )}
        </p>

        <h2 style={{ marginTop: 20, fontSize: 16 }}>Wallets</h2>
        <div className="row">
          <span className="muted">Solana</span>
          <code>
            {p.walletPubkey
              ? `${p.walletPubkey.slice(0, 8)}…${p.walletPubkey.slice(-4)}`
              : "not linked"}
          </code>
        </div>
        <div className="row">
          <span className="muted">Base</span>
          <code>
            {p.evmAddress
              ? `${p.evmAddress.slice(0, 6)}…${p.evmAddress.slice(-4)}`
              : "not linked"}
          </code>
        </div>
        <div className="row">
          <span className="muted">Preferred</span>
          <span>
            {p.preferredChain
              ? p.preferredChain === "solana"
                ? "Solana"
                : "Base"
              : "—"}
          </span>
        </div>

        <h2 style={{ marginTop: 20, fontSize: 16 }}>X (Twitter) + share fee</h2>
        <div className="row">
          <span className="muted">Handle</span>
          <code>{p.xHandle ? `@${p.xHandle}` : "not linked"}</code>
        </div>
        <div className="row">
          <span className="muted">Verified shares</span>
          <span>
            <strong>{p.sharesVerified}</strong>{" "}
            <span className="muted">
              (each redeems a 250→150bps fee discount on its bet)
            </span>
          </span>
        </div>

        <h2 style={{ marginTop: 20, fontSize: 16 }}>Reliability</h2>
        <div className="row">
          <span className="muted">Resolution score</span>
          <span>{reliability}</span>
        </div>
        <div className="row">
          <span className="muted">Wins · Draws</span>
          <span>
            {p.won} · {p.drew}
          </span>
        </div>

        <h2 style={{ marginTop: 24, fontSize: 16 }}>
          Active bets ({p.activeCount})
        </h2>
        {data.active.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <BetList bets={data.active} />
        )}

        <h2 style={{ marginTop: 24, fontSize: 16 }}>
          Recent history ({p.historyCount})
        </h2>
        {data.history.length === 0 ? (
          <p className="muted">No completed bets yet.</p>
        ) : (
          <BetList bets={data.history} />
        )}

        {err && (
          <div className="status err" style={{ marginTop: 16 }}>
            {err}
          </div>
        )}
      </div>
    </main>
  );
}

function BetList({ bets }: { bets: ProfileBet[] }) {
  return (
    <div style={{ marginTop: 8 }}>
      {bets.map((b) => (
        <BetRow key={b.id} b={b} />
      ))}
    </div>
  );
}

function BetRow({ b }: { b: ProfileBet }) {
  const stake = (Number(BigInt(b.amount)) / 1e6).toFixed(2);
  const chainLabel = b.chain === "solana" ? "Solana" : "Base";
  const link = b.announceMessageId
    ? `https://discord.com/channels/${b.guildId}/${b.channelId}/${b.announceMessageId}`
    : null;
  return (
    <div
      style={{
        borderBottom: "1px solid #2a2a35",
        padding: "10px 0",
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <code style={{ fontSize: 13, fontWeight: 600 }}>#{b.shortcode}</code>
      <span className="muted" style={{ fontSize: 12 }}>
        {b.status}
      </span>
      <span className="muted" style={{ fontSize: 12 }}>
        {chainLabel} · {stake} USDC
      </span>
      {b.myShareDiscount && (
        <span
          className="muted"
          style={{ fontSize: 11, color: "#2ebe6f" }}
          title="Verified share — your fee on this bet was 150bps"
        >
          ✓ shared
        </span>
      )}
      <span style={{ fontSize: 13, marginLeft: "auto" }}>
        {b.side === "challenger" ? "challenged" : "accepted"}
        {b.opponent && (
          <>
            {" "}
            <code className="muted" style={{ fontSize: 12 }}>
              {b.opponent.slice(0, 4)}…{b.opponent.slice(-4)}
            </code>
          </>
        )}
        {b.winnerId === b.opponent && b.status === "resolved" && (
          <span style={{ color: "#e0533b", marginLeft: 6 }}>· lost</span>
        )}
        {b.winnerId && b.winnerId !== b.opponent && b.status === "resolved" && (
          <span style={{ color: "#2ebe6f", marginLeft: 6 }}>· won</span>
        )}
        {b.status === "drawn" && (
          <span className="muted" style={{ marginLeft: 6 }}>
            · draw
          </span>
        )}
      </span>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12 }}
        >
          discord →
        </a>
      )}
    </div>
  );
}
