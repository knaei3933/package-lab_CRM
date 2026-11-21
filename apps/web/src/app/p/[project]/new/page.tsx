import type { Metadata } from 'next';
import { NewOrderScreen } from '../../../../screens/NewOrderScreen';
import { resolveRouteProject } from '../../../../lib/project-route-server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '新しいフィルム発注' };

/** P1 R21: /p/{案件コード}/new — 発注書の受付 → 照合 → 発注内容 in one form. */
export default async function Page({ params }: { params: Promise<{ project: string }> }) {
  const route = await resolveRouteProject((await params).project);
  if (route.kind !== 'open') return null;
  return <NewOrderScreen projectId={route.project.id} projectCode={route.project.code} />;
}
