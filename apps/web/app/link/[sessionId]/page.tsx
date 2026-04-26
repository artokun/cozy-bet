"use client";
import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import {
  fetchSession,
  confirmLink,
  type WalletLinkSession,
  type Chain,
} from "../../../lib/botApi";

export default function LinkPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const search = useSearchParams();
  const chain: Chain =
    search?.get("chain") === "base" ? "base" : "solana";
  const [session, setSession] = useState<WalletLinkSession | null>(null);
  const [status, setStatus] = useState<{
    kind: "idle" | "busy" | "ok" | "err";
    msg?: string;
  }>({ kind: "idle" });

  useEffect(() => {
    fetchSession(sessionId)
      .then(setSession)
      .catch((e) => setStatus({ kind: "err", msg: String(e) }));
  }, [sessionId]);

  if (!session && status.kind === "idle") {
    return (
      <main className="container">
        <div className="card">Loading session…</div>
      </main>
    );
  }
  if (status.kind === "err" && !session) {
    return (
      <main className="container">
        <div className="card">
          <h1>Invalid session</h1>
          <p className="muted">{status.msg}</p>
        </div>
      </main>
    );
  }

  const message = session
    ? `cozy-bet link: ${session.nonce} for discord:${session.discordId}`
    : "";

  return (
    <main className="container">
      <div className="card">
        <h1>Link your {chain === "solana" ? "Solana" : "Base"} wallet</h1>
        <h2>
          for Discord: <code>{session?.discordTag ?? session?.discordId}</code>
        </h2>
        {session?.used ? (
          <p className="status">This link has already been used.</p>
        ) : chain === "solana" ? (
          <SolanaLink
            message={message}
            session={session!}
            status={status}
            setStatus={setStatus}
          />
        ) : (
          <BaseLink
            message={message}
            session={session!}
            status={status}
            setStatus={setStatus}
          />
        )}
      </div>
    </main>
  );
}

function StatusLine({
  status,
}: {
  status: { kind: string; msg?: string };
}) {
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

function SolanaLink({
  message,
  session,
  status,
  setStatus,
}: {
  message: string;
  session: WalletLinkSession;
  status: { kind: "idle" | "busy" | "ok" | "err"; msg?: string };
  setStatus: (s: { kind: "idle" | "busy" | "ok" | "err"; msg?: string }) => void;
}) {
  const { publicKey, signMessage, connected } = useWallet();
  async function link() {
    if (!publicKey || !signMessage) return;
    setStatus({ kind: "busy", msg: "waiting for signature…" });
    try {
      const sig = await signMessage(new TextEncoder().encode(message));
      const res = await confirmLink({
        chain: "solana",
        nonce: session.nonce,
        walletPubkey: publicKey.toBase58(),
        signatureB58: bs58.encode(sig),
        message,
      });
      if (res.ok) {
        setStatus({
          kind: "ok",
          msg: "Linked. You can close this tab and return to Discord.",
        });
      } else {
        setStatus({ kind: "err", msg: res.error });
      }
    } catch (e: unknown) {
      setStatus({
        kind: "err",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return (
    <>
      <WalletMultiButton />
      <button
        className="primary"
        disabled={!connected || status.kind === "busy"}
        onClick={link}
      >
        {status.kind === "busy" ? "Signing…" : "Sign to link"}
      </button>
      <StatusLine status={status} />
    </>
  );
}

function BaseLink({
  message,
  session,
  status,
  setStatus,
}: {
  message: string;
  session: WalletLinkSession;
  status: { kind: "idle" | "busy" | "ok" | "err"; msg?: string };
  setStatus: (s: { kind: "idle" | "busy" | "ok" | "err"; msg?: string }) => void;
}) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();

  async function link() {
    if (!address) return;
    setStatus({ kind: "busy", msg: "waiting for signature…" });
    try {
      const signature = await signMessageAsync({ message });
      const res = await confirmLink({
        chain: "base",
        nonce: session.nonce,
        address,
        signatureHex: signature,
        message,
      });
      if (res.ok) {
        setStatus({
          kind: "ok",
          msg: "Linked. You can close this tab and return to Discord.",
        });
      } else {
        setStatus({ kind: "err", msg: res.error });
      }
    } catch (e: unknown) {
      setStatus({
        kind: "err",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (!isConnected) {
    return (
      <>
        <p className="muted">
          Connect a Base-compatible wallet (Coinbase Smart Wallet recommended).
        </p>
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
        <StatusLine status={status} />
      </>
    );
  }

  return (
    <>
      <p className="muted">
        Connected as <code>{address}</code>
      </p>
      <button
        className="primary"
        disabled={status.kind === "busy"}
        onClick={link}
      >
        {status.kind === "busy" ? "Signing…" : "Sign to link"}
      </button>
      <button onClick={() => disconnect()}>Disconnect</button>
      <StatusLine status={status} />
    </>
  );
}
