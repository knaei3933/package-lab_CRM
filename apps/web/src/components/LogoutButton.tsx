'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { subtleButtonStyle } from '../lib/ui.js';

/** Criterion 1: logout calls POST /api/auth/logout and returns to the login page. */
export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick(): Promise<void> {
    setPending(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // The cookie is dropped client-side by the relay even on failure; the
      // next navigation simply shows the login screen again.
    } finally {
      setPending(false);
      router.replace('/');
      router.refresh();
    }
  }

  return (
    <button type="button" onClick={onClick} disabled={pending} style={subtleButtonStyle}>
      {pending ? 'ログアウト中…' : 'ログアウト'}
    </button>
  );
}
