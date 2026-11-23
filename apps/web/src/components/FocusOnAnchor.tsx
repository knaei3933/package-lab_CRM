'use client';

import { useEffect } from 'react';

/** The minimum of an element / the document that landOnAnchor touches (so it can be tested without a browser). */
export interface AnchorElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): AnchorElement | null;
  closest?(selector: string): { open: boolean } | null;
  hasAttribute?(name: string): boolean;
  focus(options?: { preventScroll?: boolean }): void;
}
export interface AnchorDocument {
  activeElement: unknown;
  body: unknown;
  documentElement?: unknown;
  getElementById(id: string): AnchorElement | null;
  querySelectorAll(selector: string): Iterable<AnchorElement>;
}

export const LANDED_ATTRIBUTE = 'data-landed';
const FIELD = 'select, input:not([type="hidden"]), textarea, button';

/**
 * p6 review L-2: a link that opens `#id` through the router (承認箱の「支払条件を決める」) scrolls to the element, but the
 * browser does not set `:target` for it and the focus stays on <body> — a keyboard or screen-reader user was not told where
 * they landed. When the address names this element, it is marked (data-landed — the same outline as :target) and the focus goes
 * to its first field, without scrolling, and only when nothing else holds the focus (the same rule as focusHeadingIfIdle).
 * An address that names another element clears the mark. Returns whether the focus moved.
 */
export function landOnAnchor(doc: AnchorDocument, id: string, hash: string): boolean {
  for (const marked of doc.querySelectorAll(`[${LANDED_ATTRIBUTE}]`)) marked.removeAttribute(LANDED_ATTRIBUTE);
  if (hash !== `#${id}`) return false;
  const target = doc.getElementById(id);
  if (!target) return false;
  target.setAttribute(LANDED_ATTRIBUTE, 'true');
  const closed = target.querySelector('details:not([open])') as unknown as { setAttribute(n: string, v: string): void } | null;
  // a collapsed 「支払条件を変更する」 opens so the field the operator came for is there
  if (closed) closed.setAttribute('open', '');
  const active = doc.activeElement;
  if (active && active !== doc.body && active !== doc.documentElement) return false;
  const field = target.querySelector(FIELD);
  const focusTarget = field ?? target;
  if (!field) target.setAttribute('tabindex', '-1');
  focusTarget.focus({ preventScroll: true });
  return true;
}

/** Renders nothing; lands on the element `anchorId` when the address names it (on mount, and when the address changes). */
export function FocusOnAnchor({ anchorId }: { anchorId: string }) {
  useEffect(() => {
    const land = () => { landOnAnchor(document as unknown as AnchorDocument, anchorId, window.location.hash); };
    land();
    window.addEventListener('hashchange', land);
    return () => window.removeEventListener('hashchange', land);
  }, [anchorId]);
  return null;
}
