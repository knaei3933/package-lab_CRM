import type { Metadata } from 'next';
import { ActionForm } from '../components/ActionForm';
import { ApprovalDecisionForm } from '../components/ApprovalDecisionForm';
import { ChangeRequestFields } from '../components/ChangeRequestFields';
import { OffsetDateTimeField } from '../components/OffsetDateTimeField';
import { ProjectProgress } from '../components/ProjectProgress';
import { ProjectUnavailable } from '../components/ProjectUnavailable';
import type { ProjectScreenProps } from './screen-props';
import { RoleGate, ViewerPageNotice } from '../components/RoleGate';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { TechDetails } from '../components/TechDetails';
import { SelectField, TextField } from '../components/fields';
import {
  recordArtworkApprovalAction,
  registerArtworkRevisionAction,
  verifyEvidenceManualAction
} from '../app/actions';
import { loadSessionUser } from '../lib/api';
import { callApi } from '../lib/api';
import { asiaTokyoDatetimeLocalNow } from '../lib/datetime';
import { canRoleOperate, operationRefusal } from '../lib/permissions';
import {
  filmOrderChoiceLabel,
  labelLookup,
  loadApprovalGate,
  loadWorkspace,
  NO_PROJECT_SELECTED_MESSAGE,
  knownStatus,
  revisionNumberText
} from '../lib/project-data';
import { shortId } from '../lib/short-id';
import { approvalHistoryKeys, changeEvidenceChoices, printingStartedOrderIds } from '../lib/change-request';
import type {
  ApprovalGateView,
  FilmSupplyOrderView,
  DesignApprovalGateView,
  PendingManualVerificationView
} from '../lib/project-data';
import { cardStyle, infoBoxStyle, noteStyle, tdStyle, thStyle } from '../lib/ui';
import {
  APPROVAL_DECISION_LABELS,
  EVIDENCE_SOURCE_LABELS,
  formatTimestamp,
  evidenceSourceChoices,
  ISSUER_ENTITY_LABELS,
  VERIFICATION_STATUS_LABELS
} from '../lib/vocabulary';
import type { IssuerEntity } from '@kanei/core';
import type { Choice } from '../lib/types';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from '../lib/redaction';
import { ARTWORK_REVISION_LIVE_PAPER_REFUSAL, liveMakerPapers, MAKER_PO_STATUS_LABELS } from '../lib/maker-po-data';
import type { MakerPoViewRow } from '../lib/maker-po-data';


/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */

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
export async function ApprovalsScreen({ projectId, projectCode }: ProjectScreenProps) {

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (workspace.projectRefused) return <ProjectUnavailable title="承認（校了のダブル承認）" reason={workspace.error} returnTo="/approvals" />;
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

  // UI batch F (review M5): the API records DOCUMENT_VERSION_VIEWED for every
  // Message-ID it reads, so only the evidence an approval form on this screen
  // actually offers is read — a role that may record approvals, a design still
  // waiting for them, and the document's current version (the only one the API
  // extracts from). Nothing is read for a viewer or a fully approved order.
  const evidenceAutoIdentifiers = new Map<string, string>();
  const pendingDesigns = new Set(gates.flatMap((gate) => gate
    ? gate.designs.filter((design) => !design.dualApproved).map((design) => `${gate.orderId}\u0000${design.designKey}`)
    : []));
  const offeredEvidence = canRoleOperate(role, 'artwork_approval:record')
    ? workspace.documents.filter((document) => document.documentType === 'approval_evidence'
      && document.filmSupplyOrderId !== null
      && document.designKey !== null
      && pendingDesigns.has(`${document.filmSupplyOrderId}\u0000${document.designKey}`))
    : [];
  const currentVersions = offeredEvidence.flatMap((document) => {
    const latest = Math.max(...document.versions.map((candidate) => candidate.versionNumber));
    return document.versions.filter((version) => version.versionNumber === latest);
  });
  await Promise.all(currentVersions.map(async (version) => {
    const result = await callApi<{ evidenceIdentifier?: string }>(
      `/api/document-versions/${encodeURIComponent(version.id)}/evidence-message-id`
    );
    if (result.ok && result.data?.evidenceIdentifier) {
      evidenceAutoIdentifiers.set(version.id, result.data.evidenceIdentifier);
    }
  }));

  const approvalEvidenceChoices = (orderId: string, designKey: string): Choice[] =>
    workspace.documents
      .filter((document) => document.documentType === 'approval_evidence'
        && document.filmSupplyOrderId === orderId
        && document.designKey === designKey)
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        issuerEntity: document.issuerEntity,
        autoEvidenceIdentifier: evidenceAutoIdentifiers.get(version.id) ?? null,
        label: `${document.filename}（版${version.versionNumber}／確認状態 ${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${shortId(version.id)}）`
      })));

  const revisionTargets = canRoleOperate(role, 'artwork_revision:create')
    ? await loadRevisionTargets(workspace.filmOrders)
    : { registrable: [], blocked: [], unread: [] };

  // UI batch F: the change request facts the revision form asks for (server R1-9 / F2).
  const historyKeys = approvalHistoryKeys(workspace.revisions, workspace.approvalEvents, gates);
  const printedOrderIds = printingStartedOrderIds(workspace.filmOrders);
  const changeEvidence = changeEvidenceChoices(workspace.documents);

  const proofChoices: Choice[] = workspace.documents
    .filter((document) => document.documentType === 'proof')
    .flatMap((document) => document.versions.map((version) => ({
      value: version.id,
      label: `${document.filmSupplyOrderId ? orderCode(document.filmSupplyOrderId) : '発注未紐付け'}／${
        document.designKey ?? 'デザイン未指定'
      }／${document.filename}（版${version.versionNumber}／ID ${shortId(version.id)}）`
    })));

  return (
    <section className="sx-11bfff5">
      <header>
        <h1 className="sx-15b888e">承認（校了のダブル承認）</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/approvals" projectCode={projectCode} />
        <ViewerPageNotice role={role} />
        <p className="ui-note">
          顧客とセブン化学の両組織の承認でダブル承認（校了）になります。承認は必ず承認証跡の
          書類バージョンを引用して記録します。どちらの組織が先でも構いません。
        </p>
        {workspace.error ? <div className="ui-info">{workspace.error}</div> : null}
      </header>

      {orderIds.length === 0 ? (
        <div className="ui-card">
          <p className="ui-note">
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
            <div className="ui-card" key={orderId}>
              <h2 className="sx-c5c15d8">
                {orderCode(orderId)}
                {gate ? <span className="ui-note"> ／ 状態: {stateLabel(gate.orderStatus)}</span> : null}
              </h2>
              <p className="ui-note">
                {gate?.dualApproved
                  ? 'この発注の必要なデザインはすべてダブル承認済みです。'
                  : '未承認のデザインがあります。証跡を選んで承認を記録してください。'}
              </p>

              {gate ? (
                <DataTable caption={`${orderCode(orderId)} のデザインごとの承認状況`}>
                  <thead>
                    <tr>
                      <th className="ui-th" scope="col">デザインキー</th>
                      <th className="ui-th" scope="col">現在の版</th>
                      <th className="ui-th" scope="col">顧客の承認</th>
                      <th className="ui-th" scope="col">セブン化学の承認</th>
                      <th className="ui-th" scope="col">ダブル承認</th>
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
                />
              ) : null}

              {gate
                ? gate.designs
                    .filter((design) => !design.dualApproved)
                    .map((design) => (
                      <div className="sx-1f27ed4" key={design.designKey}>
                        <h3 className="sx-f4deb8f">
                          承認を記録する：デザイン {design.designKey}（版{design.currentRevisionNo}）
                        </h3>
                        <RoleGate role={role} operation="artwork_approval:record" label="承認の記録">
                          <p className="ui-note">
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

      <div className="ui-card">
        <h2 className="sx-c5c15d8">校正ゲラの版を登録する</h2>
        <RoleGate role={role} operation="artwork_revision:create" label="版の登録">
          <p className="ui-note">
            発注が「{stateLabel('SEVEN_PO_VERIFIED')}」以降の状態で、取り消されていないメーカー発注書がないとき、
            校正ゲラの書類のバージョンを版として登録できます（取消で終了した発注には登録できません）。
            新しい版を登録すると、そのデザインの既存の承認は無効になり承認待ちに戻ります。
            承認の記録があるデザインの差し替えは変更依頼として扱われ、依頼組織・変更理由・証憑・影響（納期／数量／金額）・
            実費（なければ0）・ロット表記の記録が必要です。
          </p>
          {revisionTargets.blocked.length > 0 ? (
            <div className="ui-info">
              <strong>版を登録できない発注: </strong>
              {revisionTargets.blocked.map(({ order, papers }) => `${order.code}（メーカー発注書 ${papers
                .map((paper) => `${shortId(paper.id)}: ${MAKER_PO_STATUS_LABELS[paper.status] ?? paper.status}`)
                .join('、')}）`).join('／')}
              <p className="ui-note">{ARTWORK_REVISION_LIVE_PAPER_REFUSAL}</p>
            </div>
          ) : null}
          {revisionTargets.unread.length > 0 ? (
            <p className="ui-note">
              {`${revisionTargets.unread.map((order) => order.code).join('、')}: メーカー発注書の状態を確認できませんでした。`
                + '取り消されていないメーカー発注書がある場合、版は登録されません（理由が表示されます）。'}
            </p>
          ) : null}
          <ActionForm action={registerArtworkRevisionAction} submitLabel="版を登録する">
            <div className="sx-f11b79b">
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
              <TextField name="lotMarking" label="ロット表記（変更依頼では必須）" width={200} />
              <TextField name="note" label="備考（任意）" width={220} />
              <ChangeRequestFields
                historyKeys={historyKeys}
                printedOrderIds={printedOrderIds}
                evidenceChoices={changeEvidence}
                canRecordPrinted={role === 'admin'}
              />
            </div>
          </ActionForm>
          {proofChoices.length === 0 ? (
            <p className="ui-note">校正ゲラの書類がまだありません。文書画面から校正ゲラをアップロードしてください。</p>
          ) : null}
        </RoleGate>
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
      ? '手動確認で却下（二重承認に算入されません）'
      : '手動確認待ち（証跡識別子未確認）';
  }
  if (state.revoked) return '取消済み';
  if (state.invalidatedByNewerRevision) return '新しい版で無効化';
  if (state.latestDecision === 'REVOKE') return '取消済み';
  return '未承認';
}

/** The result select of the verification form. */
/** P0 R02: a mismatched issuer without the declared exception can only be rejected (the API refuses 「確認」). */
/** P0 review (EVIDENCE_REQUIRES_REPLACEMENT): an older held-back approval is re-recorded, not checked. */
const REPLACEMENT_GUIDANCE =
  'この承認は確認の記録ができない古い記録です。上の「承認を記録する」で、この組織が発行した承認証跡を選んで承認を記録し直してください（証跡がなければ文書画面で先に登録します）。';

const REJECT_ONLY_CHOICES: Choice[] = [{ value: 'rejected', label: '却下（発行元が承認する組織と違う／確認できなかった）' }];

/**
 * P0 R02 (B2): the facts the representative checks before 「確認」, spelled out —
 * the evidence's issuer, the organization approving, whether they match, the
 * shared-evidence exception and its reason, and whether 「確認」 is possible.
 */
function EvidenceIssuerCheck({
  entry,
  organizationText
}: {
  entry: PendingManualVerificationView;
  organizationText: (key: string) => string;
}) {
  const issuer = entry.evidenceIssuerEntity ? ISSUER_ENTITY_LABELS[entry.evidenceIssuerEntity as IssuerEntity] ?? '（不明）' : '（記録なし）';
  const expected = entry.expectedIssuerEntity ? ISSUER_ENTITY_LABELS[entry.expectedIssuerEntity as IssuerEntity] ?? '（不明）' : '—';
  const matches = entry.issuerMatchesOrganization;
  return (
    <dl className="issuer-check">
      <div>
        <dt>承認する組織</dt>
        <dd>{organizationText(entry.organization)}</dd>
      </div>
      <div>
        <dt>証跡の発行元</dt>
        <dd>{issuer}</dd>
      </div>
      <div>
        <dt>照合</dt>
        <dd>
          {matches === true ? (
            <StatusBadge tone="done" label="一致" />
          ) : matches === false ? (
            <>
              <StatusBadge tone="blocked" label="不一致" />
              {` 必要な発行元: ${expected}`}
            </>
          ) : (
            '（照合結果なし）'
          )}
        </dd>
      </div>
      <div>
        <dt>識別子</dt>
        <dd translate="no">{entry.evidenceIdentifier ?? '（記録なし）'}</dd>
      </div>
      {entry.sameContentUsedByOtherOrganization ? (
        <div>
          <dt>内容の重複</dt>
          <dd>もう一方の組織の承認と同じ内容の証跡です（同じ書類またはまったく同じファイル）。共有証跡の例外がなければ数えられません。</dd>
        </div>
      ) : null}
      {entry.sharedEvidenceException ? (
        <div>
          <dt>共有証跡の例外</dt>
          <dd>あり（理由: {entry.sharedEvidenceException.reason ?? '記録なし'}）</dd>
        </div>
      ) : null}
      {entry.confirmable ? null : (
        <div>
          <dt>確認</dt>
          <dd>発行元が承認する組織と違うため「確認」は記録できません。「却下」を記録し、その組織が発行した承認証跡を登録し直してください。</dd>
        </div>
      )}
    </dl>
  );
}

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
    <div className="sx-1f27ed4">
      <h3 className="sx-e6251b7">
        承認証跡の手動確認（PDF・画像の識別子確認）— {pending.length}件
      </h3>
      <p className="ui-note">
        バイナリ証跡（PDF・画像）の承認は、識別子を自動検証できないため手動確認待ちとして記録されます。
        確認が記録されるまで二重承認には算入されません。確認の記録は代表者だけです。
      </p>
      {pending.map((entry) => (
        <div className="sx-045aac8" key={entry.approvalEventId}>
          <div className="ui-info sx-ab544d4">
            <StatusBadge tone="waiting" label="手動確認待ち" />{' '}
            <strong>{organizationText(entry.organization)}</strong> の承認（デザイン {entry.designKey}／版
            {entry.revisionNo}）は手動確認待ちです。
            <EvidenceIssuerCheck entry={entry} organizationText={organizationText} />
            <div className="ui-note">
              原本証跡: {evidenceLabel(entry.evidenceDocumentVersionId)}
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
          {canVerify && !entry.recordedAsPending ? (
            <p className="role-notice">{REPLACEMENT_GUIDANCE}</p>
          ) : null}
          {canVerify && entry.recordedAsPending ? (
            <ActionForm
              action={verifyEvidenceManualAction}
              submitLabel="手動確認を記録する"
              hint="確認の記録は新しい追記型イベントです。元の承認イベントとその監査記録は書き換えられません。"
              confirm={{
                title: '承認証跡の手動確認を記録しますか？',
                body: `${organizationText(entry.organization)} の承認（デザイン ${entry.designKey}／版${entry.revisionNo}）に、選んだ結果を記録します。「確認」は二重承認に算入されます。記録は追記型で、あとから書き換えられません。`,
                summaryFields: ['result', 'reasonNote']
              }}
            >
              <input type="hidden" readOnly name="approvalEventId" value={entry.approvalEventId} />
              <div className="sx-f11b79b">
                {/* P0 R11 (M3): the API records the signed-in representative and the server time. */}
                <SelectField
                  name="result"
                  label="結果"
                  required
                  width={320}
                  choices={entry.confirmable ? VERIFICATION_RESULT_CHOICES : REJECT_ONLY_CHOICES}
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
