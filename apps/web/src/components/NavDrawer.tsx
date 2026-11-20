'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode, RefObject } from 'react';
import { usePathname } from 'next/navigation';

/**
 * UI nav-dashboard: the phone/tablet drawer state shared by the top bar's
 * 「メニュー」 button and the sidebar. On a wide screen the sidebar is always
 * shown and this state is ignored by the stylesheet (globals.css .app-sidebar).
 *
 * While open the drawer is a modal dialog (review M-2): role="dialog",
 * aria-modal and a name on the panel (drawerDialogAttributes), the header and
 * <main> behind it are `inert` (no virtual-cursor or swipe access), and the
 * page does not scroll under it. Keyboard: the button carries aria-expanded /
 * aria-controls; opening moves focus to the first menu link, Tab stays inside
 * the drawer, and every close — Esc, 「閉じる」, the backdrop or a menu link,
 * also one to the screen already open (review M-3) — returns focus to the
 * button once the page behind is interactive again.
 */
export const SIDEBAR_ID = 'app-sidebar';
export const DRAWER_TITLE_ID = 'app-sidebar-title';

/** Elements behind the open drawer that are made inert. */
const BACKGROUND_SELECTORS = ['.app-header', '#main'] as const;

/** The panel's dialog attributes: only while open (on a wide screen it is a plain sidebar). */
export function drawerDialogAttributes(open: boolean): Record<string, string> {
  return open ? { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': DRAWER_TITLE_ID } : {};
}

interface DrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  /** Set by a close that must give focus back to the toggle. */
  restoreFocusRef: MutableRefObject<boolean>;
}

const DrawerContext = createContext<DrawerState | null>(null);

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const pathname = usePathname();

  // Moving to another screen (also with the browser's back button) closes the drawer.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const value = useMemo(() => ({ open, setOpen, toggleRef, restoreFocusRef }), [open]);
  return <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>;
}

export function useNavDrawer(): DrawerState {
  const state = useContext(DrawerContext);
  if (!state) {
    // Rendered without the provider (tests of one part): a closed drawer.
    return { open: false, setOpen: () => undefined, toggleRef: { current: null }, restoreFocusRef: { current: false } };
  }
  return state;
}

/** The top bar's 「メニュー」 button (shown under 1024px only, globals.css). */
export function NavDrawerToggle() {
  const { open, setOpen, toggleRef } = useNavDrawer();
  return (
    <button
      ref={toggleRef}
      type="button"
      className="app-menu-toggle"
      aria-expanded={open}
      aria-controls={SIDEBAR_ID}
      onClick={() => setOpen(!open)}
    >
      <span className="app-menu-toggle-bars" aria-hidden="true" />
      メニュー
    </button>
  );
}

/**
 * The open drawer's behaviour (used by the sidebar itself). Returns `close`,
 * which closes and gives focus back to the toggle.
 */
export function useDrawerKeyboard(container: RefObject<HTMLElement | null>): () => void {
  const { open, setOpen, toggleRef, restoreFocusRef } = useNavDrawer();
  const close = useCallback(() => {
    restoreFocusRef.current = true;
    setOpen(false);
  }, [setOpen, restoreFocusRef]);

  useEffect(() => {
    if (!open) return undefined;
    // The drawer only exists while its toggle is shown (narrow screens). A
    // window widened with the drawer open just closes it, so nothing on the
    // wide layout (Esc, Tab, inert) is intercepted.
    const toggleShown = () => Boolean(toggleRef.current && toggleRef.current.offsetParent !== null);
    if (!toggleShown()) {
      setOpen(false);
      return undefined;
    }
    const background = BACKGROUND_SELECTORS
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => element !== null);
    for (const element of background) element.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    container.current?.querySelector<HTMLElement>('a[href]')?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (!toggleShown()) {
        setOpen(false);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      // Tab stays inside the open drawer (the page behind it is inert).
      if (event.key === 'Tab' && container.current) {
        const focusable = [...container.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !container.current.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !container.current.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    function onResize(): void {
      if (!toggleShown()) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      for (const element of background) element.inert = false;
      document.body.style.overflow = previousOverflow;
      // The toggle sits in the header, which is interactive again only now.
      if (restoreFocusRef.current) {
        restoreFocusRef.current = false;
        toggleRef.current?.focus();
      }
    };
  }, [open, close, container, setOpen, toggleRef, restoreFocusRef]);

  return close;
}
