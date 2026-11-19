'use client';

import '../app/forms.css';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { errorMessageStyle } from '../lib/ui';

/**
 * Criterion 1: the login form posts username/password to POST /api/auth/login.
 * The route handler relays it to the API, which sets the session cookie; on
 * success the operator lands on the order screen, on failure the API's
 * Japanese message is shown as-is.
 *
 * Astryx trial: the fields are Astryx TextInput (controlled, as this form
 * always was) and the submit is an Astryx Button. The refusal line stays our
 * own always-present role="alert" span, linked from both fields.
 */
export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Which fields the refusal is about: an empty-field check marks only the
  // empty ones; a refusal from the API is about the pair, so both.
  const [invalid, setInvalid] = useState<{ username: boolean; password: boolean }>({ username: false, password: false });
  const [pending, setPending] = useState(false);
  // UI batch C: the refusal is announced (role="alert") and the fields it is about point at it.
  const errorId = useId();
  // exactOptionalPropertyTypes: Astryx props do not accept an explicit undefined, so spread.
  const fieldError = (isInvalid: boolean) =>
    error && isInvalid ? { status: { type: 'error' as const }, 'aria-describedby': errorId } : {};

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // The button stays focusable while pending (aria-disabled), so a second submit is dropped here.
    if (pending) return;
    // Astryx TextInput marks a required field with aria-required only (no native
    // `required`), so the empty check the browser used to do happens here. The
    // API still refuses an empty pair on its own (400).
    const emptyUsername = username.trim() === '';
    const emptyPassword = password === '';
    if (emptyUsername || emptyPassword) {
      setError(
        emptyUsername && emptyPassword
          ? 'ユーザー名とパスワードを入力してください。'
          : emptyUsername ? 'ユーザー名を入力してください。' : 'パスワードを入力してください。'
      );
      setInvalid({ username: emptyUsername, password: emptyPassword });
      // As the native `required` did: focus the first empty field.
      const firstEmpty = emptyUsername ? 'username' : 'password';
      event.currentTarget.querySelector<HTMLInputElement>(`input[name="${firstEmpty}"]`)?.focus();
      return;
    }
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
        // Stays pending while the next screen loads, so the button cannot post again.
        router.replace('/orders');
        router.refresh();
        return;
      }
      setError(payload?.error ?? 'ログインに失敗しました。入力内容を確認してください。');
      setInvalid({ username: true, password: true });
      setPending(false);
    } catch {
      setError('ログイン要求を送信できませんでした。通信を確認してください。');
      setInvalid({ username: false, password: false });
      setPending(false);
    }
  }

  return (
    // method="post": a submit before hydration must never put the password into the URL.
    <form onSubmit={onSubmit} method="post" className="login-form" noValidate style={{ maxWidth: 360 }}>
      <VStack gap={3}>
        <TextInput
          label="ユーザー名"
          htmlName="username"
          value={username}
          autoComplete="username"
          autoCapitalize="none"
          hasAutoCorrect={false}
          hasSpellCheck={false}
          isRequired
          onChange={(value) => setUsername(value)}
          {...fieldError(invalid.username)}
        />
        <TextInput
          label="パスワード"
          type="password"
          htmlName="password"
          value={password}
          autoComplete="current-password"
          isRequired
          onChange={(value) => setPassword(value)}
          {...fieldError(invalid.password)}
        />
        <HStack gap={3} wrap="wrap" align="center">
          {/* isLoading shows the wait; aria-disabled (honoured by Astryx Button) keeps it focusable, as before. */}
          <Button type="submit" variant="primary" label={pending ? '確認中…' : 'ログイン'} isLoading={pending} aria-disabled={pending || undefined} />
          <span id={errorId} role="alert" className="form-live" style={errorMessageStyle}>
            {error ?? ''}
          </span>
        </HStack>
      </VStack>
    </form>
  );
}
