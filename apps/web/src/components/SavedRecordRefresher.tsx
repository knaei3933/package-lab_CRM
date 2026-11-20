'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { CHANGED_ROW_CLASS, recordSelector, SAVED_RECORD_EVENT } from '../lib/saved-record';
import type { SavedRecordDetail } from '../lib/saved-record';

/**
 * P0 R06 (H1): after every successful write the screen is refreshed
 * (router.refresh — the server action's own revalidation is the first path,
 * this one guarantees it for every form), then the changed row is scrolled
 * into view and highlighted until the operator moves on. Mounted once, by the
 * root layout.
 */
const HIGHLIGHT_MS = 6000;
const FIND_TIMEOUT_MS = 4000;

export function SavedRecordRefresher() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    function highlight(id: string, startedAt: number): void {
      if (cancelled) return;
      const selector = recordSelector(id);
      const target = selector ? document.querySelector<HTMLElement>(selector) : null;
      if (!target) {
        if (Date.now() - startedAt < FIND_TIMEOUT_MS) timers.push(window.setTimeout(() => highlight(id, startedAt), 150));
        return;
      }
      target.classList.add(CHANGED_ROW_CLASS);
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
      timers.push(window.setTimeout(() => target.classList.remove(CHANGED_ROW_CLASS), HIGHLIGHT_MS));
    }
    function onSaved(event: Event): void {
      const detail = (event as CustomEvent<SavedRecordDetail>).detail;
      router.refresh();
      if (detail?.changedId) highlight(detail.changedId, Date.now());
    }
    window.addEventListener(SAVED_RECORD_EVENT, onSaved);
    return () => {
      cancelled = true;
      window.removeEventListener(SAVED_RECORD_EVENT, onSaved);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [router]);
  return null;
}
