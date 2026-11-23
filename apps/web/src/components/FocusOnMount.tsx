'use client';

import { useEffect } from 'react';

/** The minimum of the DOM that focusHeadingIfIdle touches (so it can be tested without a browser). */
export interface FocusDocument {
  activeElement: unknown;
  body: unknown;
  documentElement?: unknown;
  getElementById(id: string): { focus(options?: { preventScroll?: boolean }): void } | null;
}

/**
 * P4 M14: after login the focus sat on `<body>` (a keyboard or screen-reader user
 * started from the top of the page again). The screen's heading takes the focus
 * once, without scrolling — but only when nothing else holds it (a field the
 * operator is in, a button just pressed, an autofocus stay where they are).
 * Returns whether it moved the focus.
 */
export function focusHeadingIfIdle(doc: FocusDocument, id: string): boolean {
  const active = doc.activeElement;
  if (active && active !== doc.body && active !== doc.documentElement) return false;
  const target = doc.getElementById(id);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/** Renders nothing; on mount, hands the focus to the heading `targetId` (it needs tabIndex={-1}). */
export function FocusOnMount({ targetId }: { targetId: string }) {
  useEffect(() => {
    focusHeadingIfIdle(document, targetId);
  }, [targetId]);
  return null;
}
