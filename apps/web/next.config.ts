import type { NextConfig } from 'next';

const noStore = { key: 'Cache-Control', value: 'private, no-store, max-age=0' };

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/sources/:path*', headers: [noStore] },
      { source: '/records/:path*', headers: [noStore] },
      { source: '/search', headers: [noStore] },
      { source: '/decisions', headers: [noStore] },
      { source: '/export', headers: [noStore] },
      { source: '/backup', headers: [noStore] },
    ];
  },
};

export default config;
