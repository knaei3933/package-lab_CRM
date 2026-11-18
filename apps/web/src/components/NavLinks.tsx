'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
}

/** True when `pathname` is the item's screen or one of its sub-paths. */
export function isCurrentNavItem(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * UI batch A: the header menu with the current screen marked. The mark is
 * weight + an underline bar (globals.css .app-nav) plus aria-current="page",
 * so it never depends on colour alone.
 */
export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="app-nav" aria-label="業務メニュー">
      {items.map((item) => {
        const current = isCurrentNavItem(pathname, item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={current ? 'page' : undefined}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
