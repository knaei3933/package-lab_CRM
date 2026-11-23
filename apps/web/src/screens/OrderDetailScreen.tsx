import Link from 'next/link';
import { Bilingual } from '../components/Bilingual';
import { orderLookupFailure, ORDER_FORBIDDEN_BODY, ORDER_FORBIDDEN_TITLE } from '../lib/order-lookup';
import { OrderTimeline } from '../components/OrderTimeline';
import { StepPanelView } from '../components/StepPanel';
import { StepAnnouncer } from '../components/StepAnnouncer';
import { KoGloss } from '../components/RenderedContext';
import { standardTerm } from '../lib/terms';
import { ClearDrafts } from '../components/ClearDrafts';
import { StatusBadge } from '../components/StatusBadge';
import { callApi, loadSessionUser } from '../lib/api';
import { liveMakerPapers, loadMakerPaperCleanup, loadMakerPoBoard, loadMakerPoDetail, makerPoName, makerPoNumberOf, sendManualVerificationsFromAuditEvents, undisclosedSendDecisionEventIds, MAKER_PO_AUDIT_WINDOW } from '../lib/maker-po-data';
import type { MakerPoEventRow } from '../lib/maker-po-data';
import { buildOrderFlow, currentPaymentTerms, liveMakerPo, nextStepText, ORDER_STEPS, STEP_COUNT } from '../lib/order-flow';
import { loadApprovalCard } from '../lib/approval-card';
import { normalizeRole } from '../lib/permissions';
import { knownStatus, labelLookup, loadApprovalGate } from '../lib/project-data';
import type { ApprovalGateView, AuditEventView } from '../lib/project-data';
import { newOrderPath, orderPath, projectPath } from '../lib/project-route';
import { paymentTermsText } from '../lib/decision-facts';
import { formatTimestamp } from '../lib/vocabulary';
import { formatQuantityWithUnit } from '../lib/number-format';
import { orderRecordText } from '../lib/order-records';
import type { ProjectScreenProps } from './screen-props';
import { deliveryTermsSummary, OrderTermsSection } from '../components/OrderTermsSection';
import { readApprovalNotice } from '../lib/approval-notice-server';
import { loadDeliveryStatus } from '../lib/receipt-closure';
import { deliveryTermsLock, loadOrderFacts } from '../lib/order-terms';
import { loadMakerRecipients, previousTypedRecipientOf } from '../lib/maker-master';
import { SecondaryMenu } from '../components/SecondaryMenu';
import type { SecondaryMenuItem } from '../components/SecondaryMenu';
import { ExceptionEntryForm, exceptionEntriesFor } from '../components/OrderExceptionForms';
import { loadOrderMakerPaperWork, OrderMakerPaperWork } from './MakerPoScreen';
import { OrderDocumentChecks, orderDocumentsToCheck } from '../components/OrderDocumentChecks';
import { canRoleOperate } from '../lib/permissions';
import { DesignChangeForms } from '../components/DesignChangeForms';
import { approvalHistoryKeys, changeEvidenceChoices, printingStartedOrderIds } from '../lib/change-request';
import { designsOf } from '../lib/order-flow';

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
  if (!order && !workspace.error && orderLookupFailure(workspace.filmOrders, user.role) === 'forbidden') {
    // P4 H10①: not 「見つかりません」 — the role may not open this screen.
    return (
      <section className="p1-notfound" aria-labelledby="order-forbidden-title">
        <h1 id="order-forbidden-title" className="p1-title"><Bilingual ja={ORDER_FORBIDDEN_TITLE} ko="열람 권한으로는 발주 화면을 열 수 없습니다" /></h1>
        <p className="p1-lead"><Bilingual ja={ORDER_FORBIDDEN_BODY} ko="발주 화면은 담당자와 대표만 열 수 있습니다. 이력은 「履歴」 화면에서 볼 수 있습니다." /></p>
        <p><Link href="/home">履歴を開く</Link></p>
      </section>
    );
  }
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
  const [gate, makerDetail, orderFacts] = await Promise.all([
    status && GATE_STATES.has(status) ? loadApprovalGate(order.id) : Promise.resolve<ApprovalGateView | null>(null),
    maker ? loadMakerPoDetail(maker.id) : Promise.resolve({ purchaseOrder: null, events: [] as MakerPoEventRow[], error: null }),
    // P2 R30 / P-8: the セブン化学発注書 quantity (and, for admin, amount) of 「発注の条件」.
    loadOrderFacts(order.sevenPurchaseOrderId, user.role)
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
  // R24: the representative's approval card (the server card when the API has it).
  const approvalCard = flow.panel.action.kind === 'ceo_approve' && maker && normalizeRole(user.role) === 'admin'
    ? await loadApprovalCard({
        paper: maker,
        orderId: order.id,
        orderCode: order.code,
        paymentTerms: currentPaymentTerms({ order, paymentGate: entry?.paymentGate ?? null }),
        sevenPo: po
      })
    : null;
  // p4/web3 (b) / web2b review L-1: why the last approval from this card stopped (kept across the redraw).
  if (approvalCard) approvalCard.notice = await readApprovalNotice(approvalCard.poId);
  // P2 R33: the project maker's recipient addresses, only when this role creates the maker paper now.
  const recipients = flow.panel.action.kind === 'maker_po_create' && flow.panel.canAct ? await loadMakerRecipients(projectId) : undefined;
  // P4 M6: the representative's maker paper work (取り消し・取り消し承認) — judged like the old list.
  const makerWork = entry ? await loadOrderMakerPaperWork(projectId, entry, user.role, workspace.documents) : null;
  // P4 H14: step 12 reads the deliveries of this order, the readiness and who uploaded what.
  const orderDeliveries = workspace.deliveries.filter((delivery) => delivery.kind === 'film' && delivery.orderId === order.id);
  // p4/web3 (e) + p4/web4: delivery-status says what the completion rests on and what each confirmation rests on —
  // one read for both, only where step 12 draws the deliveries' confirmations (納品済み and the closed order).
  const completionStage = status === 'FILM_DELIVERED' || status === 'FILM_RECEIPT_ASSUMED_NO_ISSUE';
  const deliveryStatus = completionStage ? await loadDeliveryStatus(order.id) : null;
  const deliveryContext = {
    deliveries: orderDeliveries,
    userId: user.id ?? null,
    filmOnly: workspace.fillingOrders.length === 0,
    readiness: workspace.readiness ?? null,
    readinessLabel: labelLookup(workspace.labels, 'commissionReadinessStates'),
    // p4/web3 (e): what the completion rests on (server-decided), read only around the completion.
    closure: deliveryStatus?.closure ?? null,
    evidenceKinds: deliveryStatus?.evidenceKinds ?? {}
  };
  // P4 §0: the cancellation review warns about the maker paper left on the order (the board's workspace skips that read).
  const makerCleanup = status === 'CANCELLATION_REVIEW' || status === 'ON_HOLD' || status === 'CHANGE_REVIEW' || status === 'CANCELLED'
    ? (await loadMakerPaperCleanup(projectId, [order.id]))[order.id]
    : undefined;
  const documentsToCheck = orderDocumentsToCheck(workspace.documents, order, po);
  const designKeys = designsOf(workspace.revisions, order.id);
  const menu: SecondaryMenuItem[] = [
    ...(canRoleOperate(user.role, 'film_order:transition') && flow.phase === 'active'
      ? exceptionEntriesFor(status, stateLabel).map((entryKey): SecondaryMenuItem => ({
          key: `to-${entryKey}`,
          label: entryKey === 'ON_HOLD' ? '保留にする' : entryKey === 'CHANGE_REVIEW' ? '変更確認にする' : '取消確認にする',
          ko: entryKey === 'ON_HOLD' ? '보류' : entryKey === 'CHANGE_REVIEW' ? '변경 확인' : '취소 확인',
          who: entryKey === 'ON_HOLD' ? '解除は代表' : entryKey === 'CANCELLATION_REVIEW' ? '処理は代表' : '担当者・代表',
          content: <ExceptionEntryForm order={order} entry={entryKey} stateLabel={stateLabel} projectCode={projectCode} />
        }))
      : []),
    ...(makerWork
      ? [{ key: 'maker-paper', label: 'メーカー発注書の取り消し・取り消し承認', ko: '제조사 발주서 취소·취소 승인', who: '代表のみ', content: <OrderMakerPaperWork work={makerWork} /> }]
      : []),
    ...(designKeys.length > 0 && status !== null && !['DRAFT', 'CANCELLED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE'].includes(status) && canRoleOperate(user.role, 'artwork_revision:create')
      ? [{
          key: 'design-change',
          label: 'デザインを差し替える（変更依頼）',
          ko: '디자인 교체(변경 의뢰)',
          content: (
            <DesignChangeForms
              order={order}
              projectCode={projectCode}
              po={po}
              role={user.role}
              designKeys={designKeys}
              documents={workspace.documents}
              historyKeys={approvalHistoryKeys(workspace.revisions, workspace.approvalEvents, [gate])}
              printedOrderIds={printingStartedOrderIds([order])}
              evidenceChoices={changeEvidenceChoices(workspace.documents).filter((choice) => choice.orderId === order.id)}
              livePapers={liveMakerPapers(makerPos).map((paper) => makerPoName(paper, order.code))}
            />
          )
        }]
      : []),
    ...(documentsToCheck.length > 0 && canRoleOperate(user.role, 'document:verify')
      ? [{ key: 'documents', label: `書類の確認（${documentsToCheck.length}件）`, ko: '서류 확인', content: <OrderDocumentChecks documents={documentsToCheck} role={user.role} userId={user.id ?? null} orderCode={order.code} /> }]
      : [])
  ];
  const currentStep = flow.current ? ORDER_STEPS[flow.current - 1] : null;
  const records = (activity.ok && activity.data && Array.isArray(activity.data.events) ? activity.data.events : [])
    .filter((event) => event.entityId === order.id || event.afterState?.filmSupplyOrderId === order.id
      || (maker && (event.entityId === maker.id || event.afterState?.makerPurchaseOrderId === maker.id)))
    .slice(0, 12);
  // P1 R34: what changes when something is recorded here (the step, its slots, the maker paper).
  const progressKey = JSON.stringify([status, flow.current, flow.panel.action, maker?.status ?? null, records[0]?.id ?? null]);
  const termsLock = deliveryTermsLock(makerPos);
  const makerNumber = maker ? makerPoNumberOf(maker.displayNumber) : null;
  const termsStep = flow.panel.action.kind === 'maker_po_create' || flow.panel.action.kind === 'ceo_approve';
  const lineSummary = order.lines.map((line) => formatQuantityWithUnit(line.orderedQuantity, line.unit)).join('・');

  return (
    <article className="p1-order" aria-labelledby="order-title">
      <nav className="p1-crumbs" aria-label="現在の位置">
        <ol>
          <li><Link className="p4w3-target" href={projectPath(projectCode)} translate="no">{projectCode}</Link></li>
          <li aria-current="page" translate="no">{order.code}</li>
        </ol>
      </nav>
      <header className="p1-order-head">
        <div className="p1-order-title-row">
          <h1 id="order-title" className="p1-title" translate="no">{order.code}</h1>
          {status ? <StatusBadge domain="filmOrder" status={status} label={stateLabel(status)} /> : null}
          {status ? <KoGloss ko={standardTerm('filmSupplyOrderStates', status)?.ko} /> : null}
        </div>
        <p className="p1-order-meta">
          <span>{lineSummary || '明細なし'}</span>
          <span>案件 <span translate="no">{projectCode}</span></span>
          {po ? <span>セブン化学発注書 <span translate="no">{po.poNumberHidden ? '（閲覧権限なし）' : po.poNumber}</span></span> : null}
          {maker
            ? makerNumber
              ? <span>メーカー発注書 <span translate="no" className="p1-figure">{makerNumber}</span></span>
              : <span>{makerPoName(maker, order.code)}</span>
            : null}
          <span>支払条件 {paymentTermsText(order)}</span>
        </p>
        <p className="p1-order-links">
          {/* web2a review L-3: the header links are 44px targets too (they were 19–24px). */}
          <Link className="p4w3-target" href={projectPath(projectCode, 'orders') + `#order-${order.id}`}>発注の一覧（閲覧）</Link>
          <Link className="p4w3-target" href={projectPath(projectCode, 'maker-po') + `#maker-order-${order.id}`}>メーカー発注の一覧（閲覧）</Link>
          <a className="p4w3-target" href="#order-terms">発注の条件</a>
        </p>
      </header>

      {started ? (
        <>
          <p className="p1-banner p1-banner--ok" role="status">✓ 発注を作成しました。続けて、下の「現在の手順」を進めます。</p>
          {/* R34: the wizard moved here on success, so its draft is dropped here. */}
          <ClearDrafts pathname={newOrderPath(projectCode)} />
        </>
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
            approvalCard={approvalCard}
            recipients={recipients}
            previousTypedRecipient={recipients ? previousTypedRecipientOf(board.boards.flatMap((candidate) => candidate.makerPurchaseOrders), recipients) : null}
            deliveryContext={deliveryContext}
            makerCleanup={makerCleanup}
          />
          </StepAnnouncer>
          {nextStepText(flow) ? <p className="p1-next">{nextStepText(flow)}</p> : null}
          {/* P2 DESIGN §1: before the paper is made / approved, the terms it will fix are in sight. */}
          {termsStep ? (
            <p className="p1-note">
              {deliveryTermsSummary(order, orderFacts)}（<a href="#order-terms">発注の条件を見る</a>）
            </p>
          ) : null}
        </section>
      </div>

      {/* P4 M6: the exceptions and checks beside the one primary action (they used to be in the old list tables). */}
      <SecondaryMenu id="order-more" title="その他の操作（止める・変更する・取り消す）" items={menu} />

      <OrderTermsSection
        order={order}
        role={user.role}
        facts={orderFacts}
        lock={termsLock}
        projectCode={projectCode}
        cancelled={status === 'CANCELLED'}
      />

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
