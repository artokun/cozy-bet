import Link from "next/link";

export default function NotFound() {
  return (
    <main className="container" style={{ maxWidth: 480 }}>
      <div className="card">
        <h1>Not found</h1>
        <p className="muted">
          That page doesn't exist. If you arrived from a Discord DM, the bet
          might have already been resolved or the wallet-link nonce expired
          (15-minute TTL).
        </p>
        <p style={{ marginTop: 12 }}>
          <Link href="/">Back to homepage</Link>
        </p>
      </div>
    </main>
  );
}
