import type { Metadata } from 'next';
import { ProjectOverviewScreen } from '../../../screens/ProjectOverviewScreen';
import { resolveRouteProject } from '../../../lib/project-route-server';
import { RouteGate } from '../../../components/RouteGate';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '案件' };

/** P1 R20: /p/{案件コード} — the project's overview. */
export default async function Page({ params }: { params: Promise<{ project: string }> }) {
  const route = await resolveRouteProject((await params).project);
  if (route.kind !== 'open') return <RouteGate route={route} />;
  return <ProjectOverviewScreen projectId={route.project.id} projectCode={route.project.code} />;
}
