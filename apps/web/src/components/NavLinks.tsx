'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';
import { isCurrentPath } from '../lib/navigation';
import type { NavGroup } from '../lib/navigation';
import { DRAWER_TITLE_ID, drawerDialogAttributes, SIDEBAR_ID, useDrawerKeyboard, useNavDrawer } from './NavDrawer';

/** True when `pathname` is the item's screen or one of its sub-paths. */
export const isCurrentNavItem = isCurrentPath;

/**
 * UI nav-dashboard: the left sidebar (it replaces the header menu of UI batch
 * A). Groups follow the order of the work (lib/navigation.ts); the numbered
 * phase is written out, so the order never depends on colour. The current
 * screen is marked by weight, an indigo bar and aria-current="page".
 * Under 1024px the same element is the drawer opened by 「メニュー」.
 */
export function SideNav({ groups, roleNote }: { groups: readonly NavGroup[]; roleNote: string | null }) {
  const pathname = usePathname();
  const { open } = useNavDrawer();
  const container = useRef<HTMLDivElement | null>(null);
  const close = useDrawerKeyboard(container);

  return (
    <>
      {/* The backdrop only exists while the drawer is open on a narrow screen. A pointer
          convenience only: the keyboard closes the drawer with Esc or 「閉じる」. */}
      {open ? <div className="app-sidebar-backdrop" aria-hidden="true" onClick={close} /> : null}
      <div
        id={SIDEBAR_ID}
        ref={container}
        className="app-sidebar"
        data-open={open ? 'true' : 'false'}
        {...drawerDialogAttributes(open)}
        // A menu link always closes the drawer — also one to the screen already
        // open — and focus goes back to 「メニュー」 (review M-3).
        onClick={(event) => {
          if (open && (event.target as HTMLElement).closest('a[href]')) close();
        }}
      >
        <div className="app-sidebar-head">
          <span id={DRAWER_TITLE_ID}>メニュー</span>
          <button type="button" className="app-sidebar-close" onClick={close}>
            閉じる
          </button>
        </div>
        <nav className="app-nav" aria-label="業務メニュー（作業の順番）">
          {groups.map((group) => (
            // Plain group titles (not headings, not region landmarks): the menu sits
            // before the screen's h1 and must not add outline levels or landmarks.
            <div key={group.key} className="app-nav-group">
              <p id={`nav-group-${group.key}`} className="app-nav-group-title">
                {group.step === null ? null : (
                  <span className="app-nav-step">
                    <span className="visually-hidden">手順</span>
                    {group.step}
                  </span>
                )}
                {group.title}
              </p>
              <ul aria-labelledby={`nav-group-${group.key}`}>
                {group.items.map((item) => {
                  const current = isCurrentPath(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link href={item.href} aria-current={current ? 'page' : undefined}>
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        {roleNote ? <p className="app-nav-role">{roleNote}</p> : null}
      </div>
    </>
  );
}
