'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { buttonStyle, errorMessageStyle, inputStyle } from '../lib/ui';

/**
 * Criterion 1: the login form posts username/password to POST /api/auth/login.
 * The route handler relays it to the API, which sets the session cookie; on
 * success the operator lands on the order screen, on failure the API's
 * Japanese message is shown as-is.
 */
export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include'
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.ok) {
        router.replace('/orders');
        router.refresh();
        return;
      }
      setError(payload?.error ?? 'ログインに失敗しました。入力内容を確認してください。');
    } catch {
      setError('ログイン要求を送信できませんでした。通信を確認してください。');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, maxWidth: 360 }}>
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 13 }}>ユーザー名</span>
        <input
          name="username"
          value={username}
          autoComplete="username"
          required
          onChange={(event) => setUsername(event.target.value)}
          style={inputStyle}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 13 }}>パスワード</span>
        <input
          name="password"
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(event) => setPassword(event.target.value)}
          style={inputStyle}
        />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="submit" disabled={pending} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? '確認中…' : 'ログイン'}
        </button>
        {error ? <span style={errorMessageStyle}>{error}</span> : null}
      </div>
    </form>
  );
}
