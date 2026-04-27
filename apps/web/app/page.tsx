import Link from "next/link";

export default function Home() {
  return (
    <main className="container" style={{ maxWidth: 720 }}>
      <div className="card">
        <h1>cozy-bet</h1>
        <p className="muted">
          Peer-to-peer wagering with on-chain escrow on Solana <em>or</em>{" "}
          Base. Each bet lives on whichever chain the challenger picks at{" "}
          <code>/saybet</code> time. Funds never sit with an operator —
          payouts are smart-contract-enforced.
        </p>

        <h2 style={{ marginTop: 24, fontSize: 16 }}>For users</h2>
        <ul style={{ marginTop: 6, lineHeight: 1.8 }}>
          <li>
            <Link href="/me">/me</Link> — your wallets, X share status,
            reliability score, active bets, history.
          </li>
          <li>
            <Link href="/explorer">/explorer</Link> — public feed of recent
            bets across all servers.
          </li>
          <li>
            <code>/link/&lt;session&gt;</code>,{" "}
            <code>/fund/&lt;bet-id&gt;</code>,{" "}
            <code>/bet/&lt;bet-id&gt;</code> — landed via Discord DM during
            the wallet-link / deposit / status flows.
          </li>
        </ul>

        <h2 style={{ marginTop: 24, fontSize: 16 }}>For admins</h2>
        <ul style={{ marginTop: 6, lineHeight: 1.8 }}>
          <li>
            <Link href="/admin/arbiter-cases">/admin/arbiter-cases</Link> —
            inspect arbiter cases + collected evidence. Discord-OAuth gated
            to <code>ADMIN_DISCORD_IDS</code>.
          </li>
        </ul>

        <h2 style={{ marginTop: 24, fontSize: 16 }}>Status</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Testnet only. Solana program deployed at{" "}
          <code>nqQkfoyx…vcQzS6yt</code> on devnet; Base escrow at{" "}
          <code>0xffcC554C…26775F71</code> on Sepolia. See README for the
          full setup + slash command catalog.
        </p>
      </div>
    </main>
  );
}
