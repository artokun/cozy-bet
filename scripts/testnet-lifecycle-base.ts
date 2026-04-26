/**
 * Full Base Sepolia lifecycle test.
 *
 * Spends ~0.0001 ETH (gas) + 100 USDC (stakes, returned to winner minus fee)
 * from the resolver per run. The resolver wallet must have:
 *   - ≥ 0.0005 ETH (deploy + fund-test-users + 4 contract calls)
 *   - ≥ 100 USDC (fund test users with 50 each)
 *
 * If either is missing, prints what's needed and exits gracefully.
 *
 *   pnpm tsx scripts/testnet-lifecycle-base.ts
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  type Address,
  type Hex,
  erc20Abi,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ESCROW = "0xffcC554C4157B9363ab561237e3cc02626775F71" as Address;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const RESOLVER_PK = process.env.RESOLVER_PRIVATE_KEY as Hex | undefined;

const ESCROW_ABI = [
  {
    type: "function",
    name: "initializeBet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "challenger", type: "address" },
      { name: "accepter", type: "address" },
      { name: "termsHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "betId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "betId", type: "uint256" },
      { name: "winner", type: "address" },
    ],
    outputs: [],
  },
] as const;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const start = Date.now();
  console.log(`testnet lifecycle (Base Sepolia) @ ${new Date().toISOString()}\n`);

  if (!RESOLVER_PK) {
    console.log("  ⚠️  RESOLVER_PRIVATE_KEY not set — skip");
    process.exit(0);
  }
  const resolver = privateKeyToAccount(RESOLVER_PK);

  const pub = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  } as never);
  const wal = createWalletClient({
    account: resolver,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  } as never);

  const eth = await pub.getBalance({ address: resolver.address });
  const usdc = (await pub.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [resolver.address],
  })) as bigint;

  console.log(`  resolver: ${resolver.address}`);
  console.log(`  ETH:  ${formatUnits(eth, 18)}`);
  console.log(`  USDC: ${formatUnits(usdc, 6)}`);

  const NEED_ETH = 500_000_000_000_000n; // 0.0005 ETH
  const NEED_USDC = 100_000_000n; // 100 USDC
  if (eth < NEED_ETH || usdc < NEED_USDC) {
    console.log(
      `\n  ⚠️  insufficient balance for lifecycle test (need ≥ ${formatUnits(NEED_ETH, 18)} ETH and ≥ ${formatUnits(NEED_USDC, 6)} USDC).`,
    );
    console.log("  Top up:");
    console.log("    ETH:  https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet");
    console.log("    USDC: https://faucet.circle.com (Base Sepolia)");
    console.log("  Or use scripts/fund-base-sepolia.ts for the resolver.");
    process.exit(0); // not a failure — just unfunded
  }

  // Generate two ephemeral test users
  const challengerPk = generatePrivateKey();
  const accepterPk = generatePrivateKey();
  const challenger = privateKeyToAccount(challengerPk);
  const accepter = privateKeyToAccount(accepterPk);
  console.log(
    `  test users: ${challenger.address.slice(0, 8)}…, ${accepter.address.slice(0, 8)}…`,
  );

  // Resolver funds each with 0.0002 ETH (gas) + 50 USDC (stake)
  const ETH_FUND = 200_000_000_000_000n; // 0.0002 ETH
  const USDC_STAKE = 50_000_000n; // 50 USDC

  for (const u of [challenger, accepter]) {
    // Send ETH
    const t1 = await wal.sendTransaction({
      account: resolver,
      chain: baseSepolia,
      to: u.address,
      value: ETH_FUND,
    } as never);
    await pub.waitForTransactionReceipt({ hash: t1 });
    // Send USDC
    const t2 = await wal.writeContract({
      account: resolver,
      chain: baseSepolia,
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [u.address, USDC_STAKE],
    } as never);
    await pub.waitForTransactionReceipt({ hash: t2 });
  }
  check("test users funded with ETH + USDC", true);

  // Initialize bet (resolver signs)
  const betId = BigInt(Date.now());
  const tInit = await wal.writeContract({
    account: resolver,
    chain: baseSepolia,
    address: ESCROW,
    abi: ESCROW_ABI,
    functionName: "initializeBet",
    args: [
      betId,
      USDC_STAKE,
      challenger.address,
      accepter.address,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ],
  } as never);
  await pub.waitForTransactionReceipt({ hash: tInit });
  check("initializeBet succeeded", true);

  // Each test user approves USDC to the escrow + deposits
  for (const u of [challenger, accepter]) {
    const userWal = createWalletClient({
      account: u,
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    } as never);
    const tApprove = await userWal.writeContract({
      account: u,
      chain: baseSepolia,
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [ESCROW, USDC_STAKE],
    } as never);
    await pub.waitForTransactionReceipt({ hash: tApprove });
    const tDep = await userWal.writeContract({
      account: u,
      chain: baseSepolia,
      address: ESCROW,
      abi: ESCROW_ABI,
      functionName: "deposit",
      args: [betId],
    } as never);
    await pub.waitForTransactionReceipt({ hash: tDep });
  }
  check("both deposits landed", true);

  const winnerBefore = (await pub.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [challenger.address],
  })) as bigint;

  // Resolve to challenger (winner)
  const tResolve = await wal.writeContract({
    account: resolver,
    chain: baseSepolia,
    address: ESCROW,
    abi: ESCROW_ABI,
    functionName: "resolve",
    args: [betId, challenger.address],
  } as never);
  await pub.waitForTransactionReceipt({ hash: tResolve });

  const winnerAfter = (await pub.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [challenger.address],
  })) as bigint;
  const pot = USDC_STAKE * 2n;
  const fee = (USDC_STAKE * 500n) / 10_000n; // 250bps each side
  const expectedPayout = pot - fee;
  check(
    "winner received pot - fee",
    winnerAfter - winnerBefore === expectedPayout,
    `${winnerAfter - winnerBefore} (expected ${expectedPayout})`,
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n${failures === 0 ? "✅ PASS" : `❌ FAIL — ${failures} check(s) failed`} (${elapsed}s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});
