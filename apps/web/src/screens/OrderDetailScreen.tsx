import Link from 'next/link';
import { OrderTimeline } from '../components/OrderTimeline';
import { StepPanelView } from '../components/StepPanel';
import { StepAnnouncer } from '../components/StepAnnouncer';
import { StatusBadge } from '../components/StatusBadge';
import { callApi, loadSessionUser } from '../lib/api';
import { loadMakerPoBoard, loadMakerPoDetail, sendManualVerificationsFromAuditEvents, undisclosedSendDecisionEventIds, MAKER_PO_AUDIT_WINDOW } from '../lib/maker-po-data';
import type { MakerPoEventRow } from '../lib/maker-po-data';
import { buildOrderFlow, liveMakerPo, nextStepText, ORDER_STEPS, STEP_COUNT } from '../lib/order-flow';
import { knownStatus, labelLookup, loadApprovalGate } from '../lib/project-data';
import type { ApprovalGateView, AuditEventView } from '../lib/project-data';
import { orderPath, projectPath } from '../lib/project-route';
import { paymentTermsText } from '../lib/decision-facts';
import { formatTimestamp } from '../lib/vocabulary';
import { formatQuantityWithUnit } from '../lib/number-format';
import { orderRecordText } from '../lib/order-records';
import type { ProjectScreenProps } from './screen-props';

/** States in which the approval gate (designs, 押印 slots, pending checks) is read. */
const GATE_STATES = new Set(['ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY']);

/**
 * P1 R21: /p/{案件}/o/{発注コード} — one film order on one screen. Left: the
 * 12 steps (the timeline, an <ol>). Right: the current step and the ONE thing
 * to do now, with its reason and fix right there when it is blocked (§3-3).
 * Below: the order's records, newest first. No form sits in a table and no
 * operation hides in a <details>; the lists (/p/{案件}/orders …) remain for the
 * rest. Every write still goes through the API, which decides it.
 */
export async function OrderDetailScreen({
  projectId,
  projectCode,
  orderCode,
  started
}: ProjectScreenProps & { orderCode: string; started: boolean }) {
  const [user, board, makerAudit, activity] = await Promise.all([
    loadSessionUser(),
    loadMakerPoBoard(projectId),
    callApi<{ events: AuditEventView[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/audit-history?entityType=maker_po_event&limit=${MAKER_PO_AUDIT_WINDOW}`
    ),
    callApi<{ events: AuditEventView[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/audit-history?limit=500&order=desc&excludeAction=DOCUMENT_VERSION_VIEWED,DOCUMENT_VERSION_DOWNLOADED`
    )
  ]);
  if (!user) return null;
  const workspace = board.workspace;
  const order = workspace.filmOrders.find((candidate) => candidate.code === orderCode);
  if (!order) {
    return (
      <section className="p1-notfound" aria-labelledby="order-notfound-title">
        <h1 id="order-notfound-title" className="p1-title">この発注は見つかりません</h1>
        <p className="p1-lead">
          {workspace.error
            ? `発注を読み込めませんでした（${workspace.error}）。少し待ってから再読み込みしてください。`
            : <>発注コード「<span translate="no">{orderCode}</span>」は、この案件にありません。</>}
        </p>
        {workspace.filmOrders.length > 0 ? (
          <ul className="p1-link-list" aria-label="この案件のフィルム発注">
            {workspace.filmOrders.map((candidate) => (
              <li key={candidate.id}><a href={orderPath(projectCode, candidate.code)} translate="no">{candidate.code}</a></li>
            ))}
          </ul>
        ) : null}
        <p><Link href={projectPath(projectCode)}>案件 {projectCode} を開く</Link></p>
      </section>
    );
  }

  const status = knownStatus(order);
  const entry = board.boards.find((candidate) => candidate.order.id === order.id) ?? null;
  const makerPos = entry?.makerPurchaseOrders ?? [];
  const maker = liveMakerPo(makerPos);
  const [gate, makerDetail] = await Promise.all([
    status && GATE_STATES.has(status) ? loadApprovalGate(order.id) : Promise.resolve<ApprovalGateView | null>(null),
    maker ? loadMakerPoDetail(maker.id) : Promise.resolve({ purchaseOrder: null, events: [] as MakerPoEventRow[], error: null })
  ]);
  const auditRows = makerAudit.ok && makerAudit.data && Array.isArray(makerAudit.data.events) ? makerAudit.data.events : [];
  const settled = new Set<string>([
    ...sendManualVerificationsFromAuditEvents(auditRows).map((verification) => verification.makerPoEventId),
    ...undisclosedSendDecisionEventIds(auditRows)
  ]);
  const po = order.sevenPurchaseOrderId
    ? workspace.sevenPurchaseOrders.find((candidate) => candidate.id === order.sevenPurchaseOrderId) ?? null
    : null;
  const flow = buildOrderFlow({
    order,
    role: user.role,
    po,
    documents: workspace.documents,
    revisions: workspace.revisions,
    gate,
    makerPos,
    makerEvents: makerDetail.events,
    settledSendEventIds: settled,
    paymentGate: entry?.paymentGate ?? null,
    deliveries: workspace.deliveries
  });
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const currentStep = flow.current ? ORDER_STEPS[flow.current - 1] : null;
  const records = (activity.ok && activity.data && Array.isArray(activity.data.events) ? activity.data.events : [])
    .filter((event) => event.entityId === order.id || event.afterState?.filmSupplyOrderId === order.id
      || (maker && (event.entityId === maker.id || event.afterState?.makerPurchaseOrderId === maker.id)))
    .slice(0, 12);
  // P1 R34: what changes when something is recorded here (the step, its slots, the maker paper).
  const progressKey = JSON.stringify([status, flow.current, flow.panel.action, maker?.status ?? null, records[0]?.id ?? null]);
  const lineSummary = order.lines.map((line) => formatQuantityWithUnit(line.orderedQuantity, line.unit)).join('・');

  return (
    <article className="p1-order" aria-labelledby="order-title">
      <nav className="p1-crumbs" aria-label="現在の位置">
        <ol>
          <li><Link href={projectPath(projectCode)} translate="no">{projectCode}</Link></li>
          <li aria-current="page" translate="no">{order.code}</li>
        </ol>
      </nav>
      <header className="p1-order-head">
        <div className="p1-order-title-row">
          <h1 id="order-title" className="p1-title" translate="no">{order.code}</h1>
          {status ? <StatusBadge domain="filmOrder" status={status} label={stateLabel(status)} /> : null}
        </div>
        <p className="p1-order-meta">
          <span>{lineSummary || '明細なし'}</span>
          <span>案件 <span translate="no">{projectCode}</span></span>
          {po ? <span>セブン化学発注書 <span translate="no">{po.poNumberHidden ? '（閲覧権限なし）' : po.poNumber}</span></span> : null}
          <span>支払条件 {paymentTermsText(order)}</span>
        </p>
        <p className="p1-order-links">
          <Link href={projectPath(projectCode, 'orders') + `#order-${order.id}`}>発注一覧で見る</Link>
          <Link href={projectPath(projectCode, 'maker-po') + `#maker-order-${order.id}`}>メーカー発注の一覧</Link>
        </p>
      </header>

      {started ? (
        <p className="p1-banner p1-banner--ok" role="status">✓ 発注を作成しました。続けて、下の「現在の手順」を進めます。</p>
      ) : null}
      {flow.phase === 'exception' && status ? (
        <p className="p1-banner p1-banner--exception">
          {stateLabel(status)}
          {order.hold && status === 'ON_HOLD' ? ` — ${order.hold.reasonHidden ? '理由は代表のみ表示' : `理由: ${order.hold.reason ?? '（記録なし）'}`}` : ''}
          {status === 'CHANGE_REVIEW' ? ' — 再開: 担当者・代表' : ' — 解除: 代表'}
        </p>
      ) : null}

      <div className="p1-order-grid">
        <section className="p1-timeline-wrap" aria-labelledby="timeline-title">
          <h2 id="timeline-title" className="p1-section-title">進み具合</h2>
          <OrderTimeline marks={flow.marks} current={flow.current} />
        </section>

        <section className="p1-panel p1-step" aria-labelledby="step-title">
          <h2 id="step-title" className="p1-section-title">
            {currentStep
              ? <>現在の手順 {currentStep.no}/{STEP_COUNT}　{currentStep.title}</>
              : flow.phase === 'complete' ? '完了' : flow.phase === 'cancelled' ? '取消で終了' : '現在の手順'}
          </h2>
          <StepAnnouncer
            progressKey={progressKey}
            latest={records[0] ? orderRecordText(records[0], stateLabel) : null}
            now={currentStep ? `${currentStep.no} ${currentStep.title}` : null}
          >
          <StepPanelView
            key={progressKey}
            flow={flow}
            order={order}
            projectCode={projectCode}
            role={user.role}
            po={po}
            gate={gate}
            maker={maker}
            makerEvents={makerDetail.events}
            documents={workspace.documents}
            stateLabel={stateLabel}
          />
          </StepAnnouncer>
          {nextStepText(flow) ? <p className="p1-next">{nextStepText(flow)}</p> : null}
        </section>
      </div>

      <section className="p1-records" aria-labelledby="records-title">
        <h2 id="records-title" className="p1-section-title">記録（新しい順）</h2>
        {records.length === 0 ? (
          <p className="p1-muted">{activity.ok ? 'この発注の記録はまだありません。' : '記録を読み込めませんでした。'}</p>
        ) : (
          <ol className="p1-record-list">
            {records.map((event) => (
              <li key={event.id}>
                <span className="p1-record-at">{formatTimestamp(event.occurredAt)}</span>
                <span className="p1-record-who">{event.actor?.displayName ?? '—'}</span>
                <span className="p1-record-what">{orderRecordText(event, stateLabel)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
