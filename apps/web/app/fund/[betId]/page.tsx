"use client";
import { use, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { fetchBet, notifyFunded, type BetDetail } from "../../../lib/botApi";
import { getProgram, PROGRAM_ID } from "../../../lib/program";

function useBet(id: string) {
  const [bet, setBet] = useState<BetDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchBet(id).then(setBet).catch((e) => setErr(String(e)));
  }, [id]);
  return { bet, err };
}

export default function FundPage({
  params,
}: {
  params: Promise<{ betId: string }>;
}) {
  const { betId } = use(params);
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { connected, publicKey } = useWallet();
  const { bet, err } = useBet(betId);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "ok" | "err"; msg?: string }>({
    kind: "idle",
  });

  const myRole = useMemo(() => {
    if (!publicKey || !bet) return null;
    const me = publicKey.toBase58();
    if (bet.challenger.wallet === me) return "challenger" as const;
    if (bet.accepter.wallet === me) return "accepter" as const;
    return "stranger" as const;
  }, [publicKey, bet]);

  const alreadyFunded =
    (myRole === "challenger" && bet?.challengerDeposited) ||
    (myRole === "accepter" && bet?.accepterDeposited);

  async function deposit() {
    if (!wallet || !bet) return;
    setStatus({ kind: "busy", msg: "building transaction…" });
    try {
      const program = getProgram(connection, wallet);
      const betIdBn = new BN(bet.id);
      const mint = new PublicKey(bet.tokenMint);
      const depositorAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);

      const betPda =
        bet.betPda != null
          ? new PublicKey(bet.betPda)
          : PublicKey.findProgramAddressSync(
              [Buffer.from("bet"), betIdBn.toArrayLike(Buffer, "le", 8)],
              PROGRAM_ID,
            )[0];
      const vaultPda =
        bet.vaultPda != null
          ? new PublicKey(bet.vaultPda)
          : PublicKey.findProgramAddressSync(
              [Buffer.from("vault"), betIdBn.toArrayLike(Buffer, "le", 8)],
              PROGRAM_ID,
            )[0];

      const sig = await program.methods
        .deposit(betIdBn)
        .accountsPartial({
          bet: betPda,
          vault: vaultPda,
          depositorAta,
          depositor: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      setStatus({ kind: "busy", msg: "confirming on-chain…" });
      await connection.confirmTransaction(sig, "confirmed");

      await notifyFunded({
        betId: bet.id,
        depositor: wallet.publicKey.toBase58(),
        signature: sig,
      });
      setStatus({
        kind: "ok",
        msg: `Deposited. Signature: ${sig}. You can return to Discord.`,
      });
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.message ?? String(e) });
    }
  }

  if (err) {
    return (
      <main className="container">
        <div className="card">
          <h1>Bet not found</h1>
          <p className="muted">{err}</p>
        </div>
      </main>
    );
  }
  if (!bet) {
    return (
      <main className="container">
        <div className="card">Loading…</div>
      </main>
    );
  }

  const tokenAmount = (Number(BigInt(bet.amount)) / 1e6).toFixed(2);

  return (
    <main className="container">
      <div className="card">
        <h1>Deposit {tokenAmount} mUSDC</h1>
        <h2>{bet.description}</h2>
        <div className="row">
          <span className="muted">Challenger</span>
          <code>
            {bet.challenger.wallet?.slice(0, 6)}…{bet.challenger.wallet?.slice(-4)}
          </code>
        </div>
        <div className="row">
          <span className="muted">Accepter</span>
          <code>
            {bet.accepter.wallet?.slice(0, 6)}…{bet.accepter.wallet?.slice(-4)}
          </code>
        </div>
        <div className="row">
          <span className="muted">Status</span>
          <span>{bet.status}</span>
        </div>
        <WalletMultiButton />
        {connected && myRole === "stranger" && (
          <div className="status err">
            Your connected wallet is not a participant in this bet.
          </div>
        )}
        {connected && alreadyFunded && (
          <div className="status ok">You've already deposited for this bet.</div>
        )}
        {connected && !alreadyFunded && myRole && myRole !== "stranger" && (
          <button
            className="primary"
            disabled={status.kind === "busy"}
            onClick={deposit}
          >
            {status.kind === "busy" ? "Working…" : `Deposit ${tokenAmount} mUSDC`}
          </button>
        )}
        {status.msg && (
          <div
            className={`status ${
              status.kind === "ok" ? "ok" : status.kind === "err" ? "err" : ""
            }`}
          >
            {status.msg}
          </div>
        )}
      </div>
    </main>
  );
}
