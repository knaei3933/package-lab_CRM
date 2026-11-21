import type { Metadata } from 'next';
import { DocumentsScreen } from '../../../../screens/DocumentsScreen';
import { resolveRouteProject } from '../../../../lib/project-route-server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '文書' };

/** P1 R20: the project's list, drawn for the project the URL names (the layout shows a wrong or missing code). */
export default async function Page({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const route = await resolveRouteProject((await params).project);
  if (route.kind !== 'open') return null;
  return <DocumentsScreen projectId={route.project.id} projectCode={route.project.code} searchParams={searchParams} />;
}
