'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { usePathname } from 'next/navigation';

/**
 * UI nav-dashboard: the phone/tablet drawer state shared by the top bar's
 * 「メニュー」 button and the sidebar. On a wide screen the sidebar is always
 * shown and this state is ignored by the stylesheet (globals.css .app-sidebar).
 *
 * Keyboard: the button carries aria-expanded / aria-controls; opening moves
 * focus to the first menu link, Tab stays inside the open drawer, Esc or the
 * drawer's 「閉じる」 closes it and returns focus to the button, and following
 * any menu link (also to the screen already open) closes it.
 */
export const SIDEBAR_ID = 'app-sidebar';

interface DrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
}

const DrawerContext = createContext<DrawerState | null>(null);

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const pathname = usePathname();

  // A link inside the drawer moves to another screen: the drawer closes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const value = useMemo(() => ({ open, setOpen, toggleRef }), [open]);
  return <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>;
}

export function useNavDrawer(): DrawerState {
  const state = useContext(DrawerContext);
  if (!state) {
    // Rendered without the provider (tests of one part): a closed drawer.
    return { open: false, setOpen: () => undefined, toggleRef: { current: null } };
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
 * Esc closes the open drawer and gives focus back to the toggle; opening it
 * focuses the first link. Used by the sidebar itself.
 */
export function useDrawerKeyboard(container: RefObject<HTMLElement | null>): () => void {
  const { open, setOpen, toggleRef } = useNavDrawer();
  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, [setOpen, toggleRef]);

  useEffect(() => {
    if (!open) return undefined;
    // The drawer only exists while its toggle is shown (narrow screens). A
    // window widened with the drawer open just closes it, so nothing on the
    // wide layout (Esc, Tab) is intercepted.
    const toggleShown = () => Boolean(toggleRef.current && toggleRef.current.offsetParent !== null);
    if (!toggleShown()) {
      setOpen(false);
      return undefined;
    }
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
      // Review M: Tab stays inside the open drawer (the page under the backdrop is out of reach).
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
    };
  }, [open, close, container, setOpen, toggleRef]);

  return close;
}
