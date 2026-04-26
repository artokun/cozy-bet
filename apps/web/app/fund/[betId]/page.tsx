"use client";
import { use, useEffect, useMemo, useState } from "react";
import {
  useConnection,
  useWallet,
  useAnchorWallet,
} from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN } from "bn.js";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { fetchBet, notifyFunded, type BetDetail } from "../../../lib/botApi";
import { getProgram, PROGRAM_ID } from "../../../lib/program";
import {
  BASE_ESCROW,
  BASE_USDC,
  erc20Abi,
  escrowAbi,
} from "../../../lib/baseConfig";

function useBet(id: string) {
  const [bet, setBet] = useState<BetDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchBet(id).then(setBet).catch((e) => setErr(String(e)));
  }, [id]);
  return { bet, err };
}

type Status = { kind: "idle" | "busy" | "ok" | "err"; msg?: string };

export default function FundPage({
  params,
}: {
  params: Promise<{ betId: string }>;
}) {
  const { betId } = use(params);
  const { bet, err } = useBet(betId);

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

  return bet.chain === "solana" ? (
    <SolanaFund bet={bet} />
  ) : (
    <BaseFund bet={bet} />
  );
}

function BetHeader({ bet }: { bet: BetDetail }) {
  const tokenAmount = (Number(BigInt(bet.amount)) / 1e6).toFixed(2);
  const fmt = (w?: string | null) =>
    w ? `${w.slice(0, 6)}…${w.slice(-4)}` : "(unlinked)";
  const chainLabel = bet.chain === "solana" ? "Solana" : "Base";
  return (
    <>
      <h1>
        Deposit {tokenAmount} USDC <span className="muted">on {chainLabel}</span>
      </h1>
      <h2>{bet.description}</h2>
      <div className="row">
        <span className="muted">Challenger</span>
        <code>{fmt(bet.challenger.wallet)}</code>
      </div>
      <div className="row">
        <span className="muted">Accepter</span>
        <code>
          {bet.accepter?.wallet
            ? fmt(bet.accepter.wallet)
            : "(open — no accepter yet)"}
        </code>
      </div>
      <div className="row">
        <span className="muted">Status</span>
        <span>{bet.status}</span>
      </div>
    </>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (!status.msg) return null;
  return (
    <div
      className={`status ${
        status.kind === "ok" ? "ok" : status.kind === "err" ? "err" : ""
      }`}
    >
      {status.msg}
    </div>
  );
}

function SolanaFund({ bet }: { bet: BetDetail }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { connected, publicKey } = useWallet();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const tokenAmount = (Number(BigInt(bet.amount)) / 1e6).toFixed(2);

  const myRole = useMemo(() => {
    if (!publicKey) return null;
    const me = publicKey.toBase58();
    if (bet.challenger.wallet === me) return "challenger" as const;
    if (bet.accepter?.wallet === me) return "accepter" as const;
    return "stranger" as const;
  }, [publicKey, bet]);

  const alreadyFunded =
    (myRole === "challenger" && bet.challengerDeposited) ||
    (myRole === "accepter" && bet.accepterDeposited);

  async function deposit() {
    if (!wallet) return;
    setStatus({ kind: "busy", msg: "building transaction…" });
    try {
      const program = getProgram(connection, wallet);
      const betIdBn = new BN(bet.id);
      const mint = new PublicKey(bet.tokenMint);
      const depositorAta = getAssociatedTokenAddressSync(
        mint,
        wallet.publicKey,
      );

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
    } catch (e: unknown) {
      setStatus({
        kind: "err",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <main className="container">
      <div className="card">
        <BetHeader bet={bet} />
        <WalletMultiButton />
        {connected && myRole === "stranger" && (
          <div className="status err">
            Your connected wallet is not a participant in this bet.
          </div>
        )}
        {connected && alreadyFunded && (
          <div className="status ok">
            You've already deposited for this bet.
          </div>
        )}
        {connected && !alreadyFunded && myRole && myRole !== "stranger" && (
          <button
            className="primary"
            disabled={status.kind === "busy"}
            onClick={deposit}
          >
            {status.kind === "busy"
              ? "Working…"
              : `Deposit ${tokenAmount} USDC`}
          </button>
        )}
        <StatusLine status={status} />
      </div>
    </main>
  );
}

function BaseFund({ bet }: { bet: BetDetail }) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pendingTx, setPendingTx] = useState<`0x${string}` | undefined>();
  useWaitForTransactionReceipt({ hash: pendingTx });

  const stake = BigInt(bet.amount);
  const tokenAmount = (Number(stake) / 1e6).toFixed(2);

  const myRole = useMemo(() => {
    if (!address) return null;
    const norm = address.toLowerCase();
    if (bet.challenger.wallet?.toLowerCase() === norm)
      return "challenger" as const;
    if (bet.accepter?.wallet?.toLowerCase() === norm)
      return "accepter" as const;
    return "stranger" as const;
  }, [address, bet]);

  const alreadyFunded =
    (myRole === "challenger" && bet.challengerDeposited) ||
    (myRole === "accepter" && bet.accepterDeposited);

  const allowance = useReadContract({
    address: BASE_USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, BASE_ESCROW] : undefined,
    chainId: baseSepolia.id,
    query: { enabled: !!address },
  });
  const balance = useReadContract({
    address: BASE_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: baseSepolia.id,
    query: { enabled: !!address },
  });

  const hasAllowance =
    typeof allowance.data === "bigint" && allowance.data >= stake;
  const hasBalance =
    typeof balance.data === "bigint" && balance.data >= stake;

  async function approve() {
    if (!address) return;
    setStatus({ kind: "busy", msg: "approving USDC…" });
    try {
      const hash = await writeContractAsync({
        address: BASE_USDC,
        abi: erc20Abi,
        functionName: "approve",
        args: [BASE_ESCROW, stake],
        chainId: baseSepolia.id,
      });
      setPendingTx(hash);
      setStatus({ kind: "busy", msg: "waiting for confirmation…" });
      await allowance.refetch();
      setStatus({ kind: "idle" });
    } catch (e: unknown) {
      setStatus({
        kind: "err",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function deposit() {
    if (!address) return;
    setStatus({ kind: "busy", msg: "depositing…" });
    try {
      const hash = await writeContractAsync({
        address: BASE_ESCROW,
        abi: escrowAbi,
        functionName: "deposit",
        args: [BigInt(bet.id)],
        chainId: baseSepolia.id,
      });
      setPendingTx(hash);
      setStatus({ kind: "busy", msg: "waiting for confirmation…" });
      // Notify bot — it re-reads on-chain state, so the txHash is just a hint.
      await notifyFunded({
        betId: bet.id,
        depositor: address,
        signature: hash,
      });
      setStatus({
        kind: "ok",
        msg: `Deposited. Tx: ${hash}. You can return to Discord.`,
      });
    } catch (e: unknown) {
      setStatus({
        kind: "err",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <main className="container">
      <div className="card">
        <BetHeader bet={bet} />
        {!isConnected ? (
          <>
            <p className="muted">Connect a Base-compatible wallet.</p>
            {connectors.map((c) => (
              <button
                key={c.uid}
                className="primary"
                disabled={connectPending}
                onClick={() => connect({ connector: c })}
              >
                Connect with {c.name}
              </button>
            ))}
          </>
        ) : (
          <>
            <p className="muted">
              Connected as <code>{address}</code>{" "}
              <button onClick={() => disconnect()}>Disconnect</button>
            </p>
            {myRole === "stranger" && (
              <div className="status err">
                This wallet isn't a participant in this bet.
              </div>
            )}
            {alreadyFunded && (
              <div className="status ok">
                You've already deposited for this bet.
              </div>
            )}
            {!alreadyFunded && myRole && myRole !== "stranger" && (
              <>
                {!hasBalance && (
                  <div className="status err">
                    Need ≥ {tokenAmount} USDC. Top up on Base Sepolia from{" "}
                    <a
                      href="https://faucet.circle.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      faucet.circle.com
                    </a>
                    .
                  </div>
                )}
                {!hasAllowance ? (
                  <button
                    className="primary"
                    disabled={status.kind === "busy" || !hasBalance}
                    onClick={approve}
                  >
                    {status.kind === "busy"
                      ? "Working…"
                      : `Approve ${tokenAmount} USDC`}
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={status.kind === "busy"}
                    onClick={deposit}
                  >
                    {status.kind === "busy"
                      ? "Working…"
                      : `Deposit ${tokenAmount} USDC`}
                  </button>
                )}
              </>
            )}
            <StatusLine status={status} />
          </>
        )}
      </div>
    </main>
  );
}
