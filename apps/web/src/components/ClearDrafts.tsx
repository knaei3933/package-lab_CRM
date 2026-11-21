'use client';

import { useEffect } from 'react';
import { draftKeyPrefix } from '../lib/unsaved-guard';

/**
 * P1 R34: a form that succeeds by moving to another screen (the new-order
 * wizard opens the order) never sees its own reset, so its draft is dropped
 * here, on the screen it moved to. Blocked storage is ignored.
 */
export function ClearDrafts({ pathname }: { pathname: string }) {
  useEffect(() => {
    try {
      const prefix = draftKeyPrefix(pathname);
      for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = window.sessionStorage.key(index);
        if (key && key.startsWith(prefix)) window.sessionStorage.removeItem(key);
      }
    } catch {
      // No storage: nothing to clear.
    }
  }, [pathname]);
  return null;
}
