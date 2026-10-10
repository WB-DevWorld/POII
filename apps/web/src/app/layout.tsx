import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import type { HealthReady } from '@poii/contracts';
import { Nav } from '@/components/Nav';
import { apiTry } from '@/lib/api';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'POII', template: '%s · POII' },
  description: 'Owner-controlled record of evidence, decisions, authority, change history and current state.',
  manifest: '/manifest.webmanifest',
  applicationName: 'POII',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5f1' },
    { media: '(prefers-color-scheme: dark)', color: '#17181b' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const ready = await apiTry<HealthReady>('/health/ready');
  const aiOn = ready.ok && ready.data.aiEnabled === true;
  const pillTitle = !ready.ok
    ? 'API not reachable; AI state unknown, treated as off'
    : aiOn
      ? 'AI-assisted extraction is configured. AI output stays a candidate until a person confirms it.'
      : 'AI assistance is off until a provider is configured';
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="site-header">
          <a className="brand" href="/">POII</a>
          <Nav />
          <span className={`status-pill${aiOn ? ' on' : ''}`} title={pillTitle} data-testid="ai-pill">
            {aiOn ? 'AI on' : 'AI off'}
          </span>
        </header>
        <main className="page" id="main">{children}</main>
        <footer className="site-footer">
          <span>Version {process.env.GIT_SHA?.slice(0, 12) ?? 'dev'}</span>
          <span>Own the knowledge, rent the intelligence.</span>
        </footer>
      </body>
    </html>
  );
}
