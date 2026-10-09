import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
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

const navigation = [
  { href: '/sources', label: 'Sources' },
  { href: '/records', label: 'Records' },
  { href: '/decisions', label: 'Current decisions' },
  { href: '/search', label: 'Search' },
  { href: '/export', label: 'Export' },
  { href: '/backup', label: 'Backup' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a className="brand" href="/">POII</a>
          <nav aria-label="Primary">
            {navigation.map(item => (
              <a key={item.href} href={item.href}>{item.label}</a>
            ))}
          </nav>
          <span className="status-pill" title="AI assistance is off until a provider is configured">AI off</span>
        </header>
        <main className="page">{children}</main>
        <footer className="site-footer">
          <span>Version {process.env.GIT_SHA?.slice(0, 12) ?? 'dev'}</span>
          <span>Own the knowledge, rent the intelligence.</span>
        </footer>
      </body>
    </html>
  );
}
