'use client';

import { useEffect } from 'react';
import { buttonStyle, cardStyle, noteStyle } from '../lib/ui';

/**
 * M8-UI3 FIX 1: this app had no `error.tsx`, so any render error in the
 * operator screens reached Next.js' built-in fallback, which reports only
 * 「Application error: a client-side exception has occurred」and gives the
 * operator nothing to read, retry or report. This boundary keeps the header and
 * the project selector alive (it wraps the page, not the layout), shows the
 * screen's own wording together with the digest the server logs, and resets
 * itself on demand. It does not decide what went wrong — the digest is what the
 * operator passes on.
 */
export default function OperatorScreenError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section style={{ display: 'grid', gap: 16 }}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>画面の表示中に問題が発生しました</h1>
        <p style={noteStyle}>
          この画面の読み込み中にエラーが発生しました。入力中だった内容は記録されていません。下の
          「もう一度表示する」で再試行するか、ブラウザの再読み込みを行ってください。解消しないときは、
          下のエラーIDを添えて代表者へ連絡してください。
        </p>
        {error.digest ? (
          <p style={noteStyle}>
            エラーID（問い合わせ用）:{' '}
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{error.digest}</span>
          </p>
        ) : null}
        <button type="button" onClick={reset} style={buttonStyle}>
          もう一度表示する
        </button>
      </div>
    </section>
  );
}
