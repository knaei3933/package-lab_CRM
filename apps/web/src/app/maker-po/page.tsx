import { legacyScreenPage } from '../../screens/LegacyScreenRedirect';

export const dynamic = 'force-dynamic';

/** P1 R20: the old cookie-scoped address — moved to /p/{案件コード}/maker-po. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return legacyScreenPage('maker-po', await searchParams);
}
