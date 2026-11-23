'use client';

import { forgetAll, handlePopstate, hasUnsavedInput, heldAddress, isLeavingClick, LEAVE_CONFIRM_MESSAGE } from '../lib/unsaved-guard';

/**
 * P1 R34 (M9): the page-wide listeners of the unsaved-input guard (installed
 * once, by the first form that mounts). Leaving with typed input asks first:
 * the browser's own dialog on close / reload (beforeunload), and
 * 「入力中の内容があります。移動すると消えます。」 before an in-app link moves.
 */
let installed = false;

export function installUnsavedGuard(): void {
  if (installed || typeof window === 'undefined' || typeof window.addEventListener !== 'function' || typeof document === 'undefined') return;
  installed = true;
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedInput()) return;
    event.preventDefault();
    // Older browsers read returnValue.
    event.returnValue = '';
  });
  // P4 M9: the browser's 「戻る」 — asked before the screen is left, too. Capture phase on window, so
  // a refusal stops the router's own popstate handler from drawing the previous screen.
  window.addEventListener('popstate', (event) => {
    const verdict = handlePopstate({
      hasUnsaved: hasUnsavedInput,
      confirm: (message) => window.confirm(message),
      restore: (href) => window.history.pushState(window.history.state, '', href),
      forget: forgetAll,
      held: heldAddress()
    });
    if (verdict === 'blocked') event.stopImmediatePropagation();
  }, true);
  document.addEventListener('click', (event) => {
    if (!hasUnsavedInput()) return;
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    const leaving = isLeavingClick(event, {
      href: target.getAttribute('href') ?? '',
      target: target.target,
      hasDownload: target.hasAttribute('download'),
      hash: target.hash,
      pathname: target.pathname,
      search: target.search
    }, { pathname: window.location.pathname, search: window.location.search });
    if (!leaving) return;
    if (!window.confirm(LEAVE_CONFIRM_MESSAGE)) {
      event.preventDefault();
      event.stopPropagation();
    } else {
      forgetAll();
    }
  }, true);
}

