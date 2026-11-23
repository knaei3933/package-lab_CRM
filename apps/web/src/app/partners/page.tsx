import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PartnerContactsNotice, PartnerContactsScreen, PARTNERS_TITLE } from '../../components/PartnerContacts';
import { loadSession } from '../../lib/api';
import { loadPartnerAccounts } from '../../lib/partner-contacts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: PARTNERS_TITLE };

/**
 * P5 R5: /partners — the registered contact address of the customers and
 * セブン化学 (the sender check of approval mails reads it). Like /makers, only
 * the representative reads it: other roles get the notice without the list
 * being asked for, and a 403 from the API is the same notice.
 */
export default async function PartnersPage() {
  const session = await loadSession();
  if (session.kind === 'anonymous') redirect('/');
  if (session.kind !== 'user') return null;
  if (session.user.role !== 'admin') return <PartnerContactsNotice />;
  return <PartnerContactsScreen read={await loadPartnerAccounts()} />;
}
