import type { Metadata } from 'next';
import { ActionForm } from '../../components/ActionForm';
import { ApprovalDecisionForm } from '../../components/ApprovalDecisionForm';
import { OffsetDateTimeField } from '../../components/OffsetDateTimeField';
import { ProjectProgress } from '../../components/ProjectProgress';
import { ProjectUnavailable } from '../../components/ProjectUnavailable';
import { RoleGate, ViewerPageNotice } from '../../components/RoleGate';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { TechDetails } from '../../components/TechDetails';
import { SelectField, TextField } from '../../components/fields';
import {
  recordArtworkApprovalAction,
  registerArtworkRevisionAction,
  verifyEvidenceManualAction
} from '../actions';
import { loadSessionUser, readSelectedProjectId } from '../../lib/api';
import { callApi } from '../../lib/api';
import { asiaTokyoDatetimeLocalNow } from '../../lib/datetime';
import { canRoleOperate, operationRefusal } from '../../lib/permissions';
import {
  filmOrderChoiceLabel,
  labelLookup,
  loadApprovalGate,
  loadWorkspace,
  NO_PROJECT_SELECTED_MESSAGE,
  knownStatus,
  revisionNumberText
} from '../../lib/project-data';
import { shortId } from '../../lib/short-id';
import type {
  ApprovalGateView,
  FilmSupplyOrderView,
  DesignApprovalGateView,
  PendingManualVerificationView
} from '../../lib/project-data';
import { cardStyle, infoBoxStyle, noteStyle, tdStyle, thStyle } from '../../lib/ui';
import {
  APPROVAL_DECISION_LABELS,
  EVIDENCE_SOURCE_LABELS,
  formatTimestamp,
  evidenceSourceChoices,
  VERIFICATION_STATUS_LABELS
} from '../../lib/vocabulary';
import type { Choice } from '../../lib/types';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from '../../lib/redaction';
import { ARTWORK_REVISION_LIVE_PAPER_REFUSAL, liveMakerPapers, MAKER_PO_STATUS_LABELS } from '../../lib/maker-po-data';
import type { MakerPoViewRow } from '../../lib/maker-po-data';

export const dynamic = 'force-dynamic';

/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */
export const metadata: Metadata = { title: '承認' };

/**
 * Criterion 5: 承認（アートワークのダブル承認）. The pending designs of every
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
export default async function ApprovalsPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>{NO_PROJECT_SELECTED_MESSAGE}</div>;
  }

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (workspace.projectRefused) return <ProjectUnavailable title="承認（校了のダブル承認）" reason={workspace.error} />;
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

  const evidenceAutoIdentifiers = new Map<string, string>();
  await Promise.all(workspace.documents
    .filter((document) => document.documentType === 'approval_evidence')
    .flatMap((document) => document.versions.map(async (version) => {
      const result = await callApi<{ evidenceIdentifier?: string }>(
        `/api/document-versions/${encodeURIComponent(version.id)}/evidence-message-id`
      );
      if (result.ok && result.data?.evidenceIdentifier) {
        evidenceAutoIdentifiers.set(version.id, result.data.evidenceIdentifier);
      }
    })));

  const approvalEvidenceChoices = (orderId: string, designKey: string): Choice[] =>
    workspace.documents
      .filter((document) => document.documentType === 'approval_evidence'
        && document.filmSupplyOrderId === orderId
        && document.designKey === designKey)
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        autoEvidenceIdentifier: evidenceAutoIdentifiers.get(version.id) ?? null,
        label: `${document.filename}（版${version.versionNumber}／確認状態 ${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${shortId(version.id)}）`
      })));

  const revisionTargets = canRoleOperate(role, 'artwork_revision:create')
    ? await loadRevisionTargets(workspace.filmOrders)
    : { registrable: [], blocked: [], unread: [] };

  const proofChoices: Choice[] = workspace.documents
    .filter((document) => document.documentType === 'proof')
    .flatMap((document) => document.versions.map((version) => ({
      value: version.id,
      label: `${document.filmSupplyOrderId ? orderCode(document.filmSupplyOrderId) : '発注未紐付け'}／${
        document.designKey ?? 'デザイン未指定'
      }／${document.filename}（版${version.versionNumber}／ID ${shortId(version.id)}）`
    })));

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>承認（校了のダブル承認）</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/approvals" />
        <ViewerPageNotice role={role} />
        <p style={noteStyle}>
          顧客とセブン化学の両組織の承認でダブル承認（校了）になります。承認は必ず承認証跡の
          書類バージョンを引用して記録します。どちらの組織が先でも構いません。
        </p>
        {workspace.error ? <div style={infoBoxStyle}>{workspace.error}</div> : null}
      </header>

      {orderIds.length === 0 ? (
        <div style={cardStyle}>
          <p style={noteStyle}>
            {workspace.revisionsWithheld > 0
              ? `校正ゲラの版は${workspace.revisionsWithheld}件記録されていますが、紐付け先の発注とデザインが${HIDDEN_BY_ROLE_SHORT}のため、ここには表示できません。`
              : '校了対象の版がまだありません。下の「校正ゲラの版を登録する」で版を登録すると、デザインごとの承認待ちが表示されます。'}
          </p>
        </div>
      ) : (
        orderIds.map((orderId) => {
          const gate = gateByOrderId.get(orderId);
          const orderRevisions = workspace.revisions.filter((revision) => revision.filmSupplyOrderId === orderId);
          return (
            <div key={orderId} style={cardStyle}>
              <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>
                {orderCode(orderId)}
                {gate ? <span style={noteStyle}> ／ 状態: {stateLabel(gate.orderStatus)}</span> : null}
              </h2>
              <p style={noteStyle}>
                {gate?.dualApproved
                  ? 'この発注の必要なデザインはすべてダブル承認済みです。'
                  : '未承認のデザインがあります。証跡を選んで承認を記録してください。'}
              </p>

              {gate ? (
                <DataTable caption={`${orderCode(orderId)} のデザインごとの承認状況`}>
                  <thead>
                    <tr>
                      <th scope="col" style={thStyle}>デザインキー</th>
                      <th scope="col" style={thStyle}>現在の版</th>
                      <th scope="col" style={thStyle}>顧客の承認</th>
                      <th scope="col" style={thStyle}>セブン化学の承認</th>
                      <th scope="col" style={thStyle}>ダブル承認</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gate.designs.map((design) => (
                      <tr key={design.designKey}>
                        <td style={tdStyle}>{design.designKey}</td>
                        <td style={tdStyle}>版{design.currentRevisionNo}</td>
                        <td style={tdStyle}>{organizationStateText(design.customer)}</td>
                        <td style={tdStyle}>{organizationStateText(design.seven)}</td>
                        <td style={tdStyle} className="status-cell">
                          {design.dualApproved
                            ? <StatusBadge tone="done" label="済み（校了）" />
                            : <StatusBadge tone="waiting" label="未達" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              ) : (
                <div style={infoBoxStyle}>
                  この発注の承認の状況を取得できませんでした。
                </div>
              )}

              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 13, cursor: 'pointer' }}>登録済みの版（{orderRevisions.length}件）</summary>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                  {orderRevisions.map((revision) => (
                    <li key={revision.id}>
                      デザイン {revision.designKey} ／ {revisionNumberText(revision)} ／ 登録 {formatTimestamp(revision.createdAt)}
                      {revision.invalidatedApprovals ? <span style={noteStyle}>（既存の承認を無効化）</span> : null}
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
                />
              ) : null}

              {gate
                ? gate.designs
                    .filter((design) => !design.dualApproved)
                    .map((design) => (
                      <div key={design.designKey} style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                        <h3 style={{ fontSize: 16, margin: '0 0 4px' }}>
                          承認を記録する：デザイン {design.designKey}（版{design.currentRevisionNo}）
                        </h3>
                        <RoleGate role={role} operation="artwork_approval:record" label="承認の記録">
                          <p style={noteStyle}>
                            必要な証跡：この発注とデザイン「{design.designKey}」に紐付けた承認証跡の書類バージョン。
                            顧客の承認には顧客の承認証跡（発行主体「顧客作成」）、セブン化学の承認にはセブン化学の承認証跡
                            （発行主体「セブン化学」）を、組織ごとに別の書類として登録して引用してください。
                            承認証跡識別子（承認メールのMessage-IDなど）も組織ごとに違う値になります。
                          </p>
                          <ApprovalDecisionForm
                            action={recordArtworkApprovalAction}
                            revisionId={design.currentRevisionId}
                            designKey={design.designKey}
                            evidenceChoices={approvalEvidenceChoices(orderId, design.designKey)}
                            evidenceSourceChoices={evidenceSourceChoices()}
                            defaultEventTime={nowInputValue()}
                          />
                        </RoleGate>
                      </div>
                    ))
                : null}
            </div>
          );
        })
      )}

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>校正ゲラの版を登録する</h2>
        <RoleGate role={role} operation="artwork_revision:create" label="版の登録">
          <p style={noteStyle}>
            発注が「{stateLabel('SEVEN_PO_VERIFIED')}」以降の状態で、取り消されていないメーカー発注書がないとき、
            校正ゲラの書類のバージョンを版として登録できます（取消で終了した発注には登録できません）。
            新しい版を登録すると、そのデザインの既存の承認は無効になり承認待ちに戻ります。
          </p>
          {revisionTargets.blocked.length > 0 ? (
            <div style={infoBoxStyle}>
              <strong>版を登録できない発注: </strong>
              {revisionTargets.blocked.map(({ order, papers }) => `${order.code}（メーカー発注書 ${papers
                .map((paper) => `${shortId(paper.id)}: ${MAKER_PO_STATUS_LABELS[paper.status] ?? paper.status}`)
                .join('、')}）`).join('／')}
              <p style={noteStyle}>{ARTWORK_REVISION_LIVE_PAPER_REFUSAL}</p>
            </div>
          ) : null}
          {revisionTargets.unread.length > 0 ? (
            <p style={noteStyle}>
              {`${revisionTargets.unread.map((order) => order.code).join('、')}: メーカー発注書の状態を確認できませんでした。`
                + '取り消されていないメーカー発注書がある場合、版は登録されません（理由が表示されます）。'}
            </p>
          ) : null}
          <ActionForm action={registerArtworkRevisionAction} submitLabel="版を登録する">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <SelectField
                name="orderId"
                label="フィルム発注"
                required
                width={300}
                choices={[...revisionTargets.registrable, ...revisionTargets.unread].map((order) => ({
                  value: order.id,
                  label: filmOrderChoiceLabel(order, stateLabel)
                }))}
              />
              <TextField name="designKey" label="デザインキー" required width={180} hint="例：T-35" />
              <SelectField
                name="fileDocumentVersionId"
                label="版ファイル（校正ゲラのバージョン）"
                required
                width={420}
                choices={proofChoices}
              />
              <TextField name="lotMarking" label="ロット表記（任意）" width={180} />
              <TextField name="note" label="備考（任意）" width={220} />
            </div>
          </ActionForm>
          {proofChoices.length === 0 ? (
            <p style={noteStyle}>校正ゲラの書類がまだありません。文書画面から校正ゲラをアップロードしてください。</p>
          ) : null}
        </RoleGate>
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>承認の記録履歴</h2>
        {workspace.approvalEvents.length === 0 ? (
          <p style={noteStyle}>記録された承認はまだありません。</p>
        ) : (
          <DataTable caption="承認の記録履歴" captionHidden>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>デザイン</th>
                <th scope="col" style={thStyle}>版</th>
                <th scope="col" style={thStyle}>組織</th>
                <th scope="col" style={thStyle}>決定</th>
                <th scope="col" style={thStyle}>入手経路</th>
                <th scope="col" style={thStyle}>引用した証跡バージョン</th>
                <th scope="col" style={thStyle}>承認日時</th>
                <th scope="col" style={thStyle}>記録</th>
              </tr>
            </thead>
            <tbody>
              {workspace.approvalEvents.map((event) => (
                <tr key={event.id}>
                  {event.detailsHidden ? (
                    // UI batch A follow-up (P1-4): the role may not read the
                    // decision details; say so instead of 「—」 or 版0.
                    <>
                      <td style={tdStyle}>{HIDDEN_BY_ROLE_LABEL}</td>
                      <td style={tdStyle}>{HIDDEN_BY_ROLE_LABEL}</td>
                      <td style={tdStyle}>{HIDDEN_BY_ROLE_LABEL}</td>
                      <td style={tdStyle}>{HIDDEN_BY_ROLE_LABEL}</td>
                      <td style={tdStyle}>{HIDDEN_BY_ROLE_LABEL}</td>
                      <td style={tdStyle}>{HIDDEN_BY_ROLE_LABEL}</td>
                      <td style={tdStyle}>{HIDDEN_BY_ROLE_LABEL}</td>
                    </>
                  ) : (
                    <>
                      <td style={tdStyle}>{event.designKey}</td>
                      <td style={tdStyle}>{event.revisionNo === null ? '版未記録' : `版${event.revisionNo}`}</td>
                      <td style={tdStyle}>{organizationLabel(event.organization)}</td>
                      <td style={tdStyle}>{APPROVAL_DECISION_LABELS[event.decision] ?? event.decision}</td>
                      <td style={tdStyle}>
                        {EVIDENCE_SOURCE_LABELS[event.evidenceSource as keyof typeof EVIDENCE_SOURCE_LABELS]
                          ?? event.evidenceSource}
                      </td>
                      <td style={tdStyle}>
                        {evidenceLabel(event.evidenceDocumentVersionId === '—' ? null : event.evidenceDocumentVersionId)}
                        <TechDetails context="ID">{event.evidenceDocumentVersionId}</TechDetails>
                      </td>
                      <td style={tdStyle}>{event.eventTime ? formatTimestamp(event.eventTime) : '未記録'}</td>
                    </>
                  )}
                  <td style={tdStyle}>{formatTimestamp(event.recordedAt)}</td>
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
      ? '手動確認で却下（二重承認に算入されません）'
      : '手動確認待ち（証跡識別子未確認）';
  }
  if (state.revoked) return '取消済み';
  if (state.invalidatedByNewerRevision) return '新しい版で無効化';
  if (state.latestDecision === 'REVOKE') return '取消済み';
  return '未承認';
}

/** The result select of the verification form. */
const VERIFICATION_RESULT_CHOICES: Choice[] = [
  { value: 'confirmed', label: '確認（識別子を原本証跡で確認した）' },
  { value: 'rejected', label: '却下（確認できなかった）' }
];

/**
 * M8-OPER2 FIX 2: the pending evidence verifications of one order. Admin sees
 * the original evidence (원본 증빙) next to the proof revision it is checked
 * against (교정본) and records the append-only verification; every other role
 * reads why the approval is not counting yet and waits for the representative.
 */
function PendingVerificationSection({
  pending,
  role,
  canVerify,
  evidenceLabel,
  organizationText
}: {
  pending: PendingManualVerificationView[];
  role: string | null;
  canVerify: boolean;
  evidenceLabel: (versionId: string | null) => string;
  organizationText: (key: string) => string;
}) {
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>
        承認証跡の手動確認（PDF・画像の識別子確認）— {pending.length}件
      </h3>
      <p style={noteStyle}>
        バイナリ証跡（PDF・画像）の承認は、識別子を自動検証できないため手動確認待ちとして記録されます。
        確認が記録されるまで二重承認には算入されません。確認の記録は代表者だけです。
      </p>
      {pending.map((entry) => (
        <div key={entry.approvalEventId} style={{ marginBottom: 16 }}>
          <div style={{ ...infoBoxStyle, borderColor: 'var(--warn)', color: 'var(--warn)', background: 'var(--warn-tint)' }}>
            <StatusBadge tone="waiting" label="手動確認待ち" />{' '}
            <strong>{organizationText(entry.organization)}</strong> の承認（デザイン {entry.designKey}／版
            {entry.revisionNo}）は手動確認待ちです。
            <div style={noteStyle}>
              原本証跡（원본 증빙）: {evidenceLabel(entry.evidenceDocumentVersionId)}
              <TechDetails context="ID・識別子">
                <p>証跡バージョンID: {entry.evidenceDocumentVersionId ?? '—'}</p>
                <p>承認証跡識別子: {entry.evidenceIdentifier ?? '—'}</p>
                <p>版ハッシュ（approved_file_sha256）: {entry.approvedFileSha256}</p>
              </TechDetails>
              確認対象の校正: デザイン {entry.designKey} ／ 版{entry.revisionNo} ／{' '}
              {formatTimestamp(entry.eventTime)} 承認（記録 {formatTimestamp(entry.recordedAt)}）
              {entry.manualVerification ? (
                <div>
                  前回の確認: {entry.manualVerification.result === 'confirmed' ? '確認' : '却下'} ／ 検証者{' '}
                  {entry.manualVerification.verifierName} ／ {formatTimestamp(entry.manualVerification.verifiedAt)}
                </div>
              ) : null}
            </div>
          </div>
          {canVerify ? (
            <ActionForm
              action={verifyEvidenceManualAction}
              submitLabel="手動確認を記録する"
              hint="確認の記録は新しい追記型イベントです。元の承認イベントとその監査記録は書き換えられません。"
              confirm={{
                title: '承認証跡の手動確認を記録しますか？',
                body: `${organizationText(entry.organization)} の承認（デザイン ${entry.designKey}／版${entry.revisionNo}）に、選んだ結果を記録します。「確認」は二重承認に算入されます。記録は追記型で、あとから書き換えられません。`,
                summaryFields: ['result', 'verifierName', 'verifiedAt', 'reasonNote']
              }}
            >
              <input type="hidden" readOnly name="approvalEventId" value={entry.approvalEventId} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <TextField name="verifierName" label="検証者" required width={200} />
                <OffsetDateTimeField name="verifiedAt" label="検証日時" required width={240} />
                <SelectField
                  name="result"
                  label="結果"
                  required
                  width={320}
                  choices={VERIFICATION_RESULT_CHOICES}
                />
                <TextField
                  name="reasonNote"
                  label="根拠（原本証跡のどこで識別子を確認したか）"
                  required
                  width={420}
                />
              </div>
            </ActionForm>
          ) : (
            <p className="role-notice">
              次のアクション: 代表者による原本証跡の確認を待ちます。{operationRefusal(role, 'artwork_approval:verify_evidence', '手動確認の記録')}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Current wall-clock time in Japan, explicitly independent of the server timezone. */
function nowInputValue(): string {
  return asiaTokyoDatetimeLocalNow();
}

/**
 * Recheck 8 Low-5: the orders the revision form offers. The API refuses a
 * draft order (422 ORDER_NOT_PAST_SEVEN_PO_VERIFIED), a cancelled order (409
 * FILM_ORDER_CANCELLED) and an order with live maker paper (409
 * MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED), so those are not choices; the
 * live-paper ones are named with their paper. An order whose paper list could
 * not be read stays a choice (the API decides), and is named as unread.
 */
async function loadRevisionTargets(orders: ReadonlyArray<FilmSupplyOrderView>): Promise<{
  registrable: FilmSupplyOrderView[];
  blocked: Array<{ order: FilmSupplyOrderView; papers: MakerPoViewRow[] }>;
  unread: FilmSupplyOrderView[];
}> {
  const candidates = orders.filter((order) => {
    const status = knownStatus(order);
    return status !== 'DRAFT' && status !== 'CANCELLED';
  });
  const lists = await Promise.all(candidates.map((order) => callApi<{ makerPurchaseOrders: MakerPoViewRow[] }>(
    `/api/film-supply-orders/${encodeURIComponent(order.id)}/maker-purchase-orders`
  )));
  const out = { registrable: [] as FilmSupplyOrderView[], blocked: [] as Array<{ order: FilmSupplyOrderView; papers: MakerPoViewRow[] }>, unread: [] as FilmSupplyOrderView[] };
  candidates.forEach((order, index) => {
    const result = lists[index];
    const rows = result?.ok && result.data && Array.isArray(result.data.makerPurchaseOrders)
      ? result.data.makerPurchaseOrders
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
