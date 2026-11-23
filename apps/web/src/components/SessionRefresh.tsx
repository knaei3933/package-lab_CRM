'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * P4 H8: a notice drawn by a page (after a client-side move) leaves the header
 * of the layout that was already on screen — still showing the operator and
 * 「ログアウト」. Asking the server to draw the route again lets the root layout
 * see the lost session and redraw the header (and then the notice itself).
 * Once: the redrawn tree has no page, so there is no loop.
 */
export function SessionRefresh() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}
