import { orderPath } from '../lib/project-route';
import { ProjectProgress } from '../components/ProjectProgress';
import { ProjectUnavailable } from '../components/ProjectUnavailable';
import type { ProjectScreenProps } from './screen-props';
import { ViewerPageNotice } from '../components/RoleGate';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { TechDetails } from '../components/TechDetails';
import { loadSessionUser } from '../lib/api';
import { callApi } from '../lib/api';
import { canRoleOperate } from '../lib/permissions';
import {
  labelLookup,
  loadApprovalGate,
  loadWorkspace,
  knownStatus,
  revisionNumberText
} from '../lib/project-data';
import { shortId } from '../lib/short-id';
import type { ApprovalGateView, FilmSupplyOrderView, DesignApprovalGateView } from '../lib/project-data';
import {
  APPROVAL_DECISION_LABELS,
  EVIDENCE_SOURCE_LABELS,
  formatTimestamp,
  VERIFICATION_STATUS_LABELS
} from '../lib/vocabulary';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from '../lib/redaction';
import { PendingVerificationSection } from '../components/EvidenceVerificationSection';
import { liveMakerPapers, withDisplayNumbers } from '../lib/maker-po-data';
import type { MakerPoViewRow } from '../lib/maker-po-data';


/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */

/**
 * Criterion 5: 承認（アートワークの両組織の承認）. The pending designs of every
 * order that has revisions are read from the API's derived approval gate
 * (GET /api/film-supply-orders/:orderId/approval-gate), and each one offers the
 * two approval buttons. Both buttons submit the same evidence version select,
 * so whichever organization goes second cites the same evidence document
 * version; the screen re-renders after each click and shows the moved state.
 *
 * M8-OPER2 FIX 2: an approval recorded on binary evidence (PDF/image) is
 * flagged 手動確認待ち — it never completes the dual approval on its own. The
 * representative sees the pending verifications of every order here with the
 * original evidence and the proof it is checked against, and records a NEW
 * append-only verification (確認／却下); the API refuses every other role.
 */
export async function ApprovalsScreen({ projectId, projectCode }: ProjectScreenProps) {

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (workspace.projectRefused) return <ProjectUnavailable title="承認（顧客とセブン化学の承認）" reason={workspace.error} returnTo="/approvals" />;
  const role = user?.role ?? null;
  // UI batch B (④): the representative-only manual verification, through the shared helper.
  const canVerifyEvidence = canRoleOperate(role, 'artwork_approval:verify_evidence');
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const organizationLabel = labelLookup(workspace.labels, 'approvalOrganizations');

  const orderIds = [...new Set(workspace.revisions.map((revision) => revision.filmSupplyOrderId))];
  const gates = await Promise.all(orderIds.map((orderId) => loadApprovalGate(orderId)));
  const gateByOrderId = new Map<string, ApprovalGateView>();
  for (const gate of gates) {
    if (gate) gateByOrderId.set(gate.orderId, gate);
  }

  const orderCode = (orderId: string) =>
    workspace.filmOrders.find((order) => order.id === orderId)?.code ?? `発注 ${shortId(orderId)}`;

  /** 원본 증빙: the stored document a pending verification points at. */
  const evidenceLabel = (versionId: string | null): string => {
    if (!versionId) return '（証跡バージョン未記録）';
    for (const document of workspace.documents) {
      const version = document.versions.find((candidate) => candidate.id === versionId);
      if (version) {
        return `${document.filename}（版${version.versionNumber}／${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }）`;
      }
    }
    return `書類バージョン ${shortId(versionId)}`;
  };

  // P4 §0: this list only reads — no form here, so no evidence Message-ID is read
  // (the API records DOCUMENT_VERSION_VIEWED for each one) and no 版 choices are built.
  const orderPathOf = (orderId: string, step: number | null = 6): string | null => {
    const code = workspace.filmOrders.find((order) => order.id === orderId)?.code;
    return code ? orderPath(projectCode, code, step) : null;
  };

  return (
    <section className="sx-11bfff5">
      <header>
        <h1 className="sx-15b888e">承認（顧客とセブン化学の承認）</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/approvals" projectCode={projectCode} />
        <ViewerPageNotice role={role} />
        <p className="ui-note">
          顧客とセブン化学の両組織の承認で校了になります。承認は必ず承認証跡の
          書類バージョンを引用して記録します。どちらの組織が先でも構いません。
        </p>
        {workspace.error ? <div className="ui-info">{workspace.error}</div> : null}
      </header>

      {orderIds.length === 0 ? (
        <div className="ui-card">
          <p className="ui-note">
            {workspace.revisionsWithheld > 0
              ? `校正ゲラの版は${workspace.revisionsWithheld}件記録されていますが、紐付け先の発注とデザインが${HIDDEN_BY_ROLE_SHORT}のため、ここには表示できません。`
              : '校了対象の版がまだありません。発注の画面の手順5で校正を登録すると、デザインごとの承認待ちが表示されます。'}
          </p>
        </div>
      ) : (
        orderIds.map((orderId) => {
          const gate = gateByOrderId.get(orderId);
          const orderRevisions = workspace.revisions.filter((revision) => revision.filmSupplyOrderId === orderId);
          return (
            <div className="ui-card" key={orderId}>
              <h2 className="sx-c5c15d8">
                {orderCode(orderId)}
                {gate ? <span className="ui-note"> ／ 状態: {stateLabel(gate.orderStatus)}</span> : null}
              </h2>
              <p className="ui-note">
                {gate?.dualApproved
                  ? 'この発注の必要なデザインはすべて両組織の承認済みです。'
                  : '未承認のデザインがあります。承認は発注の画面（手順6 校了）で記録します。'}
              </p>

              {gate ? (
                <DataTable caption={`${orderCode(orderId)} のデザインごとの承認状況`}>
                  <thead>
                    <tr>
                      <th className="ui-th" scope="col">デザインキー</th>
                      <th className="ui-th" scope="col">現在の版</th>
                      <th className="ui-th" scope="col">顧客の承認</th>
                      <th className="ui-th" scope="col">セブン化学の承認</th>
                      <th className="ui-th" scope="col">両組織の承認</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gate.designs.map((design) => (
                      <tr key={design.designKey}>
                        <td className="ui-td">{design.designKey}</td>
                        <td className="ui-td">版{design.currentRevisionNo}</td>
                        <td className="ui-td">{organizationStateText(design.customer)}</td>
                        <td className="ui-td">{organizationStateText(design.seven)}</td>
                        <td className="status-cell ui-td">
                          {design.dualApproved
                            ? <StatusBadge tone="done" label="済み（校了）" />
                            : <StatusBadge tone="waiting" label="未達" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              ) : (
                <div className="ui-info">
                  この発注の承認の状況を取得できませんでした。
                </div>
              )}

              <details className="sx-36ca0af">
                <summary className="sx-c981838">登録済みの版（{orderRevisions.length}件）</summary>
                <ul className="sx-c083946">
                  {orderRevisions.map((revision) => (
                    <li key={revision.id}>
                      デザイン {revision.designKey} ／ {revisionNumberText(revision)} ／ 登録 {formatTimestamp(revision.createdAt)}
                      {revision.invalidatedApprovals ? <span className="ui-note">（既存の承認を無効化）</span> : null}
                      <TechDetails context="版ID">{revision.id}</TechDetails>
                    </li>
                  ))}
                </ul>
              </details>

              {gate && gate.pendingManualVerifications.length > 0 ? (
                <PendingVerificationSection
                  pending={gate.pendingManualVerifications}
                  role={role}
                  canVerify={canVerifyEvidence}
                  evidenceLabel={evidenceLabel}
                  organizationText={organizationLabel}
                  readOnly
                  recordHref={role === 'auditor' ? null : orderPathOf(orderId)}
                />
              ) : null}

              {/* P4 §0: approvals are recorded at step 6 of the order screen (one 押印 slot per organization). */}
              {gate && !gate.dualApproved && canRoleOperate(role, 'artwork_approval:record') && orderPathOf(orderId) ? (
                <p>
                  <a className="p4w2-row-link" href={orderPathOf(orderId)!}>
                    発注の画面で承認を記録する（手順6 校了）<span className="visually-hidden">（{orderCode(orderId)}）</span>
                  </a>
                </p>
              ) : null}
            </div>
          );
        })
      )}

      <div className="ui-card">
        <h2 className="sx-c5c15d8">校正ゲラの版の登録</h2>
        <p className="ui-note">
          校正ゲラは発注の画面の手順5「校正」で登録します。2つ目のデザインは手順6の「別のデザインを追加する」、
          承認済みデザインの差し替え（変更依頼）は発注の画面の「その他の操作」で行います。この一覧は閲覧用です。
        </p>
      </div>

      <div className="ui-card">
        <h2 className="sx-c5c15d8">承認の記録履歴</h2>
        {workspace.approvalEvents.length === 0 ? (
          <p className="ui-note">記録された承認はまだありません。</p>
        ) : (
          <DataTable caption="承認の記録履歴" captionHidden>
            <thead>
              <tr>
                <th className="ui-th" scope="col">デザイン</th>
                <th className="ui-th" scope="col">版</th>
                <th className="ui-th" scope="col">組織</th>
                <th className="ui-th" scope="col">決定</th>
                <th className="ui-th" scope="col">入手経路</th>
                <th className="ui-th" scope="col">引用した証跡バージョン</th>
                <th className="ui-th" scope="col">承認日時</th>
                <th className="ui-th" scope="col">記録</th>
              </tr>
            </thead>
            <tbody>
              {workspace.approvalEvents.map((event) => (
                <tr key={event.id} data-record-id={event.id}>
                  {event.detailsHidden ? (
                    // UI batch A follow-up (P1-4): the role may not read the
                    // decision details; say so instead of 「—」 or 版0.
                    <>
                      <td className="ui-td">{HIDDEN_BY_ROLE_LABEL}</td>
                      <td className="ui-td">{HIDDEN_BY_ROLE_LABEL}</td>
                      <td className="ui-td">{HIDDEN_BY_ROLE_LABEL}</td>
                      <td className="ui-td">{HIDDEN_BY_ROLE_LABEL}</td>
                      <td className="ui-td">{HIDDEN_BY_ROLE_LABEL}</td>
                      <td className="ui-td">{HIDDEN_BY_ROLE_LABEL}</td>
                      <td className="ui-td">{HIDDEN_BY_ROLE_LABEL}</td>
                    </>
                  ) : (
                    <>
                      <td className="ui-td">{event.designKey}</td>
                      <td className="ui-td">{event.revisionNo === null ? '版未記録' : `版${event.revisionNo}`}</td>
                      <td className="ui-td">{organizationLabel(event.organization)}</td>
                      <td className="ui-td">{APPROVAL_DECISION_LABELS[event.decision] ?? event.decision}</td>
                      <td className="ui-td">
                        {EVIDENCE_SOURCE_LABELS[event.evidenceSource as keyof typeof EVIDENCE_SOURCE_LABELS]
                          ?? event.evidenceSource}
                      </td>
                      <td className="ui-td">
                        {evidenceLabel(event.evidenceDocumentVersionId === '—' ? null : event.evidenceDocumentVersionId)}
                        <TechDetails context="ID">{event.evidenceDocumentVersionId}</TechDetails>
                      </td>
                      <td className="ui-td">{event.eventTime ? formatTimestamp(event.eventTime) : '未記録'}</td>
                    </>
                  )}
                  <td className="ui-td">{formatTimestamp(event.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </section>
  );
}

function organizationStateText(state: DesignApprovalGateView['customer']): string {
  if (state.valid && state.manualVerification?.result === 'confirmed') return '承認済み（手動確認済み）';
  if (state.valid) return '承認済み';
  // M8-OPER2 FIX 2: the approval is recorded but its identifier is unverified,
  // so it never completes the dual approval while this is true.
  if (state.pendingEvidenceIdentifier) {
    return state.manualVerification?.result === 'rejected'
      ? '手動確認で却下（両組織の承認に算入されません）'
      : '手動確認待ち（証跡識別子未確認）';
  }
  if (state.revoked) return '取消済み';
  if (state.invalidatedByNewerRevision) return '新しい版で無効化';
  if (state.latestDecision === 'REVOKE') return '取消済み';
  return '未承認';
}

/**
 * Recheck 8 Low-5: the orders the revision form offers. The API refuses a
 * draft order (422 ORDER_NOT_PAST_SEVEN_PO_VERIFIED), a cancelled order (409
 * FILM_ORDER_CANCELLED) and an order with live maker paper (409
 * MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED), so those are not choices; the
 * live-paper ones are named with their paper. An order whose paper list could
 * not be read stays a choice (the API decides), and is named as unread.
 */
export async function loadRevisionTargets(orders: ReadonlyArray<FilmSupplyOrderView>): Promise<{
  registrable: FilmSupplyOrderView[];
  blocked: Array<{ order: FilmSupplyOrderView; papers: MakerPoViewRow[] }>;
  unread: FilmSupplyOrderView[];
}> {
  const candidates = orders.filter((order) => {
    const status = knownStatus(order);
    return status !== 'DRAFT' && status !== 'CANCELLED';
  });
  const lists = await Promise.all(candidates.map((order) => callApi<{ makerPurchaseOrders: MakerPoViewRow[]; displayNumbers?: unknown }>(
    `/api/film-supply-orders/${encodeURIComponent(order.id)}/maker-purchase-orders`
  )));
  const out = { registrable: [] as FilmSupplyOrderView[], blocked: [] as Array<{ order: FilmSupplyOrderView; papers: MakerPoViewRow[] }>, unread: [] as FilmSupplyOrderView[] };
  candidates.forEach((order, index) => {
    const result = lists[index];
    // P4 L4: the stored 「MPO-…」 numbers of the list are merged, so the blocked notice names the paper by it.
    const rows = result?.ok && result.data && Array.isArray(result.data.makerPurchaseOrders)
      ? withDisplayNumbers(result.data.makerPurchaseOrders, result.data.displayNumbers)
      : null;
    if (rows === null) {
      out.unread.push(order);
      return;
    }
    const live = liveMakerPapers(rows);
    if (live.length > 0) out.blocked.push({ order, papers: live });
    else out.registrable.push(order);
  });
  return out;
}
