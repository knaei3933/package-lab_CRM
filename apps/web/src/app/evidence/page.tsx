import { legacyScreenPage } from '../../screens/LegacyScreenRedirect';

export const dynamic = 'force-dynamic';

/** P2 P-2: /evidence without a project — moved to /p/{案件コード}/evidence of the last project opened. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return legacyScreenPage('evidence', await searchParams);
}
