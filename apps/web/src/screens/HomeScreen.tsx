import Link from 'next/link';
import { Bilingual } from '../components/Bilingual';
import { callApi, loadSessionUser } from '../lib/api';
import { ACTION_LABELS } from '../lib/dashboard';
import { loadMyWork } from '../lib/my-work';
import type { WorkGroup, WorkRow } from '../lib/my-work';
import { isAuditorRole, normalizeRole } from '../lib/permissions';
import { loadSelectableProjectList } from '../lib/project-data';
import type { AuditEventView, ProjectSummary } from '../lib/project-data';
import { evidenceCell, evidenceIndex, eventTargets } from '../lib/audit-history';
import type { EvidenceRef } from '../lib/audit-history';
import { loadEvidenceMetadata } from '../lib/evidence-data';
import { roleLabel } from '../lib/session-display';
import { isRouteCode, orderPath, projectPath } from '../lib/project-route';
import { loadRepresentativeQueue } from '../lib/representative-queue';
import type { RepresentativeQueue, RepresentativeTask } from '../lib/representative-queue';
import { formatTimestamp } from '../lib/vocabulary';

/**
 * P1 R26 (REDESIGN §5-1, §5-2, §5-8, §6): the first screen after login, by role.
 * - 代表: 承認箱 — every piece of representative work across projects, each a
 *   link straight to the order at its step (R25), and what is stuck that the
 *   representative can fix. On a phone the rows are cards (R35).
 * - 担当: 自分の作業 — いま進められる / 相手待ち / 止まっている.
 * - 閲覧(監査): 履歴 — who approved or confirmed what, when (amounts are never
 *   read here). A separate 監査 role needs a server role (P-2, reported).
 * A list that could not be read says so (never a false 「ありません」, H8).
 */
export const HOME_TITLES = { admin: '承認箱', staff: '自分の作業', viewer: '履歴', auditor: '監査履歴' } as const;

const HISTORY_ACTIONS = [
  'ARTWORK_APPROVAL_RECORDED',
  'EVIDENCE_MANUAL_VERIFICATION_RECORDED',
  'MAKER_PO_CEO_APPROVED',
  'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED',
  'MAKER_PO_ACCEPT_EVIDENCE_REGISTERED',
  'DOCUMENT_VERIFICATION_RECORDED',
  'FILM_RECEIPT_ASSUMPTION_RECORDED',
  'FILM_SUPPLY_ORDER_HOLD_RELEASED',
  'FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED',
  'MAKER_PO_CANCELLED'
];

export async function HomeScreen() {
  const user = await loadSessionUser();
  if (!user) return null;
  // P2 P-2: the auditor reads as a viewer everywhere else; only its home is its own.
  const role = isAuditorRole(user.role) ? 'auditor' : normalizeRole(user.role);
  const list = await loadSelectableProjectList();
  return (
    <section className="p1-home" aria-labelledby="home-title">
      <h1 id="home-title" className="p1-title" tabIndex={-1}>
        <Bilingual ja={HOME_TITLES[role]} ko={role === 'admin' ? '승인함' : role === 'staff' ? '내 작업' : role === 'auditor' ? '감사 이력' : '이력'} />
      </h1>
      {list.error ? (
        <p className="p1-banner p1-banner--error" role="alert">案件の一覧を読み込めませんでした（{list.error}）。少し待ってから再読み込みしてください。</p>
      ) : role === 'admin' ? (
        <AdminInbox projects={list.projects} />
      ) : role === 'staff' ? (
        <StaffWork projects={list.projects} role={user.role} />
      ) : role === 'auditor' ? (
        <AuditorHistory projects={list.projects} />
      ) : (
        <ViewerHistory projects={list.projects} />
      )}
      <p className="p1-muted">
        <Link href="/dashboard">案件を選んで開く</Link>
        {list.projects.length > 0 ? (
          <>
            {' ・ '}
            {list.projects.slice(0, 5).map((project, index) => (
              <span key={project.id}>{index > 0 ? '、' : ''}<Link href={projectPath(project.code)} translate="no">{project.code}</Link></span>
            ))}
          </>
        ) : null}
      </p>
    </section>
  );
}

function taskHref(task: RepresentativeTask): string {
  if (isRouteCode(task.projectCode) && isRouteCode(task.orderCode)) return orderPath(task.projectCode, task.orderCode, task.step ?? null);
  return isRouteCode(task.projectCode) ? projectPath(task.projectCode) : '/dashboard';
}

async function AdminInbox({ projects }: { projects: ProjectSummary[] }) {
  const queue: RepresentativeQueue = await loadRepresentativeQueue(projects, { server: true });
  const tasks = queue.tasks;
  const blocked = queue.blocked ?? [];
  return (
    <>
      <p className="p1-lead">
        <Bilingual ja={`代表の判断が必要な作業 ${tasks.length}件`} ko={`대표 판단이 필요한 작업 ${tasks.length}건`} />
      </p>
      {queue.listError ? (
        <p className="p1-banner p1-banner--error" role="alert">代表の作業を読み込めませんでした（{queue.listError}）。</p>
      ) : tasks.length === 0 ? (
        <p className="p1-muted"><Bilingual ja="代表の判断が必要な作業はありません。" ko="대표 판단이 필요한 작업이 없습니다." /></p>
      ) : (
        <ul className="p1-inbox" aria-label="承認箱">
          {tasks.map((task) => (
            <li key={`${task.kind ?? task.status}-${task.projectId}-${task.orderId}`} className="p1-inbox-item">
              <p className="p1-inbox-work">{task.work}</p>
              <p className="p1-inbox-target">
                <span translate="no">{task.orderCode}</span>
                <span className="p1-muted-inline"> ・ <span translate="no">{task.projectCode}</span></span>
                {task.displayNumber ? <span className="p1-muted-inline"> ・ <span translate="no" className="p1-figure">{task.displayNumber}</span></span> : null}
              </p>
              <p className="p1-inbox-facts">
                {[task.amount, task.waitingSince ? `${formatTimestamp(task.waitingSince)}から` : null, task.requestedBy ? `依頼 ${task.requestedBy}` : null]
                  .filter(Boolean).join(' ・ ') || ' '}
              </p>
              <Link className="p1-button p1-button--primary p1-inbox-go" href={taskHref(task)}>
                {task.kind === 'maker_po_ceo_approval' ? '内容を見て承認' : '開く'}
                <span className="visually-hidden">（{task.orderCode}{task.displayNumber ? ` ${task.displayNumber}` : ''}）</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {blocked.length > 0 ? (
        <section aria-labelledby="inbox-blocked-title">
          <h2 id="inbox-blocked-title" className="p1-section-title">止まっている（代表が直せるもの）</h2>
          <ul className="p1-inbox" aria-label="止まっている">
            {blocked.map((task) => (
              <li key={`b-${task.kind}-${task.orderId}`} className="p1-inbox-item p1-inbox-item--blocked">
                <p className="p1-inbox-work"><span translate="no">{task.orderCode}</span></p>
                <p className="p1-inbox-target">{task.blockedReason ?? task.work}</p>
                <Link className="p1-button p1-button--quiet p1-inbox-go" href={taskHref(task)}>直す<span className="visually-hidden">（{task.orderCode}）</span></Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {queue.source === 'web' ? (
        <p className="p1-muted">この一覧は発注の状態から作っています（証跡・送信の手動確認は各発注の画面に出ます）。</p>
      ) : null}
      {queue.unreadProjects.length > 0 ? <p className="p1-muted">読み込めなかった案件: {queue.unreadProjects.join('、')}</p> : null}
    </>
  );
}

const GROUPS: Array<{ key: WorkGroup; title: string; mark: string }> = [
  { key: 'now', title: 'いま進められる', mark: '●' },
  { key: 'waiting', title: '相手待ち', mark: '…' },
  { key: 'stuck', title: '止まっている', mark: '✕' }
];

async function StaffWork({ projects, role }: { projects: ProjectSummary[]; role: string }) {
  const work = await loadMyWork(projects, role);
  return (
    <>
      <p className="p1-lead">{`自分の作業 ${work.rows.filter((row) => row.group === 'now').length}件`}</p>
      {GROUPS.map((group) => {
        const rows = work.rows.filter((row) => row.group === group.key);
        return (
          <section key={group.key} aria-labelledby={`work-${group.key}`} className="p1-work-group">
            <h2 id={`work-${group.key}`} className="p1-section-title"><span aria-hidden="true">{group.mark} </span>{group.title}（{rows.length}）</h2>
            {rows.length === 0 ? (
              <p className="p1-muted">ありません。</p>
            ) : (
              <ul className="p1-inbox" aria-label={group.title}>
                {rows.map((row: WorkRow) => (
                  <li key={row.key} className={`p1-inbox-item p1-inbox-item--${group.key}`}>
                    <p className="p1-inbox-work"><span translate="no">{row.orderCode}</span> <span className="p1-muted-inline">{row.stepTitle}</span></p>
                    <p className="p1-inbox-target">{row.text}</p>
                    <Link className={`p1-button ${group.key === 'now' ? 'p1-button--primary' : 'p1-button--quiet'} p1-inbox-go`} href={orderPath(row.projectCode, row.orderCode, row.step)}>
                      開く<span className="visually-hidden">（{row.orderCode}）</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {work.unreadProjects.length > 0 ? <p className="p1-muted">読み込めなかった案件: {work.unreadProjects.join('、')}</p> : null}
      {work.skippedProjects > 0 ? <p className="p1-muted">案件が多いため、ほかの{work.skippedProjects}件は各案件の画面で確認してください。</p> : null}
    </>
  );
}

async function ViewerHistory({ projects }: { projects: ProjectSummary[] }) {
  const answers = await Promise.all(projects.slice(0, 10).map((project) => callApi<{ events: AuditEventView[] }>(
    `/api/projects/${encodeURIComponent(project.id)}/audit-history?limit=50&order=desc&action=${encodeURIComponent(HISTORY_ACTIONS.join(','))}`
  )));
  const rows: Array<{ event: AuditEventView; project: ProjectSummary }> = [];
  const unread: string[] = [];
  answers.forEach((answer, index) => {
    const project = projects[index]!;
    if (!answer.ok || !answer.data || !Array.isArray(answer.data.events)) {
      unread.push(project.code);
      return;
    }
    for (const event of answer.data.events) rows.push({ event, project });
  });
  rows.sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt));
  return (
    <>
      <p className="p1-lead">承認・確認の記録（新しい順、最大20件）。金額は表示しません。</p>
      {rows.length === 0 ? (
        <p className="p1-muted">{unread.length > 0 ? '履歴を読み込めませんでした。' : 'まだ承認・確認の記録はありません。'}</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="承認・確認の履歴" tabIndex={0}>
          <table className="p1-history">
            <caption className="visually-hidden">承認・確認の履歴</caption>
            <thead>
              <tr><th scope="col">日時</th><th scope="col">誰</th><th scope="col">何を</th><th scope="col">案件</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map(({ event, project }) => (
                <tr key={event.id}>
                  <td className="p1-figure">{formatTimestamp(event.occurredAt)}</td>
                  <td>{event.actor?.displayName ?? '—'}</td>
                  <td>{ACTION_LABELS[event.action] ?? '記録'}</td>
                  <td><Link href={projectPath(project.code)} translate="no">{project.code}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unread.length > 0 ? <p className="p1-muted">読み込めなかった案件: {unread.join('、')}</p> : null}
    </>
  );
}

const AUDIT_COLUMNS = ['誰が', 'いつ', '何を', '根拠'] as const;

function EvidenceCellView({ cell }: { cell: ReturnType<typeof evidenceCell> }) {
  if (cell.kind === 'none') return <>記録のみ（証跡なし）</>;
  if (cell.kind === 'unreadable') return <>証跡の情報を読み込めませんでした</>;
  const evidence: EvidenceRef = cell.evidence;
  return (
    <>
      <span>{evidence.label}</span>
      <span className="p2-audit-sub p1-muted-inline" translate="no">{evidence.filename ?? 'ファイル名は非表示'}</span>
      {evidence.hash ? <span className="p2-audit-sub p1-hash" translate="no">SHA-256 {evidence.hash}</span> : null}
    </>
  );
}

/**
 * P2 P-2: the auditor's home — 誰が・いつ・何を・根拠. Read only: no form and no
 * download link (the API refuses an auditor the file bytes). Amounts are never
 * read; the lead line says so instead of an all-dash column (DESIGN §7).
 */
async function AuditorHistory({ projects }: { projects: ProjectSummary[] }) {
  if (projects.length === 0) {
    return <p className="p1-muted">監査する案件が、まだ割り当てられていません。代表者に案件の割り当てを依頼してください。</p>;
  }
  const read = projects.slice(0, 10);
  const answers = await Promise.all(read.map((project) => callApi<{ events: AuditEventView[] }>(
    `/api/projects/${encodeURIComponent(project.id)}/audit-history?limit=50&order=desc&action=${encodeURIComponent(HISTORY_ACTIONS.join(','))}`
  )));
  const rows: Array<{ event: AuditEventView; project: ProjectSummary }> = [];
  const unread: string[] = [];
  answers.forEach((answer, index) => {
    const project = read[index]!;
    if (!answer.ok || !answer.data || !Array.isArray(answer.data.events)) {
      unread.push(project.code);
      return;
    }
    for (const event of answer.data.events) rows.push({ event, project });
  });
  rows.sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt));
  const shown = rows.slice(0, 20);
  // Evidence is read only for the projects whose shown rows cite a file version.
  const needing = new Set(shown.filter(({ event }) => typeof event.afterState?.evidenceDocumentVersionId === 'string').map(({ project }) => project.id));
  const evidence = new Map<string, Map<string, EvidenceRef> | null>();
  await Promise.all([...needing].map(async (projectId) => {
    const answer = await loadEvidenceMetadata(projectId, { limit: 500 });
    evidence.set(projectId, answer.ok ? evidenceIndex(answer.data.documents) : null);
  }));
  return (
    <>
      <p className="p1-lead">承認・確認の記録（新しい順、最大20件）。金額は表示しません。</p>
      {shown.length === 0 ? (
        <p className="p1-muted">{unread.length > 0 ? '履歴を読み込めませんでした。' : 'まだ承認・確認の記録はありません。'}</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="監査履歴" tabIndex={0}>
          <table className="p1-history p2-audit-history" role="table">
            <caption className="visually-hidden">監査履歴</caption>
            <thead role="rowgroup">
              <tr role="row">{AUDIT_COLUMNS.map((name) => <th key={name} scope="col" role="columnheader">{name}</th>)}</tr>
            </thead>
            <tbody role="rowgroup">
              {shown.map(({ event, project }) => {
                const targets = eventTargets(event);
                const cell = evidenceCell(event, evidence.get(project.id) ?? null);
                const evidenceDocumentId = cell.kind === 'found' ? cell.evidence.documentId : null;
                return (
                  <tr key={event.id} role="row">
                    <td role="cell" data-label="誰が">
                      {event.actor?.displayName ?? '—'}
                      {event.actor?.role ? <span className="p2-audit-sub p1-muted-inline">（{roleLabel(event.actor.role)}）</span> : null}
                    </td>
                    <td role="cell" data-label="いつ" className="p1-figure">{formatTimestamp(event.occurredAt)}</td>
                    <td role="cell" data-label="何を">
                      <span>{ACTION_LABELS[event.action] ?? '記録'}</span>
                      <span className="p2-audit-sub p1-muted-inline">
                        <Link href={projectPath(project.code)} translate="no">{project.code}</Link>
                        {targets.orderCode ? <> ・ <span translate="no">{targets.orderCode}</span></> : null}
                        {targets.displayNumber ? <> ・ <span translate="no" className="p1-figure">{targets.displayNumber}</span></> : null}
                      </span>
                    </td>
                    <td role="cell" data-label="根拠">
                      <EvidenceCellView cell={cell} />
                      {evidenceDocumentId ? (
                        <span className="p2-audit-sub">
                          <Link href={`${projectPath(project.code, 'evidence')}#doc-${encodeURIComponent(evidenceDocumentId)}`}>証跡の一覧で見る</Link>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {unread.length > 0 ? <p className="p1-muted">読み込めなかった案件: {unread.join('、')}</p> : null}
      {projects.length > read.length ? <p className="p1-muted">案件が多いため、ほかの{projects.length - read.length}件は各案件の画面で確認してください。</p> : null}
    </>
  );
}
