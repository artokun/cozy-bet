import { AnchorProvider, Program, BN, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
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
export const arbiter = env.ARBITER_KEYPAIR_PATH
  ? loadKeypair(env.ARBITER_KEYPAIR_PATH)
  : resolver;
export const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");

/** Wrap `new PublicKey(...)` so an env mistake (most commonly an EVM
 *  0x... address pasted into a Solana slot) prints a labeled error
 *  with the env-var name + the offending value instead of solana-web3.js's
 *  cryptic "Non-base58 character" or "Invalid public key input". */
function envPubkey(envName: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch (e: unknown) {
    console.error(
      `❌ env.${envName} is not a valid Solana base58 pubkey: ${value}`,
    );
    if (/^0x[0-9a-f]{40}$/i.test(value)) {
      console.error(
        `   That looks like an EVM address. The Solana env vars (PROGRAM_ID, MOCK_USDC_MINT, TREASURY_OWNER_*, ARBITER_PUBKEY) want base58 — see .env.example for examples.`,
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}
export const programId = envPubkey("PROGRAM_ID", env.PROGRAM_ID);
export const mockUsdcMint = envPubkey("MOCK_USDC_MINT", env.MOCK_USDC_MINT);
export const treasuryOwners: [PublicKey, PublicKey, PublicKey, PublicKey] = [
  envPubkey("TREASURY_OWNER_1", env.TREASURY_OWNER_1),
  envPubkey("TREASURY_OWNER_2", env.TREASURY_OWNER_2),
  envPubkey("TREASURY_OWNER_3", env.TREASURY_OWNER_3),
  envPubkey("TREASURY_OWNER_4", env.TREASURY_OWNER_4),
];

const provider = new AnchorProvider(connection, new Wallet(resolver), {
  preflightCommitment: "confirmed",
  commitment: "confirmed",
});

export const program = new Program<Escrow>(idl as Idl as Escrow, provider);

export { BN, TOKEN_PROGRAM_ID };

const ZERO_TERMS_HASH: number[] = Array(32).fill(0);

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

async function getTreasuryAtas(): Promise<
  [PublicKey, PublicKey, PublicKey, PublicKey]
> {
  return [
    await ensureAta(treasuryOwners[0]),
    await ensureAta(treasuryOwners[1]),
    await ensureAta(treasuryOwners[2]),
    await ensureAta(treasuryOwners[3]),
  ];
}

export async function initializeBetOnChain(args: {
  betId: bigint;
  amount: bigint;
  challenger: PublicKey;
  accepter: PublicKey;
  /** keccak/sha256 hash of canonical terms (32 bytes); pass null for legacy. */
  termsHash?: Uint8Array | number[] | null;
}) {
  const betIdBn = new BN(args.betId.toString());
  const [configPda] = findConfigPda(programId);
  const [betPda] = findBetPda(programId, betIdBn);
  const [vaultPda] = findVaultPda(programId, betIdBn);

  const termsHashArr: number[] = args.termsHash
    ? Array.from(args.termsHash)
    : ZERO_TERMS_HASH;
  if (termsHashArr.length !== 32) {
    throw new Error(`termsHash must be 32 bytes, got ${termsHashArr.length}`);
  }

  const sig = await program.methods
    .initializeBet(
      betIdBn,
      new BN(args.amount.toString()),
      args.challenger,
      args.accepter,
      termsHashArr,
    )
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      mint: mockUsdcMint,
      resolver: resolver.publicKey,
      payer: resolver.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { sig, betPda, vaultPda };
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
  const [t0, t1, t2, t3] = await getTreasuryAtas();

  const sig = await program.methods
    .resolve(betIdBn, args.winner)
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      winnerAta,
      treasuryAta0: t0,
      treasuryAta1: t1,
      treasuryAta2: t2,
      treasuryAta3: t3,
      resolver: resolver.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return sig;
}

export async function arbiterResolveOnChain(args: {
  betId: bigint;
  winner: PublicKey;
}) {
  const betIdBn = new BN(args.betId.toString());
  const [configPda] = findConfigPda(programId);
  const [betPda] = findBetPda(programId, betIdBn);
  const [vaultPda] = findVaultPda(programId, betIdBn);

  const winnerAta = await ensureAta(args.winner);
  const arbiterAta = await ensureAta(arbiter.publicKey);
  const [t0, t1, t2, t3] = await getTreasuryAtas();

  const sig = await program.methods
    .arbiterResolve(betIdBn, args.winner)
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      winnerAta,
      treasuryAta0: t0,
      treasuryAta1: t1,
      treasuryAta2: t2,
      treasuryAta3: t3,
      arbiterAta,
      arbiter: arbiter.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers(arbiter === resolver ? [] : [arbiter])
    .rpc();
  return sig;
}

export async function drawOnChain(args: {
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
    .draw(betIdBn)
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      challengerAta,
      accepterAta,
      resolver: resolver.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
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
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return sig;
}

export async function setFeeBpsForSideOnChain(args: {
  betId: bigint;
  side: PublicKey;
  newBps: number;
}) {
  const betIdBn = new BN(args.betId.toString());
  const [configPda] = findConfigPda(programId);
  const [betPda] = findBetPda(programId, betIdBn);

  const sig = await program.methods
    .setFeeBpsForSide(betIdBn, args.side, args.newBps)
    .accountsPartial({
      config: configPda,
      bet: betPda,
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
