import type { ReactNode } from 'react';
import { RenderedContextProvider } from '../../../components/RenderedContext';
import { RouteGate } from '../../../components/RouteGate';
import { ProjectNotFound } from '../../../components/ProjectNotFound';
import { loadSessionUser } from '../../../lib/api';
import { requesterOf } from '../../../lib/requester';
import { displayLanguage } from '../../../lib/locale-server';
import { resolveRouteProject } from '../../../lib/project-route-server';

/**
 * P1 R20: every /p/{案件コード}/… screen. The code is resolved against the
 * operator's project list (the API's own answer); an unknown or unassigned
 * code shows 「この案件は見つかりません」 with the projects this operator can
 * open, never a dead end (K1). Every form below carries THIS project as its
 * rendered project — the project the write is sent to (B3: a tab switched
 * elsewhere cannot redirect it).
 */
export default async function ProjectLayout({
  children,
  params
}: {
  children: ReactNode;
  params: Promise<{ project: string }>;
}) {
  const route = await resolveRouteProject((await params).project);
  // Without a usable session the root layout shows its notice instead of this tree.
  if (route.kind === 'no-session') return <RouteGate route={route} />;
  if (route.kind === 'list-failed') return <ProjectNotFound code={null} projects={[]} listError={route.error} />;
  const user = await loadSessionUser();
  if (route.kind === 'not-found') {
    // P4 N1: with nothing to open, the person can ask the representative to assign them (the request carries their 利用者ID).
    const requester = user ? await requesterOf(user) : undefined;
    return <ProjectNotFound code={route.code} projects={route.projects} listError={null} requester={requester} />;
  }
  const display = await displayLanguage(user);
  return (
    <RenderedContextProvider
      value={{ projectId: route.project.id, showKorean: display.showKorean, lang: display.lang }}
    >
      {children}
    </RenderedContextProvider>
  );
}
