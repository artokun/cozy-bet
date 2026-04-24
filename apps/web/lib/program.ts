"use client";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "@cozy-bet/shared/idl" with { type: "json" };
import type { Escrow } from "@cozy-bet/shared/idl-types";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ??
    "nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt",
);

export function getProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });
  return new Program<Escrow>(idl as Idl as Escrow, provider);
}

export { BN };
