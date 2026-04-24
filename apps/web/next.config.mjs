/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cozy-bet/shared"],
  experimental: {
    // allow importing .json with assertions from the shared package
  },
  webpack: (config) => {
    config.externals = [...(config.externals || []), "pino-pretty", "lokijs", "encoding"];
    config.resolve.fallback = { ...(config.resolve.fallback || {}), fs: false, net: false, tls: false };
    return config;
  },
};
export default nextConfig;
