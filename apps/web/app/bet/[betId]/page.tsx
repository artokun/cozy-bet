import { fetchBet } from "../../../lib/botApi";

export default async function BetStatusPage({
  params,
}: {
  params: Promise<{ betId: string }>;
}) {
  const { betId } = await params;
  let bet: Awaited<ReturnType<typeof fetchBet>> | null = null;
  try {
    bet = await fetchBet(betId);
  } catch {
    // handled below
  }
  if (!bet) {
    return (
      <main className="container">
        <div className="card">
          <h1>Bet not found</h1>
        </div>
      </main>
    );
  }
  const tokenAmount = (Number(BigInt(bet.amount)) / 1e6).toFixed(2);
  return (
    <main className="container">
      <div className="card">
        <h1>Bet #{bet.id}</h1>
        <h2>{bet.description}</h2>
        <div className="row">
          <span className="muted">Amount per side</span>
          <span>
            {tokenAmount} USDC ·{" "}
            <span className="muted">
              {bet.chain === "solana" ? "Solana" : "Base"}
            </span>
          </span>
        </div>
        <div className="row">
          <span className="muted">Status</span>
          <span>{bet.status}</span>
        </div>
        <div className="row">
          <span className="muted">Challenger deposited</span>
          <span>{bet.challengerDeposited ? "✓" : "—"}</span>
        </div>
        <div className="row">
          <span className="muted">Accepter deposited</span>
          <span>{bet.accepterDeposited ? "✓" : "—"}</span>
        </div>
      </div>
    </main>
  );
}
