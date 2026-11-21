import type { Metadata } from 'next';
import { MakerPoScreen } from '../../../../screens/MakerPoScreen';
import { resolveRouteProject } from '../../../../lib/project-route-server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'メーカー発注' };

/** P1 R20: the project's list, drawn for the project the URL names (the layout shows a wrong or missing code). */
export default async function Page({ params }: { params: Promise<{ project: string }> }) {
  const route = await resolveRouteProject((await params).project);
  if (route.kind !== 'open') return null;
  return <MakerPoScreen projectId={route.project.id} projectCode={route.project.code} />;
}
