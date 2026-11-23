import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoutButton } from '../components/LogoutButton';
import { NavDrawerProvider, NavDrawerToggle } from '../components/NavDrawer';
import { SideNav } from '../components/NavLinks';
import { ProjectPicker } from '../components/ProjectPicker';
import { ScreenGuideLine } from '../components/ScreenGuide';
import { cookies, headers } from 'next/headers';
import { loadSession } from '../lib/api';
import { RenderedContextProvider } from '../components/RenderedContext';
import { SavedRecordRefresher } from '../components/SavedRecordRefresher';
import { UnsavedGuardBoot } from '../components/UnsavedGuardBoot';
import { SessionNotice } from '../components/SessionNotice';
import { REQUEST_PATH_HEADER, sessionGateFor } from '../lib/request-path';
import { decodeDisplayNameCookie, DISPLAY_NAME_COOKIE, operatorName, roleLabel } from '../lib/session-display';
import { loadSelectableProjects } from '../lib/project-data';
import type { ProjectSummary } from '../lib/project-data';
import { GUIDE_PATH, HOME_PATH, navGroupsForRole, navRole, navRoleNote } from '../lib/navigation';
import { parseProjectPath } from '../lib/project-route';
import { displayLanguage } from '../lib/locale-server';
import { selectProjectAction } from './actions';
// Astryx trial: the layer order first, then the stylesheets (layer-order.css).
import './layer-order.css';
import './globals.css';
import './p0-notices.css';
import './p1.css';
import './ui.css';
import './screens.css';
// P2 web: one stylesheet per lane (order terms, maker master / recipients, audit).
import './p2-terms.css';
import './p2-makers.css';
import './p2-audit.css';
import './p3-polish.css';
import './p4-web1.css';
import './p4-web2a.css';
import './p4-web2b.css';
import './p4-web3.css';
import './p4-web4.css';

// UI batch A: each screen sets its own title (tabs stay distinguishable); the
// template adds the product name.
export const metadata: Metadata = {
  title: { default: 'KANEI CRM オペレーター画面', template: '%s｜KANEI CRM' },
  description: 'F1フィルム商材の発注から納品確認までをブラウザで行う最小オペレーターUI'
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // P0 R04/R08: the session told apart (user / not logged in / expired / API down).
  // Without a usable session the screen is replaced by its notice and is never
  // drawn — no false empty list (H8), no logout-looking outage (H9), and no
  // screen data is asked from an API that is not answering (B4).
  const session = await loadSession();
  const user = session.kind === 'user' ? session.user : null;
  const path = (await headers()).get(REQUEST_PATH_HEADER) ?? '/';
  const gate = sessionGateFor(path, session.kind);
  const rememberedName = user
    ? decodeDisplayNameCookie((await cookies()).get(DISPLAY_NAME_COOKIE)?.value, user.id)
    : null;
  // M8-UI3: the selector lists the projects this operator may open, so the id
  // no longer has to be pasted by hand. The API narrows the list by role.
  const selectableProjects: ProjectSummary[] = user ? await loadSelectableProjects() : [];
  // P1 R20: the project shown is the one the URL names (/p/{code}/…), not a cookie.
  // P1 R29: the operator's display language (Korean gloss / Korean first).
  const display = await displayLanguage(user);
  const scoped = parseProjectPath(path);
  const projectId = scoped ? selectableProjects.find((project) => project.code === scoped.projectCode)?.id ?? null : null;
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
    <html lang={display.lang === 'ko' ? 'ko' : 'ja'} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <a className="skip-link" href="#main">本文へ移動</a>
        {/* P4 M9: the unsaved-input guard (browser Back too) is installed before the router's own listener. */}
        <UnsavedGuardBoot />
        {/* UI nav-dashboard (A): a thin top bar (project, help, user, logout) and the
            work menu in a left sidebar — a drawer opened by 「メニュー」 under 1024px. */}
        <NavDrawerProvider>
          <header className="app-header">
            <div className="app-header-inner">
              {user ? <NavDrawerToggle /> : null}
              <Link href={user ? HOME_PATH : '/'} className="app-brand">
                KANEI CRM<span className="app-brand-sub"> オペレーター画面（F1）</span>
              </Link>
              {user ? (
                <>
                  {/* UI batch B (②): one compact line; the id input is under 「詳細」. */}
                  <div className="app-header-project">
                    <ProjectPicker action={selectProjectAction} choices={projectChoices} currentProjectId={projectId} />
                  </div>
                  <div className="app-user">
                    <Link href={GUIDE_PATH} className="app-help-link">使い方</Link>
                    {/* P1 R29: the display language of this operator. */}
                    <Link href="/settings" className="app-help-link" lang={display.lang === 'ko' ? 'ko' : undefined}>{display.lang === 'ko' ? '표시 언어' : '表示言語'}</Link>
                    <span className="app-user-name">
                      {operatorName(user, rememberedName)}
                      <span style={{ color: 'var(--ink-sub)' }}>（{roleLabel(user.role)}）</span>
                    </span>
                    <LogoutButton />
                  </div>
                </>
              ) : null}
            </div>
          </header>
          <div className={user ? 'app-body app-body--signed-in' : 'app-body'}>
            {user ? <SideNav groups={navGroupsForRole(user.role)} roleNote={navRoleNote(user.role)} korean={display.showKorean} role={navRole(user.role)} /> : null}
            <main id="main" tabIndex={-1} className="app-main">
              {user ? <ScreenGuideLine /> : null}
              {gate === 'screen' ? (
                <RenderedContextProvider
                  // P1 R20: outside /p/{code}/… no project is rendered ('' — a write is refused);
                  // the project layout provides the URL's project to its own forms.
                  value={{ projectId: '', showKorean: display.showKorean, lang: display.lang }}
                >
                  {children}
                  <SavedRecordRefresher />
                </RenderedContextProvider>
              ) : (
                <SessionNotice
                  kind={gate === 'outage-notice' ? 'outage' : gate === 'expired-notice' ? 'expired' : 'login'}
                  path={path}
                  code={session.kind === 'unavailable' ? session.code : null}
                  showKorean={display.showKorean}
                />
              )}
            </main>
          </div>
        </NavDrawerProvider>
      </body>
    </html>
  );
}
