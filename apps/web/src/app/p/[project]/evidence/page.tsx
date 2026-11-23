import type { Metadata } from 'next';
import { EvidenceScreen } from '../../../../screens/EvidenceScreen';
import { resolveRouteProject } from '../../../../lib/project-route-server';
import { RouteGate } from '../../../../components/RouteGate';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '証跡の一覧' };

/** P2 P-2: the project's evidence list, drawn for the project the URL names (the layout shows a wrong or missing code). */
export default async function Page({
  params,
  searchParams
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const route = await resolveRouteProject((await params).project);
  if (route.kind !== 'open') return <RouteGate route={route} />;
  return <EvidenceScreen projectId={route.project.id} projectCode={route.project.code} searchParams={searchParams} />;
}
