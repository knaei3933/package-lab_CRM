'use client';

import { decideTraverse, forgetAll, hasUnsavedInput, isLeavingClick, LEAVE_CONFIRM_MESSAGE } from '../lib/unsaved-guard';

/**
 * P1 R34 (M9): the page-wide listeners of the unsaved-input guard (installed
 * once, by the first form that mounts). Leaving with typed input asks first:
 * the browser's own dialog on close / reload (beforeunload), the browser's Back / Forward (Navigation API, cancelled
 * before it happens) and
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
  // P4 M9 (review H-1): the browser's 「戻る」/「進む」 through the Navigation API, where it exists. The
  // traversal is cancelled before it happens (nothing is written to the history, so the address and the
  // drawn screen cannot drift apart). No popstate handling: a popstate guard can only act after the address
  // has already changed.
  const navigation = (window as unknown as { navigation?: { addEventListener?: (type: string, listener: (event: Event & { navigationType: string; cancelable: boolean }) => void) => void } }).navigation;
  if (navigation && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('navigate', (event) => {
      const verdict = decideTraverse(
        { navigationType: event.navigationType, cancelable: event.cancelable },
        { hasUnsaved: hasUnsavedInput, confirm: (message) => window.confirm(message), forget: forgetAll }
      );
      if (verdict === 'cancel') event.preventDefault();
    });
  }
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

