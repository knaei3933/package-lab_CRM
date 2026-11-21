import Link from 'next/link';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AstryxIsland } from '../components/AstryxIsland';
import { ProjectUnavailable } from '../components/ProjectUnavailable';
import { RepresentativeQueuePanel } from '../components/RepresentativeQueue';
import { DashboardFlow, DashboardItemList, DashboardActivity } from '../components/DashboardParts';
import { ProjectOrderList } from '../components/ProjectOrderList';
import { loadSessionUser } from '../lib/api';
import { buildDashboard, OTHERS_TITLE, STALE_AFTER_DAYS, STALE_BASIS, STALLED_TITLE, TODO_SCOPE, TODO_TITLE } from '../lib/dashboard';
import { loadDashboardData } from '../lib/dashboard-data';
import { canRoleOperate, normalizeRole } from '../lib/permissions';
import { loadSelectableProjectList } from '../lib/project-data';
import { newOrderPath } from '../lib/project-route';
import { failedRepresentativeQueue, loadRepresentativeQueue } from '../lib/representative-queue';
import type { ProjectScreenProps } from './screen-props';

/** The representative's waiting decisions in every project but the open one (UI batch E F-23). */
async function representativeQueueFor(openProjectId: string | null) {
  const list = await loadSelectableProjectList();
  if (list.error) return failedRepresentativeQueue(list.error);
  return loadRepresentativeQueue(list.projects.filter((project) => project.id !== openProjectId));
}

/**
 * P1 R20: /p/{案件コード} — the project's overview (the former dashboard of the
 * selected project). Its film orders are listed first, each a link to the
 * order's own screen (R21), then what is waiting, what is stuck and the latest
 * records. Every item opens the order (or the list) inside this project.
 */
export async function ProjectOverviewScreen({ projectId, projectCode }: ProjectScreenProps) {
  const user = await loadSessionUser();
  if (!user) return null;
  const role = normalizeRole(user.role);

  const [data, queue] = await Promise.all([
    loadDashboardData(projectId),
    role === 'admin' ? representativeQueueFor(projectId) : Promise.resolve(null)
  ]);
  const { workspace, boards } = data.board;
  if (workspace.projectRefused) return <ProjectUnavailable title="案件" reason={workspace.error} returnTo="/dashboard" />;

  const view = buildDashboard({ role: user.role, workspace, boards, activity: data.activity, now: new Date() });
  const projectName = workspace.project ? `${workspace.project.code}（${workspace.project.name}）` : null;

  return (
    <AstryxIsland>
      <VStack as="section" gap={5}>
        <VStack gap={2}>
          <Heading level={1}>{projectName ?? projectCode}</Heading>
          {workspace.error ? <Banner status="error" title={workspace.error} /> : null}
        </VStack>

        <section aria-labelledby="project-orders-title" className="p1-panel p1-orders">
          <div className="p1-orders-head">
            <h2 id="project-orders-title" className="p1-section-title">フィルム発注</h2>
            {canRoleOperate(user.role, 'film_order:create') ? (
              <Link className="p1-button p1-button--primary" href={newOrderPath(projectCode)}>新しいフィルム発注</Link>
            ) : null}
          </div>
          <ProjectOrderList workspace={workspace} projectCode={projectCode} loadFailed={Boolean(workspace.error)} />
        </section>

        <DashboardFlow view={view} projectCode={projectCode} />

        <div className="dash-columns">
          <Card>
            <VStack gap={3}>
              <Heading level={2}>{TODO_TITLE}</Heading>
              <Text as="p" type="supporting">{TODO_SCOPE[role]}</Text>
              {role === 'viewer' ? null : (
                <DashboardItemList
                  projectCode={projectCode}
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
                projectCode={projectCode}
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
              <DashboardItemList projectCode={projectCode} items={view.stalled} label={STALLED_TITLE} empty={`${STALE_AFTER_DAYS}日以上更新が止まっている発注はありません。`} />
            )}
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <Heading level={2}>{OTHERS_TITLE[role]}</Heading>
            <DashboardItemList projectCode={projectCode} items={view.others} label={OTHERS_TITLE[role]} empty="ほかの人の作業待ちはありません。" />
          </VStack>
        </Card>

        {queue ? (
          <Card>
            <VStack gap={3}>
              <Heading level={2}>代表者の対応待ち（ほかの案件）</Heading>
              <RepresentativeQueuePanel queue={queue} currentProjectId={projectId} />
            </VStack>
          </Card>
        ) : null}

        <Card>
          <VStack gap={3}>
            <Heading level={2}>最近の記録</Heading>
            <DashboardActivity view={view} projectCode={projectCode} />
          </VStack>
        </Card>
      </VStack>
    </AstryxIsland>
  );
}
