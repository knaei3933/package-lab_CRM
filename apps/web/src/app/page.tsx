import { redirect } from 'next/navigation';
import { LoginForm } from '../components/LoginForm.js';
import { apiBaseUrl, loadSessionUser } from '../lib/api.js';
import { cardStyle, noteStyle } from '../lib/ui.js';

export const dynamic = 'force-dynamic';

/**
 * Criterion 1: the login screen. A logged-in operator is sent straight to the
 * order screen; everyone else sees the username/password form that posts to
 * POST /api/auth/login (relayed to the API, which issues the session cookie).
 */
export default async function LoginPage() {
  const user = await loadSessionUser();
  if (user) redirect('/orders');

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 28, margin: '0 0 8px' }}>ログイン</h1>
        <p style={noteStyle}>
          KANEI CRM（F1専用）のオペレーター画面です。API（{apiBaseUrl}）のセッションで認証します。
        </p>
      </div>
      <div style={cardStyle}>
        <LoginForm />
      </div>
      <p style={noteStyle}>
        シード済みのユーザーでログインしてください（シードの登録内容は packages/db/src/seed.ts を参照）。
        代表者権限（admin）でログインすると、承認・納品確認・手数料準備の操作が行えます。
      </p>
    </section>
  );
}
