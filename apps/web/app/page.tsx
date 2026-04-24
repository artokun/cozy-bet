export default function Home() {
  return (
    <main className="container">
      <div className="card">
        <h1>cozy-bet</h1>
        <p className="muted">
          Peer-to-peer wagering with on-chain escrow on Solana.
        </p>
        <p className="muted" style={{ marginTop: 16 }}>
          This page is used by the Discord bot — you usually land here via a
          DM link. Open <code>/link/&lt;session&gt;</code> or{" "}
          <code>/fund/&lt;bet-id&gt;</code>.
        </p>
      </div>
    </main>
  );
}
