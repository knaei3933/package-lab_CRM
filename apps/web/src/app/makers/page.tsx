import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MakerMasterNotice, MakerMasterScreen, MAKERS_TITLE } from '../../components/MakerMaster';
import { loadSession } from '../../lib/api';
import { loadMakerAccounts } from '../../lib/maker-master';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: MAKERS_TITLE };

/**
 * P2 R33 (DESIGN §5): /makers — the company-wide maker master, outside any
 * project. Only the representative reads it: other roles get the notice
 * without the list being asked for, and a 403 from the API is the same notice.
 */
export default async function MakersPage() {
  const session = await loadSession();
  if (session.kind === 'anonymous') redirect('/');
  if (session.kind !== 'user') return null;
  if (session.user.role !== 'admin') return <MakerMasterNotice />;
  return <MakerMasterScreen read={await loadMakerAccounts()} />;
}
