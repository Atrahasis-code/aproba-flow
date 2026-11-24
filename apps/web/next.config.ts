import type { NextConfig } from 'next';

const apiInternalUrl = process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@aproba-flow/shared'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiInternalUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
