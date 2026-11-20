import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { ActionForm } from '../../components/ActionForm';
import { AstryxIsland } from '../../components/AstryxIsland';
import { ProjectUnavailable } from '../../components/ProjectUnavailable';
import { RepresentativeQueuePanel } from '../../components/RepresentativeQueue';
import { DashboardFlow, DashboardItemList, DashboardActivity } from '../../components/DashboardParts';
import { selectProjectAction } from '../actions';
import { loadSessionUser, readSelectedProjectId } from '../../lib/api';
import { buildDashboard } from '../../lib/dashboard';
import { loadDashboardData } from '../../lib/dashboard-data';
import { normalizeRole } from '../../lib/permissions';
import { loadSelectableProjectList, NO_PROJECT_SELECTED_MESSAGE } from '../../lib/project-data';
import { failedRepresentativeQueue, loadRepresentativeQueue } from '../../lib/representative-queue';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'ダッシュボード' };

/** The representative's waiting decisions in every project but the open one (UI batch E F-23). */
async function representativeQueueFor(openProjectId: string | null) {
  const list = await loadSelectableProjectList();
  if (list.error) return failedRepresentativeQueue(list.error);
  return loadRepresentativeQueue(list.projects.filter((project) => project.id !== openProjectId));
}

const TODO_TITLE: Record<'admin' | 'staff' | 'viewer', string> = {
  admin: '지금 내가 할 일（代表者: 承認・保留/変更レビューの解除）',
  staff: '지금 내가 할 일（担当者: 記録・証跡・納品）',
  viewer: '지금 내가 할 일'
};

const OTHERS_TITLE: Record<'admin' | 'staff' | 'viewer', string> = {
  admin: '担当者가 진행 중인 작업',
  staff: '代表者 대기（代表者が行う作業）',
  viewer: '진행 중인 작업（누가 무엇을 하는지）'
};

/**
 * UI nav-dashboard (B, C): the first screen after login. Top to bottom: where
 * the project's orders are in the flow (the one bold element, as on every
 * screen's stepper), the one next action, the operator's own list, what is
 * stuck, the other role's list, and the latest recorded work. Every item opens
 * the screen (and order) where it is done; every record is still made there.
 */
export default async function DashboardPage() {
  const user = await loadSessionUser();
  if (!user) redirect('/');
  const role = normalizeRole(user.role);
  const projectId = await readSelectedProjectId();

  if (!projectId) {
    const [list, queue] = await Promise.all([
      loadSelectableProjectList(),
      role === 'admin' ? representativeQueueFor(null) : Promise.resolve(null)
    ]);
    return (
      <AstryxIsland>
        <VStack as="section" gap={5}>
          <VStack gap={2}>
            <Heading level={1}>ダッシュボード</Heading>
            <Banner status="info" title={NO_PROJECT_SELECTED_MESSAGE} />
          </VStack>
          <Card>
            <VStack gap={3}>
              <Heading level={2}>まず案件を開く</Heading>
              <Text as="p" type="supporting">
                <span lang="ko">작업은 案件 단위로 합니다. 아래에서 담당 案件을 열면 그 案件의 진행 상황과 할 일이 표시됩니다.</span>
              </Text>
              {list.error ? (
                <Text as="p">{`案件の一覧を読み込めませんでした（${list.error}）。画面上部の「案件」から選んでください。`}</Text>
              ) : list.projects.length === 0 ? (
                <Text as="p">
                  {role === 'admin'
                    ? '開ける案件がまだありません。案件の作成は管理者の手順で行います。'
                    : '割り当てられた案件がありません。代表者に案件の割り当てを依頼してください。'}
                </Text>
              ) : (
                <ul className="dash-project-list">
                  {list.projects.map((project) => (
                    <li key={project.id}>
                      <span translate="no">{project.code}</span>
                      <span>{project.name}</span>
                      <ActionForm action={selectProjectAction} submitLabel="この案件を開く">
                        <input type="hidden" readOnly name="projectId" value={project.id} />
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}
            </VStack>
          </Card>
          {queue ? (
            <Card>
              <VStack gap={3}>
                <Heading level={2}>代表者の対応待ち（全案件）</Heading>
                <RepresentativeQueuePanel queue={queue} selectAction={selectProjectAction} currentProjectId={null} />
              </VStack>
            </Card>
          ) : null}
          <Text as="p" type="supporting">
            <span lang="ko">처음이라면 </span>
            <Link href="/guide">使い方ガイド</Link>
            <span lang="ko">에서 역할별 하루 흐름을 먼저 읽어 보세요.</span>
          </Text>
        </VStack>
      </AstryxIsland>
    );
  }

  const [data, queue] = await Promise.all([
    loadDashboardData(projectId),
    role === 'admin' ? representativeQueueFor(projectId) : Promise.resolve(null)
  ]);
  const { workspace, boards } = data.board;
  if (workspace.projectRefused) return <ProjectUnavailable title="ダッシュボード" reason={workspace.error} />;

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
              <Heading level={2}><span lang="ko">{TODO_TITLE[role]}</span></Heading>
              {role === 'viewer' ? (
                <Text as="p" type="supporting">
                  <span lang="ko">閲覧者는 기록·변경을 하지 않습니다. 아래 「막힌 건」과 「진행 중인 작업」에서 진행 상황을 확인하세요.</span>
                </Text>
              ) : (
                <DashboardItemList
                  items={view.todo}
                  label="지금 내가 할 일"
                  empty={workspace.error
                    ? '一覧を表示できませんでした。画面上部の案内を確認してください。'
                    : workspace.filmOrders.length === 0
                      ? 'フィルム発注はまだありません。上の「다음 행동」から始めます。'
                      : 'いま、あなたが記録する作業はありません。'}
                />
              )}
            </VStack>
          </Card>
          <Card>
            <VStack gap={3}>
              <Heading level={2}><span lang="ko">막힌 건（保留・証跡未登録・長期停止）</span></Heading>
              <DashboardItemList
                items={view.blocked}
                label="막힌 건"
                empty={workspace.error ? '一覧を表示できませんでした。' : '止まっている発注はありません。'}
              />
            </VStack>
          </Card>
        </div>

        <Card>
          <VStack gap={3}>
            <Heading level={2}><span lang="ko">{OTHERS_TITLE[role]}</span></Heading>
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
            <Heading level={2}><span lang="ko">최근 활동</span></Heading>
            <DashboardActivity view={view} />
          </VStack>
        </Card>
      </VStack>
    </AstryxIsland>
  );
}
