import type { ReactNode } from 'react';
import { RenderedContextProvider } from '../../../components/RenderedContext';
import { ProjectNotFound } from '../../../components/ProjectNotFound';
import { loadSessionUser } from '../../../lib/api';
import { normalizeRole } from '../../../lib/permissions';
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
  if (route.kind === 'no-session') return null;
  if (route.kind === 'list-failed') return <ProjectNotFound code={null} projects={[]} listError={route.error} />;
  if (route.kind === 'not-found') return <ProjectNotFound code={route.code} projects={route.projects} listError={null} />;
  const user = await loadSessionUser();
  return (
    <RenderedContextProvider
      value={{ projectId: route.project.id, showKorean: user ? normalizeRole(user.role) === 'admin' : false }}
    >
      {children}
    </RenderedContextProvider>
  );
}
