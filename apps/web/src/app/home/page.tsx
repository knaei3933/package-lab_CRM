import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HomeScreen } from '../../screens/HomeScreen';
import { loadSession } from '../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'ホーム' };

/** P1 R26: the role's home — 承認箱 (代表) / 自分の作業 (担当) / 履歴 (閲覧). */
export default async function Page() {
  const session = await loadSession();
  if (session.kind === 'anonymous') redirect('/');
  if (session.kind !== 'user') return null;
  return <HomeScreen />;
}
