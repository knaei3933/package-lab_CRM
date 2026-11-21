import type { Metadata } from 'next';
import { ApprovalsScreen } from '../../../../screens/ApprovalsScreen';
import { resolveRouteProject } from '../../../../lib/project-route-server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '承認' };

/** P1 R20: the project's list, drawn for the project the URL names (the layout shows a wrong or missing code). */
export default async function Page({ params }: { params: Promise<{ project: string }> }) {
  const route = await resolveRouteProject((await params).project);
  if (route.kind !== 'open') return null;
  return <ApprovalsScreen projectId={route.project.id} projectCode={route.project.code} />;
}
