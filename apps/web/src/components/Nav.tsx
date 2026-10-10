'use client';

import { usePathname } from 'next/navigation';

const navigation = [
  { href: '/sources', label: 'Sources' },
  { href: '/records', label: 'Records' },
  { href: '/decisions', label: 'Current decisions' },
  { href: '/search', label: 'Search' },
  { href: '/export', label: 'Export' },
  { href: '/backup', label: 'Backup' },
];

export function Nav() {
  const pathname = usePathname() ?? '/';
  return (
    <nav aria-label="Primary">
      {navigation.map(item => {
        const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <a key={item.href} href={item.href} aria-current={current ? 'page' : undefined}>
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
