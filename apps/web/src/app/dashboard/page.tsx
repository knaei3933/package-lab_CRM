import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../../components/AstryxIsland';
import { ProjectChooser } from '../../components/ProjectChooser';
import { ProjectUnavailable } from '../../components/ProjectUnavailable';
import { RepresentativeQueuePanel } from '../../components/RepresentativeQueue';
import { DashboardFlow, DashboardItemList, DashboardActivity } from '../../components/DashboardParts';
import { openProjectFromCardAction, selectProjectAction } from '../actions';
import { loadSession } from '../../lib/api';
import { buildDashboard, OTHERS_TITLE, STALE_AFTER_DAYS, STALE_BASIS, STALLED_TITLE, TODO_SCOPE, TODO_TITLE } from '../../lib/dashboard';
import { loadDashboardData } from '../../lib/dashboard-data';
import { normalizeRole } from '../../lib/permissions';
import { loadSelectableProjectList } from '../../lib/project-data';
import { projectSelectionFor } from '../../lib/project-selection-server';
import { failedRepresentativeQueue, loadRepresentativeQueue } from '../../lib/representative-queue';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'ダッシュボード' };

/** The representative's waiting decisions in every project but the open one (UI batch E F-23). */
async function representativeQueueFor(openProjectId: string | null) {
  const list = await loadSelectableProjectList();
  if (list.error) return failedRepresentativeQueue(list.error);
  return loadRepresentativeQueue(list.projects.filter((project) => project.id !== openProjectId));
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

  if (selection.kind !== 'open') {
    const queue = role === 'admin' && selection.kind === 'choose' ? await representativeQueueFor(null) : null;
    return (
      <AstryxIsland>
        <VStack as="section" gap={5}>
          <Heading level={1}>ダッシュボード</Heading>
          {/* ui/fix-project-select: choose here, not in the header — one big card per project. */}
          <ProjectChooser selection={selection} role={role} openAction={openProjectFromCardAction} />
          {queue ? (
            <Card>
              <VStack gap={3}>
                <Heading level={2}>代表者の対応待ち（全案件）</Heading>
                <RepresentativeQueuePanel queue={queue} selectAction={selectProjectAction} currentProjectId={null} />
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
  const projectId = selection.projectId;

  const [data, queue] = await Promise.all([
    loadDashboardData(projectId),
    role === 'admin' ? representativeQueueFor(projectId) : Promise.resolve(null)
  ]);
  const { workspace, boards } = data.board;
  if (workspace.projectRefused) return <ProjectUnavailable title="ダッシュボード" reason={workspace.error} returnTo="/dashboard" />;

  const view = buildDashboard({ role: user.role, workspace, boards, activity: data.activity, now: new Date() });
  const projectName = workspace.project ? `${workspace.project.code}（${workspace.project.name}）` : null;

  return (
    <AstryxIsland>
      <VStack as="section" gap={5}>
        <VStack gap={2}>
          <Heading level={1}>ダッシュボード</Heading>
          {projectName ? <Text as="p" type="supporting">案件: {projectName}</Text> : null}
          {workspace.error ? <Banner status="error" title={workspace.error} /> : null}
        </VStack>

        <DashboardFlow view={view} />

        <div className="dash-columns">
          <Card>
            <VStack gap={3}>
              <Heading level={2}>{TODO_TITLE}</Heading>
              <Text as="p" type="supporting">{TODO_SCOPE[role]}</Text>
              {role === 'viewer' ? null : (
                <DashboardItemList
                  items={view.todo}
                  label={TODO_TITLE}
                  empty={workspace.error
                    ? '一覧を表示できませんでした。画面上部の案内を確認してください。'
                    : workspace.filmOrders.length === 0
                      ? 'フィルム発注はまだありません。上の「次にやること」から始めます。'
                      : 'いま、あなたが記録する作業はありません。'}
                />
              )}
            </VStack>
          </Card>
          <Card>
            <VStack gap={3}>
              <Heading level={2}>止まっている発注</Heading>
              <Text as="p" type="supporting">保留・変更レビュー・取消レビュー中のもの、明細やセブン化学発注書の紐付けがないもの、支払条件が「未定」のものや送信確認で進めないもの。</Text>
              <DashboardItemList
                items={view.blocked}
                label="止まっている発注"
                empty={workspace.error ? '一覧を表示できませんでした。' : '止まっている発注はありません。'}
              />
            </VStack>
          </Card>
        </div>

        <Card>
          <VStack gap={3}>
            <Heading level={2}>{STALLED_TITLE}</Heading>
            <Text as="p" type="supporting">{STALE_BASIS}</Text>
            {view.stalledNote ? (
              <p className="dash-empty">{view.stalledNote}</p>
            ) : (
              <DashboardItemList items={view.stalled} label={STALLED_TITLE} empty={`${STALE_AFTER_DAYS}日以上更新が止まっている発注はありません。`} />
            )}
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}>{OTHERS_TITLE[role]}</Heading>
            <DashboardItemList items={view.others} label={OTHERS_TITLE[role]} empty="ほかの人の作業待ちはありません。" />
          </VStack>
        </Card>

        {queue ? (
          <Card>
            <VStack gap={3}>
              <Heading level={2}>代表者の対応待ち（ほかの案件）</Heading>
              <RepresentativeQueuePanel queue={queue} selectAction={selectProjectAction} currentProjectId={projectId} />
            </VStack>
          </Card>
        ) : null}

        <Card>
          <VStack gap={3}>
            <Heading level={2}>最近の記録</Heading>
            <DashboardActivity view={view} />
          </VStack>
        </Card>
      </VStack>
    </AstryxIsland>
  );
}
