import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoutButton } from '../components/LogoutButton';
import { NavLinks } from '../components/NavLinks';
import { ProjectPicker } from '../components/ProjectPicker';
import { cookies } from 'next/headers';
import { loadSessionUser, readSelectedProjectId } from '../lib/api';
import { decodeDisplayNameCookie, DISPLAY_NAME_COOKIE, operatorName, roleLabel } from '../lib/session-display';
import { loadSelectableProjects } from '../lib/project-data';
import type { ProjectSummary } from '../lib/project-data';
import { selectProjectAction } from './actions';
import './globals.css';

// UI batch A: each screen sets its own title (tabs stay distinguishable); the
// template adds the product name.
export const metadata: Metadata = {
  title: { default: 'KANEI CRM オペレーター画面', template: '%s｜KANEI CRM' },
  description: 'F1フィルム商材の発注から納品確認までをブラウザで行う最小オペレーターUI'
};

const navItems = [
  { href: '/orders', label: '案件（発注）一覧／作成' },
  { href: '/documents', label: '文書' },
  { href: '/approvals', label: '承認' },
  { href: '/maker-po', label: 'メーカー発注' },
  { href: '/deliveries', label: '納品確認・手数料準備' },
  { href: '/status', label: '状態表示' }
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await loadSessionUser();
  const rememberedName = user
    ? decodeDisplayNameCookie((await cookies()).get(DISPLAY_NAME_COOKIE)?.value, user.id)
    : null;
  const projectId = await readSelectedProjectId();
  // M8-UI3: the selector lists the projects this operator may open, so the id
  // no longer has to be pasted by hand. The API narrows the list by role.
  const selectableProjects: ProjectSummary[] = user ? await loadSelectableProjects() : [];
  const projectChoices = selectableProjects.map((project) => ({
    value: project.id,
    label: `${project.code}（${project.name}）`
  }));

  // HANDOFF §5-4 (hydration #418): every screen's markup is deterministic —
  // timestamps and choice lists are computed only in server components and
  // reach client forms as props, so the app itself has no server/client
  // divergence (verified in source and by headless-browser smoke on all
  // pages). The one warning source left is browser extensions mutating the
  // html/body attributes (e.g. injecting helper classes) before hydration;
  // React then reports a mismatch that the app cannot avoid.
  // suppressHydrationWarning covers ONLY these two elements (one level deep),
  // so genuine mismatches inside the page tree still surface.
  return (
    <html lang="ja" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <a className="skip-link" href="#main">本文へ移動</a>
        <header style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface)' }}>
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
              <Link href="/" style={{ fontSize: 18, color: 'var(--ink)', textDecoration: 'none', fontWeight: 700 }}>
                KANEI CRM オペレーター画面（F1）
              </Link>
              {user ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
                  <span>
                    {operatorName(user, rememberedName)}
                    <span style={{ color: 'var(--ink-sub)' }}>（{roleLabel(user.role)}）</span>
                  </span>
                  <LogoutButton />
                </div>
              ) : null}
            </div>
            {user ? (
              <>
                <NavLinks items={navItems} />
                {/* UI batch B (②): one compact line; the id input is under 「詳細」. */}
                <ProjectPicker action={selectProjectAction} choices={projectChoices} currentProjectId={projectId} />
              </>
            ) : null}
          </div>
        </header>
        <main id="main" tabIndex={-1} style={{ maxWidth: 1100, margin: '32px auto', padding: '0 24px 64px', display: 'grid', gap: 24 }}>
          {children}
        </main>
      </body>
    </html>
  );
}
