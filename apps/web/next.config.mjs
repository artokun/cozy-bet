/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cozy-bet/shared"],
  experimental: {
    // allow importing .json with assertions from the shared package
  },
  webpack: (config) => {
    config.externals = [...(config.externals || []), "pino-pretty", "lokijs", "encoding"];
    // wagmi 3.4.x dynamically `import('accounts')` from its Tempo wallet
    // connector (we don't use it). Stub it so the bundler doesn't choke.
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      net: false,
      tls: false,
      accounts: false,
    };
    return config;
  },
};
export default nextConfig;
