/**
 * Public bet explorer (cozy-bet-ch8). Lists recent bets, links to chain
 * explorer for resolved txs.
 *
 * Server-rendered: hits the bot API at BOT_API_URL on each request.
 * Read-only — no auth, no wallet connection.
 */
const BOT_API_URL = process.env.BOT_API_URL ?? "http://localhost:3001";
const SOLANA_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";

type RecentBet = {
  id: string;
  shortcode: string;
  status: string;
  amount: string;
  description: string;
  challengerId: string;
  accepterId: string | null;
  winnerId: string | null;
  isOpen: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolutionTxSig: string | null;
  chainDepth: number;
};

const STATUS_CHIP: Record<string, { label: string; color: string }> = {
  proposed: { label: "Proposed", color: "#5b8cff" },
  accepted: { label: "Accepted", color: "#f6c744" },
  pending: { label: "Funding", color: "#f6c744" },
  funded: { label: "Locked", color: "#5b8cff" },
  resolved: { label: "Resolved", color: "#2ebe6f" },
  drawn: { label: "Drawn", color: "#6f7ce0" },
  refunded: { label: "Refunded", color: "#888897" },
  canceled: { label: "Canceled", color: "#888897" },
  disputed: { label: "Disputed", color: "#e0533b" },
};

async function fetchRecent(): Promise<RecentBet[]> {
  const r = await fetch(`${BOT_API_URL}/api/bets/recent?limit=100`, {
    cache: "no-store",
  });
  if (!r.ok) return [];
  return r.json();
}

function fmtUSDC(atoms: string): string {
  return (Number(BigInt(atoms)) / 1e6).toFixed(2);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function shortDiscord(id: string): string {
  return `${id.slice(0, 3)}…${id.slice(-3)}`;
}

export default async function ExplorerPage() {
  const bets = await fetchRecent();
  return (
    <main className="container" style={{ maxWidth: 980 }}>
      <div className="card">
        <h1>cozy-bet explorer</h1>
        <p className="muted">
          Last {bets.length} bets across all servers. Public, read-only.
          Resolution txs link to{" "}
          <a
            href={`https://explorer.solana.com/?cluster=${SOLANA_CLUSTER}`}
            target="_blank"
            rel="noreferrer"
          >
            Solana explorer
          </a>
          .
        </p>
        {bets.length === 0 ? (
          <p className="muted" style={{ marginTop: 24 }}>
            No bets yet. Be the first.
          </p>
        ) : (
          <div style={{ marginTop: 16 }}>
            {bets.map((b) => {
              const chip = STATUS_CHIP[b.status] ?? {
                label: b.status,
                color: "#888897",
              };
              return (
                <div key={b.id} className="row" style={{ display: "block", padding: "14px 0" }}>
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <code style={{ fontSize: 14, fontWeight: 600 }}>
                      #{b.shortcode}
                    </code>
                    <span
                      style={{
                        background: chip.color,
                        color: "#0b0b10",
                        fontSize: 12,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 6,
                      }}
                    >
                      {chip.label}
                    </span>
                    {b.isOpen && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        OPEN
                      </span>
                    )}
                    {b.chainDepth > 0 && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        🎲 Rematch #{b.chainDepth}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 13 }}>
                      <strong>{fmtUSDC(b.amount)} mUSDC</strong>{" "}
                      <span className="muted">each</span>
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                    {shortDiscord(b.challengerId)} vs{" "}
                    {b.accepterId ? shortDiscord(b.accepterId) : "(open)"}
                    {b.winnerId && (
                      <>
                        {" · "}
                        <span style={{ color: "#2ebe6f" }}>
                          🏆 {shortDiscord(b.winnerId)}
                        </span>
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 14, marginTop: 6 }}>
                    “{b.description}”
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {fmtTime(b.createdAt)}
                    {b.resolvedAt && ` → resolved ${fmtTime(b.resolvedAt)}`}
                    {b.resolutionTxSig && (
                      <>
                        {" · "}
                        <a
                          href={`https://explorer.solana.com/tx/${b.resolutionTxSig}?cluster=${SOLANA_CLUSTER}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          on-chain
                        </a>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
