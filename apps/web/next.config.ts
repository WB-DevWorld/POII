import type { NextConfig } from 'next';

const noStore = { key: 'Cache-Control', value: 'private, no-store, max-age=0' };

// Release images are built with the 40-hex source commit in GIT_SHA (apps/web/Dockerfile). Naming the deployment
// after it lets Next notice a page that was loaded from the previous release and load the next page fully
// instead of mixing two builds. Local builds have no commit and keep Next's default.
const gitSha = process.env.GIT_SHA;
const deploymentId = gitSha && /^[0-9a-f]{40}$/.test(gitSha) ? gitSha : undefined;

const config: NextConfig = {
  output: 'standalone',
  ...(deploymentId ? { deploymentId } : {}),
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
