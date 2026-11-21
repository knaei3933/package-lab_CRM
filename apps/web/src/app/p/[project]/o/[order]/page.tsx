import type { Metadata } from 'next';
import { OrderDetailScreen } from '../../../../../screens/OrderDetailScreen';
import { resolveRouteProject } from '../../../../../lib/project-route-server';
import { decodeRouteCode } from '../../../../../lib/project-route';

export const dynamic = 'force-dynamic';

/** The tab title is the order code itself (the screen's title is the object, REDESIGN §8-3). */
export async function generateMetadata({ params }: { params: Promise<{ order: string }> }): Promise<Metadata> {
  return { title: decodeRouteCode((await params).order) ?? 'フィルム発注' };
}

/** P1 R21: /p/{案件コード}/o/{発注コード} — one film order. */
export default async function Page({
  params,
  searchParams
}: {
  params: Promise<{ project: string; order: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { project, order } = await params;
  const route = await resolveRouteProject(project);
  if (route.kind !== 'open') return null;
  const orderCode = decodeRouteCode(order);
  const query = await searchParams;
  return (
    <OrderDetailScreen
      projectId={route.project.id}
      projectCode={route.project.code}
      orderCode={orderCode ?? ''}
      started={query.started === '1'}
    />
  );
}
