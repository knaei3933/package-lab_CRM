import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../components/AstryxIsland';
import { LoginForm } from '../components/LoginForm';
import { loadSessionUser } from '../lib/api';

export const dynamic = 'force-dynamic';

/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */
export const metadata: Metadata = { title: 'ログイン' };

/**
 * Criterion 1: the login screen. A logged-in operator is sent straight to the
 * order screen; everyone else sees the username/password form that posts to
 * POST /api/auth/login (relayed to the API, which issues the session cookie).
 */
export default async function LoginPage() {
  const user = await loadSessionUser();
  if (user) redirect('/dashboard');

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
          <LoginForm />
        </Card>
        <Text as="p" type="supporting">
          {'ユーザー名やパスワードが分からないときは、代表者に確認してください。'
            + '代表者のユーザーでログインすると、承認・納品確認・手数料準備の操作も行えます。'}
        </Text>
      </VStack>
    </AstryxIsland>
  );
}
