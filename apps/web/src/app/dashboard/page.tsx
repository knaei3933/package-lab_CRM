import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../../components/AstryxIsland';
import { ProjectChooser } from '../../components/ProjectChooser';
import { RepresentativeQueuePanel } from '../../components/RepresentativeQueue';
import { loadSession } from '../../lib/api';
import { requesterOf } from '../../lib/requester';
import { normalizeRole } from '../../lib/permissions';
import { loadSelectableProjectList } from '../../lib/project-data';
import { projectPath } from '../../lib/project-route';
import { projectSelectionFor } from '../../lib/project-selection-server';
import { failedRepresentativeQueue, loadRepresentativeQueue } from '../../lib/representative-queue';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'ダッシュボード' };

/** The representative's waiting decisions in every project but the open one (UI batch E F-23). */
async function representativeQueueFor(openProjectId: string | null) {
  const list = await loadSelectableProjectList();
  if (list.error) return failedRepresentativeQueue(list.error);
  // P4 H3: the server's own queue (it holds the manual checks the web's status replay misses); the web replay is the fallback.
  return loadRepresentativeQueue(list.projects.filter((project) => project.id !== openProjectId), { server: true });
}

/**
 * UI nav-dashboard (B, C): the first screen after login. Top to bottom: where
 * the project's orders are in the flow (the one bold element, as on every
 * screen's stepper), the one next action, the operator's own list, what is
 * stuck, the other role's list, and the latest recorded work. Every item opens
 * the screen (and order) where it is done; every record is still made there.
 */
export default async function DashboardPage() {
  // P0 R04/R08: only a visitor who never logged in goes to the login screen; an
  // expired session or an API outage is the layout's notice (never a silent logout, H9).
  const session = await loadSession();
  if (session.kind === 'anonymous') redirect('/');
  if (session.kind !== 'user') return null;
  const user = session.user;
  const role = normalizeRole(user.role);
  const selection = await projectSelectionFor('/dashboard');
  // P1 R20: an open project lives at its own address — the dashboard opens it there.
  if (selection.kind === 'open') {
    const list = await loadSelectableProjectList();
    const open = list.projects.find((project) => project.id === selection.projectId);
    if (open) redirect(projectPath(open.code));
  }

  if (selection.kind !== 'open') {
    const queue = role === 'admin' && selection.kind === 'choose' ? await representativeQueueFor(null) : null;
    return (
      <AstryxIsland>
        <VStack as="section" gap={5}>
          <Heading level={1}>ダッシュボード</Heading>
          {/* ui/fix-project-select: choose here, not in the header — one big card per project. */}
          <ProjectChooser selection={selection} role={role} requester={await requesterOf(user)} />
          {queue ? (
            <Card>
              <VStack gap={3}>
                <Heading level={2}>代表者の対応待ち（全案件）</Heading>
                <RepresentativeQueuePanel queue={queue} currentProjectId={null} />
              </VStack>
            </Card>
          ) : null}
          <Text as="p" type="supporting">
            初めて使うときは、<Link href="/guide">使い方ガイド</Link>で役割ごとの一日の流れを先に確認してください。
          </Text>
        </VStack>
      </AstryxIsland>
    );
  }
  return null;
}
