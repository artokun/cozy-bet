import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";

const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://sepolia.base.org";

export const wagmiConfig = createConfig({
  chains: [baseSepolia, base],
  connectors: [
    coinbaseWallet({
      appName: "cozy-bet",
      preference: { options: "smartWalletOnly" },
    }),
    injected(),
  ],
  transports: {
    [baseSepolia.id]: http(RPC_URL),
    [base.id]: http(),
  },
});
