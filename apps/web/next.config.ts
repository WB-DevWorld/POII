import type { NextConfig } from 'next';

const noStore = { key: 'Cache-Control', value: 'private, no-store, max-age=0' };

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Sources up to the API's 20 MB content limit and backups with inlined originals go through server actions.
  experimental: { serverActions: { bodySizeLimit: '64mb' } },
  async headers() {
    return [
      { source: '/sources/:path*', headers: [noStore] },
      { source: '/records/:path*', headers: [noStore] },
      { source: '/search', headers: [noStore] },
      { source: '/decisions', headers: [noStore] },
      { source: '/export', headers: [noStore] },
      { source: '/export/:path*', headers: [noStore] },
      { source: '/backup', headers: [noStore] },
      { source: '/backup/:path*', headers: [noStore] },
      { source: '/', headers: [noStore] },
    ];
  },
};

export default config;
