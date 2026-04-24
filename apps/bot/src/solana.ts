import { AnchorProvider, Program, BN, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  idl,
  findConfigPda,
  findBetPda,
  findVaultPda,
  type Escrow,
} from "@cozy-bet/shared";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

function loadKeypair(p: string): Keypair {
  const full = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const raw = JSON.parse(fs.readFileSync(full, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export const resolver = loadKeypair(env.RESOLVER_KEYPAIR_PATH);
export const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
export const programId = new PublicKey(env.PROGRAM_ID);
export const mockUsdcMint = new PublicKey(env.MOCK_USDC_MINT);
export const treasuryPubkey = new PublicKey(env.TREASURY_PUBKEY);

const provider = new AnchorProvider(connection, new Wallet(resolver), {
  preflightCommitment: "confirmed",
  commitment: "confirmed",
});

export const program = new Program<Escrow>(idl as Idl as Escrow, provider);

export { BN, TOKEN_PROGRAM_ID };

export async function initializeBetOnChain(args: {
  betId: bigint;
  amount: bigint;
  challenger: PublicKey;
  accepter: PublicKey;
}) {
  const betIdBn = new BN(args.betId.toString());
  const [betPda] = findBetPda(programId, betIdBn);
  const [vaultPda] = findVaultPda(programId, betIdBn);

  const sig = await program.methods
    .initializeBet(
      betIdBn,
      new BN(args.amount.toString()),
      args.challenger,
      args.accepter,
    )
    .accountsPartial({
      bet: betPda,
      vault: vaultPda,
      mint: mockUsdcMint,
      payer: resolver.publicKey,
    })
    .rpc();
  return { sig, betPda, vaultPda };
}

export async function ensureAta(owner: PublicKey) {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    resolver,
    mockUsdcMint,
    owner,
    true,
  );
  return ata.address;
}

export async function resolveOnChain(args: {
  betId: bigint;
  winner: PublicKey;
}) {
  const betIdBn = new BN(args.betId.toString());
  const [configPda] = findConfigPda(programId);
  const [betPda] = findBetPda(programId, betIdBn);
  const [vaultPda] = findVaultPda(programId, betIdBn);

  const winnerAta = await ensureAta(args.winner);
  const treasuryAta = await ensureAta(treasuryPubkey);

  const sig = await program.methods
    .resolve(betIdBn, args.winner)
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      winnerAta,
      treasuryAta,
      resolver: resolver.publicKey,
    })
    .rpc();
  return sig;
}

export async function refundOnChain(args: {
  betId: bigint;
  challenger: PublicKey;
  accepter: PublicKey;
}) {
  const betIdBn = new BN(args.betId.toString());
  const [configPda] = findConfigPda(programId);
  const [betPda] = findBetPda(programId, betIdBn);
  const [vaultPda] = findVaultPda(programId, betIdBn);

  const challengerAta = await ensureAta(args.challenger);
  const accepterAta = await ensureAta(args.accepter);

  const sig = await program.methods
    .refund(betIdBn)
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      challengerAta,
      accepterAta,
      resolver: resolver.publicKey,
    })
    .rpc();
  return sig;
}

export function associatedAddress(owner: PublicKey) {
  return getAssociatedTokenAddressSync(mockUsdcMint, owner);
}

/** Fetch on-chain Bet account state. Returns null if the account doesn't exist
 *  yet (pre-initialize_bet). */
export async function fetchBetOnChain(betId: bigint) {
  const betIdBn = new BN(betId.toString());
  const [betPda] = findBetPda(programId, betIdBn);
  return program.account.bet.fetchNullable(betPda);
}
