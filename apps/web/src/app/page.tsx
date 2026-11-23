import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../components/AstryxIsland';
import { LoginForm } from '../components/LoginForm';
import { loadSessionUser } from '../lib/api';
import { LOGIN_ADMIN_ONLY_NOTE } from '../lib/login-messages';
import { DEFAULT_AFTER_LOGIN, RETURN_PARAM, safeReturnPath } from '../lib/return-path';

export const dynamic = 'force-dynamic';


/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */
export const metadata: Metadata = { title: 'ログイン' };

/**
 * Criterion 1: the login screen. A logged-in operator is sent straight to the
 * order screen; everyone else sees the username/password form that posts to
 * POST /api/auth/login (relayed to the API, which issues the session cookie).
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // P0 R08: 「ログインする」 from an expired screen carries that screen (?next=), same-site paths only.
  const returnTo = safeReturnPath((await searchParams)[RETURN_PARAM]);
  const user = await loadSessionUser();
  if (user) redirect(returnTo ?? DEFAULT_AFTER_LOGIN);

  // Astryx trial: the login screen is an Astryx island (DESIGN_RULES §1).
  // The form sits in a full-width Card, like every other panel (DESIGN_RULES §5).
  return (
    <AstryxIsland>
      <VStack as="section" gap={5}>
        <VStack gap={2}>
          <Heading level={1}>ログイン</Heading>
          {/* UI batch E (F-14, T1): no server address or source path on the login screen. */}
          <Text as="p" type="supporting">
            KANEI CRM（F1専用）のオペレーター画面です。配られたユーザー名とパスワードでログインします。
          </Text>
        </VStack>
        <Card>
          <LoginForm returnTo={returnTo} />
        </Card>
        <Text as="p" type="supporting">
          {'ユーザー名やパスワードが分からないときは、代表者に確認してください。'
            + LOGIN_ADMIN_ONLY_NOTE}
        </Text>
      </VStack>
    </AstryxIsland>
  );
}
