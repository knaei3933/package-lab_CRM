/**
 * P0 R07 (H15): uploads travel as Base64 inside a server action body, so the
 * body limit must hold the API's 5 MiB file limit after Base64 (×4/3 ≈ 6.7 MiB)
 * plus the other fields. Next's default (1 MB) refused every file over ~750 KB
 * before the API was asked. The file size itself is checked in the browser
 * (lib/form-validation UPLOAD_MAX_BYTES) and, as the rule, by the API.
 */
export const SERVER_ACTIONS_BODY_SIZE_LIMIT = '8mb';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kanei/core'],
  experimental: {
    serverActions: { bodySizeLimit: SERVER_ACTIONS_BODY_SIZE_LIMIT }
  },
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.js', '.ts', '.tsx'] };
    return config;
  }
};

export default nextConfig;
