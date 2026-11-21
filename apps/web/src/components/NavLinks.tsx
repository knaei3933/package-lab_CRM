'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';
import { isCurrentPath } from '../lib/navigation';
import { parseProjectPath, scopeHref, unscopedPath } from '../lib/project-route';
import { MENU_TERMS } from '../lib/terms';
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
export function SideNav({ groups, roleNote, korean = false, role = 'viewer' }: { groups: readonly NavGroup[]; roleNote: string | null; korean?: boolean; role?: string }) {
  const pathname = usePathname();
  // P1 R20: inside /p/{code}/… the menu's screens stay in that project.
  const projectCode = parseProjectPath(pathname)?.projectCode ?? null;
  const currentScreen = unscopedPath(pathname);
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
                  const current = isCurrentPath(currentScreen, item.href);
                  return (
                    <li key={item.href}>
                      <Link href={scopeHref(projectCode, item.href)} aria-current={current ? 'page' : undefined}>
                        {item.label}
                        {/* P1 R29: the menu's Korean gloss (same table as the screens, lib/terms). */}
                        {korean ? <span className="p1-ko" lang="ko">{(MENU_TERMS[item.href === '/home' ? `/home:${role}` : item.href] ?? null)?.ko}</span> : null}
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
