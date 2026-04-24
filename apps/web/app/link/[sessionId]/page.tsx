"use client";
import { use, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import {
  fetchSession,
  confirmLink,
  type WalletLinkSession,
} from "../../../lib/botApi";

export default function LinkPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const { publicKey, signMessage, connected } = useWallet();
  const [session, setSession] = useState<WalletLinkSession | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "ok" | "err"; msg?: string }>({
    kind: "idle",
  });

  useEffect(() => {
    fetchSession(sessionId)
      .then(setSession)
      .catch((e) => setStatus({ kind: "err", msg: String(e) }));
  }, [sessionId]);

  async function link() {
    if (!publicKey || !signMessage || !session) return;
    setStatus({ kind: "busy", msg: "waiting for signature…" });
    try {
      const message = `cozy-bet link: ${session.nonce} for discord:${session.discordId}`;
      const sig = await signMessage(new TextEncoder().encode(message));
      const res = await confirmLink({
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
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.message ?? String(e) });
    }
  }

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

  return (
    <main className="container">
      <div className="card">
        <h1>Link your wallet</h1>
        <h2>
          for Discord: <code>{session?.discordTag ?? session?.discordId}</code>
        </h2>
        {session?.used ? (
          <p className="status">This link has already been used.</p>
        ) : (
          <>
            <WalletMultiButton />
            <button
              className="primary"
              disabled={!connected || status.kind === "busy"}
              onClick={link}
            >
              {status.kind === "busy" ? "Signing…" : "Sign to link"}
            </button>
            {status.msg && (
              <div
                className={`status ${
                  status.kind === "ok" ? "ok" : status.kind === "err" ? "err" : ""
                }`}
              >
                {status.msg}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
