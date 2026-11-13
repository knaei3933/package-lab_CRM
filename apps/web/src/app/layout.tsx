import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ActionForm } from '../components/ActionForm';
import { LogoutButton } from '../components/LogoutButton';
import { TextField } from '../components/fields';
import { loadSessionUser, readSelectedProjectId } from '../lib/api';
import { monoStyle, navStyle } from '../lib/ui';
import { selectProjectAction } from './actions';

export const metadata: Metadata = {
  title: 'KANEI CRM オペレーター画面',
  description: 'F1フィルム商材の発注から納品確認までをブラウザで行う最小オペレーターUI'
};

const navItems = [
  { href: '/orders', label: '案件（発注）一覧／作成' },
  { href: '/documents', label: '文書' },
  { href: '/approvals', label: '承認' },
  { href: '/deliveries', label: '納品確認・手数料準備' },
  { href: '/status', label: '状態表示' }
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await loadSessionUser();
  const projectId = await readSelectedProjectId();

  return (
    <html lang="ja">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, color: '#172033', background: '#f7f9fc' }}>
        <header style={{ borderBottom: '1px solid #d8dfeb', background: '#ffffff' }}>
          <div style={{ maxWidth: 1100, margin: '0 auto', padding: '12px 24px', display: 'grid', gap: 10 }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12
              }}
            >
              <Link href="/" style={{ fontSize: 18, color: '#172033', textDecoration: 'none', fontWeight: 600 }}>
                KANEI CRM オペレーター画面（F1）
              </Link>
              {user ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
                  <span>
                    {user.displayName ?? user.id}
                    <span style={{ color: '#526173' }}>
                      （{user.role === 'admin' ? '代表者' : user.role === 'staff' ? '担当者' : '閲覧者'}）
                    </span>
                  </span>
                  <LogoutButton />
                </div>
              ) : null}
            </div>
            {user ? (
              <>
                <nav style={navStyle}>
                  {navItems.map((item) => (
                    <Link key={item.href} href={item.href} style={{ color: '#1d4ed8', fontSize: 14 }}>
                      {item.label}
                    </Link>
                  ))}
                </nav>
                <ActionForm
                  action={selectProjectAction}
                  submitLabel="案件を切り替える"
                  hint="案件ID（UUID）を指定すると、その案件の発注・文書・承認・納品を表示します。"
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
                    <TextField name="projectId" label="案件の選択（案件ID）" required defaultValue={projectId ?? ''} width={420} />
                    {projectId ? <span style={monoStyle}>現在の案件ID: {projectId}</span> : null}
                  </div>
                </ActionForm>
              </>
            ) : null}
          </div>
        </header>
        <main style={{ maxWidth: 1100, margin: '32px auto', padding: '0 24px 64px', display: 'grid', gap: 24 }}>
          {children}
        </main>
      </body>
    </html>
  );
}
