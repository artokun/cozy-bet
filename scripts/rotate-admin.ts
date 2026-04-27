/**
 * Rotate program/contract admin to a new address (e.g. a Squads vault on
 * Solana or a Safe on Base).
 *
 * Solana branch:
 *   - Loads the bot resolver keypair (current authority)
 *   - Sends update_authority(new_admin) on the deployed program
 *
 * Base branch:
 *   - Uses RESOLVER_PRIVATE_KEY env (current admin)
 *   - Calls grantRole(DEFAULT_ADMIN_ROLE, new) then renounceRole on old
 *
 * Usage:
 *   pnpm tsx scripts/rotate-admin.ts --chain solana --new-admin <pubkey>
 *   pnpm tsx scripts/rotate-admin.ts --chain base --new-admin 0x...
 *
 *   --cluster <mainnet-beta|devnet>          (Solana, default devnet)
 *   --network <base|base-sepolia>            (Base, default base-sepolia)
 *   --dry-run                                 print what would happen, exit 0
 *
 * Safety: the script REFUSES to send unless the user confirms by passing
 * --confirm. Dry-run is the default if --confirm is missing. This is a
 * one-way action on mainnet — a typo'd new-admin pubkey bricks admin.
 */
import "dotenv/config";
import fs from "node:fs";
import {
  AnchorProvider,
  Program,
  Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base as baseMainnet } from "viem/chains";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";

type Args = {
  chain: "solana" | "base";
  newAdmin: string;
  cluster: string;
  network: "base" | "base-sepolia";
  dryRun: boolean;
  confirm: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const chain = get("chain");
  if (chain !== "solana" && chain !== "base") {
    bail("--chain solana|base is required");
  }
  const newAdmin = get("new-admin");
  if (!newAdmin) bail("--new-admin <address> is required");
  return {
    chain: chain as "solana" | "base",
    newAdmin: newAdmin!,
    cluster: get("cluster") ?? "devnet",
    network: (get("network") as Args["network"]) ?? "base-sepolia",
    dryRun: !has("confirm") || has("dry-run"),
    confirm: has("confirm"),
  };
}

function bail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(
    "Usage: pnpm tsx scripts/rotate-admin.ts --chain solana|base --new-admin <addr> [--cluster|--network ...] [--confirm]",
  );
  process.exit(2);
}

async function rotateSolana(args: Args): Promise<void> {
  const rpc =
    args.cluster === "mainnet-beta"
      ? "https://api.mainnet-beta.solana.com"
      : args.cluster === "testnet"
        ? "https://api.testnet.solana.com"
        : "https://api.devnet.solana.com";
  const PROGRAM_ID = new PublicKey(
    "nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt",
  );
  const newAdminPk = new PublicKey(args.newAdmin); // throws on bad input
  const keypairPath =
    process.env.RESOLVER_KEYPAIR_PATH ?? "./keys/bot-resolver.json";
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(raw));

  const connection = new Connection(rpc, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(authority), {
    preflightCommitment: "confirmed",
  });
  const program = new Program<Escrow>(idl as Idl as Escrow, provider);
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );

  // Read current authority before doing anything.
  const cfg = await program.account.config.fetch(configPda);
  console.log(`Solana ${args.cluster}`);
  console.log(`  program:           ${PROGRAM_ID.toBase58()}`);
  console.log(`  current authority: ${cfg.authority.toBase58()}`);
  console.log(`  new authority:     ${newAdminPk.toBase58()}`);
  if (cfg.authority.toBase58() !== authority.publicKey.toBase58()) {
    console.error(
      `  ✗ resolver keypair (${authority.publicKey.toBase58()}) is not the current authority — cannot rotate`,
    );
    process.exit(1);
  }
  if (cfg.authority.toBase58() === newAdminPk.toBase58()) {
    console.log("  authority already matches — nothing to do");
    return;
  }

  if (args.dryRun) {
    console.log("\n[dry-run] no transaction sent. Pass --confirm to execute.");
    return;
  }

  const sig = await program.methods
    .updateAuthority(newAdminPk)
    .accountsPartial({
      config: configPda,
      authority: authority.publicKey,
    })
    .rpc();
  await connection.confirmTransaction(sig, "confirmed");
  const explorer =
    args.cluster === "mainnet-beta"
      ? `https://explorer.solana.com/tx/${sig}`
      : `https://explorer.solana.com/tx/${sig}?cluster=${args.cluster}`;
  console.log(`\n✅ rotated. tx: ${explorer}`);
}

async function rotateBase(args: Args): Promise<void> {
  const ESCROW = process.env.EVM_ESCROW_ADDRESS as Address | undefined;
  if (!ESCROW) bail("EVM_ESCROW_ADDRESS env not set");
  const RESOLVER_PK = process.env.RESOLVER_PRIVATE_KEY as Hex | undefined;
  if (!RESOLVER_PK) bail("RESOLVER_PRIVATE_KEY env not set");
  if (!/^0x[a-fA-F0-9]{40}$/.test(args.newAdmin)) {
    bail(`--new-admin doesn't look like a 0x EVM address: ${args.newAdmin}`);
  }
  const account = privateKeyToAccount(RESOLVER_PK);
  const chain = args.network === "base" ? baseMainnet : baseSepolia;
  const rpc = args.network === "base"
    ? "https://mainnet.base.org"
    : "https://sepolia.base.org";

  const pub = createPublicClient({ chain, transport: http(rpc) } as never);
  const wal = createWalletClient({
    account,
    chain,
    transport: http(rpc),
  } as never);

  // OZ AccessControl: DEFAULT_ADMIN_ROLE is keccak256("DEFAULT_ADMIN_ROLE")
  // — but the canonical OZ value is bytes32(0). Use the constant the
  // contract exports rather than hashing the string.
  const DEFAULT_ADMIN_ROLE =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

  const ABI = [
    {
      type: "function",
      name: "hasRole",
      stateMutability: "view",
      inputs: [
        { name: "role", type: "bytes32" },
        { name: "account", type: "address" },
      ],
      outputs: [{ type: "bool" }],
    },
    {
      type: "function",
      name: "grantRole",
      stateMutability: "nonpayable",
      inputs: [
        { name: "role", type: "bytes32" },
        { name: "account", type: "address" },
      ],
      outputs: [],
    },
    {
      type: "function",
      name: "renounceRole",
      stateMutability: "nonpayable",
      inputs: [
        { name: "role", type: "bytes32" },
        { name: "callerConfirmation", type: "address" },
      ],
      outputs: [],
    },
  ] as const;

  // Pre-flight checks.
  const oldHasAdmin = (await pub.readContract({
    address: ESCROW,
    abi: ABI,
    functionName: "hasRole",
    args: [DEFAULT_ADMIN_ROLE, account.address],
  })) as boolean;
  const newHasAdmin = (await pub.readContract({
    address: ESCROW,
    abi: ABI,
    functionName: "hasRole",
    args: [DEFAULT_ADMIN_ROLE, args.newAdmin as Address],
  })) as boolean;

  console.log(`Base ${args.network}`);
  console.log(`  escrow:        ${ESCROW}`);
  console.log(`  current admin: ${account.address} (hasAdmin=${oldHasAdmin})`);
  console.log(`  new admin:     ${args.newAdmin} (hasAdmin=${newHasAdmin})`);
  if (!oldHasAdmin) {
    console.error("  ✗ resolver does not currently have DEFAULT_ADMIN_ROLE — cannot rotate");
    process.exit(1);
  }

  if (args.dryRun) {
    console.log("\n[dry-run] no transaction sent. Pass --confirm to execute.");
    return;
  }

  const explorerBase =
    args.network === "base"
      ? "https://basescan.org"
      : "https://sepolia.basescan.org";

  if (!newHasAdmin) {
    const grantHash = await wal.writeContract({
      account,
      chain,
      address: ESCROW,
      abi: ABI,
      functionName: "grantRole",
      args: [DEFAULT_ADMIN_ROLE, args.newAdmin as Address],
    } as never);
    await pub.waitForTransactionReceipt({ hash: grantHash });
    console.log(`  granted: ${explorerBase}/tx/${grantHash}`);
  } else {
    console.log("  new admin already has role — skipping grantRole");
  }

  const renounceHash = await wal.writeContract({
    account,
    chain,
    address: ESCROW,
    abi: ABI,
    functionName: "renounceRole",
    args: [DEFAULT_ADMIN_ROLE, account.address],
  } as never);
  await pub.waitForTransactionReceipt({ hash: renounceHash });
  console.log(`  renounced: ${explorerBase}/tx/${renounceHash}`);

  // Verify final state.
  const finalOld = (await pub.readContract({
    address: ESCROW,
    abi: ABI,
    functionName: "hasRole",
    args: [DEFAULT_ADMIN_ROLE, account.address],
  })) as boolean;
  const finalNew = (await pub.readContract({
    address: ESCROW,
    abi: ABI,
    functionName: "hasRole",
    args: [DEFAULT_ADMIN_ROLE, args.newAdmin as Address],
  })) as boolean;
  if (finalOld || !finalNew) {
    console.error(
      `  ✗ unexpected final state: old=${finalOld}, new=${finalNew}`,
    );
    process.exit(1);
  }
  console.log("\n✅ rotated.");
}

async function main() {
  const args = parseArgs();
  if (args.dryRun && !args.confirm) {
    console.log(
      "Running in DRY-RUN mode. To actually rotate, re-run with --confirm.\n",
    );
  }
  if (args.chain === "solana") {
    await rotateSolana(args);
  } else {
    await rotateBase(args);
  }
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});
