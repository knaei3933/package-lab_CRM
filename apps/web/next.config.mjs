/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kanei/core'],
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.js', '.ts', '.tsx'] };
    return config;
  }
};

export default nextConfig;
