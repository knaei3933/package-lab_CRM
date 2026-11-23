import { FocusOnMount } from './FocusOnMount';
import { loginHrefFor } from '../lib/return-path';
import { webErrorText } from '../lib/error-dictionary';
import { formatTimestamp } from '../lib/vocabulary';

/**
 * P0 R04/R08 (B4, H8, H9): the screen body when there is no usable session.
 * Drawn by the root layout in place of the screen, so a screen never renders
 * a false 「まだありません」 for a lost session, an outage never looks like a
 * logout, and no internal address is shown. Plain markup (server component,
 * no Astryx bundle) — styles in app/p0-notices.css.
 */
export type SessionNoticeKind = 'login' | 'expired' | 'outage';

export function SessionNotice({ kind, path, code, now = new Date() }: { kind: SessionNoticeKind; path: string; code?: string | null; now?: Date }) {
  if (kind === 'outage') return <OutageNotice path={path} code={code ?? 'API_UNREACHABLE'} now={now} />;
  const expired = kind === 'expired';
  return (
    <section className="session-notice" aria-labelledby="session-notice-title">
      {/* P4 L-5: the notice takes the focus (the focus was left on <body>). */}
      <FocusOnMount targetId="session-notice-title" />
      <h1 id="session-notice-title" className="session-notice-title" tabIndex={-1}>
        {expired ? 'ログインの有効期限が切れました' : 'ログインしてください'}
      </h1>
      <p className="session-notice-body">
        {expired
          ? 'この画面を続けるには、もう一度ログインしてください。ログインすると、この画面に戻ります。'
          : 'この画面を使うにはログインが必要です。ログインすると、この画面に戻ります。'}
      </p>
      <p className="session-notice-ko" lang="ko">
        {expired ? '로그인이 만료되었습니다. 다시 로그인하면 이 화면으로 돌아옵니다.' : '로그인이 필요합니다. 로그인하면 이 화면으로 돌아옵니다.'}
      </p>
      <p className="session-notice-actions">
        <a className="session-notice-primary" href={loginHrefFor(path)}>
          ログインする
        </a>
      </p>
    </section>
  );
}

function OutageNotice({ path, code, now }: { path: string; code: string; now: Date }) {
  const database = code === 'DB_UNAVAILABLE';
  const text = webErrorText(code);
  return (
    <section className="session-notice session-notice--outage" aria-labelledby="session-notice-title">
      <FocusOnMount targetId="session-notice-title" />
      <h1 id="session-notice-title" className="session-notice-title" tabIndex={-1}>
        {database ? 'システムに接続できません（データベース）' : 'システムに接続できません'}
      </h1>
      <p className="session-notice-body">
        {database ? 'データベースが応答していません。' : 'サーバーが応答していません。'}
        ログアウトしたわけではありません。数分後にもう一度読み込んでください。
      </p>
      {text.messageKo ? (
        <p className="session-notice-ko" lang="ko">
          {text.messageKo}
        </p>
      ) : null}
      <p className="session-notice-actions">
        {/* A plain link to this same path: works before (and without) JavaScript. */}
        <a className="session-notice-primary" href={path}>
          もう一度読み込む
        </a>
      </p>
      <p className="session-notice-note">急ぎの場合は代表者へ連絡してください。</p>
      <dl className="session-notice-facts">
        <div>
          <dt>発生時刻</dt>
          <dd>{formatTimestamp(now.toISOString())}</dd>
        </div>
        <div>
          <dt>参照コード</dt>
          <dd translate="no">{text.code}</dd>
        </div>
      </dl>
    </section>
  );
}
