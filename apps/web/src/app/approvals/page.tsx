import { ActionForm } from '../../components/ActionForm';
import { ApprovalDecisionForm } from '../../components/ApprovalDecisionForm';
import { SelectField, TextField } from '../../components/fields';
import {
  recordArtworkApprovalAction,
  registerArtworkRevisionAction,
  verifyEvidenceManualAction
} from '../actions';
import { loadSessionUser, readSelectedProjectId } from '../../lib/api';
import { labelLookup, loadApprovalGate, loadWorkspace } from '../../lib/project-data';
import type {
  ApprovalGateView,
  DesignApprovalGateView,
  PendingManualVerificationView
} from '../../lib/project-data';
import { badgeStyle, cardStyle, infoBoxStyle, monoStyle, noteStyle, tableStyle, tdStyle, thStyle } from '../../lib/ui';
import {
  APPROVAL_DECISION_LABELS,
  EVIDENCE_SOURCE_LABELS,
  formatTimestamp,
  evidenceSourceChoices,
  VERIFICATION_STATUS_LABELS
} from '../../lib/vocabulary';
import type { Choice } from '../../lib/types';

export const dynamic = 'force-dynamic';

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
    return <div style={infoBoxStyle}>案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。</div>;
  }

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  const isAdmin = (user?.role ?? 'viewer') === 'admin';
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const organizationLabel = labelLookup(workspace.labels, 'approvalOrganizations');

  const orderIds = [...new Set(workspace.revisions.map((revision) => revision.filmSupplyOrderId))];
  const gates = await Promise.all(orderIds.map((orderId) => loadApprovalGate(orderId)));
  const gateByOrderId = new Map<string, ApprovalGateView>();
  for (const gate of gates) {
    if (gate) gateByOrderId.set(gate.orderId, gate);
  }

  const orderCode = (orderId: string) =>
    workspace.filmOrders.find((order) => order.id === orderId)?.code ?? orderId;

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
    return `書類バージョン ${versionId.slice(0, 8)}…`;
  };

  const approvalEvidenceChoices = (orderId: string, designKey: string): Choice[] =>
    workspace.documents
      .filter((document) => document.documentType === 'approval_evidence'
        && document.filmSupplyOrderId === orderId
        && document.designKey === designKey)
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        label: `${document.filename}（版${version.versionNumber}／確認状態 ${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${version.id.slice(0, 8)}…）`
      })));

  const proofChoices: Choice[] = workspace.documents
    .filter((document) => document.documentType === 'proof')
    .flatMap((document) => document.versions.map((version) => ({
      value: version.id,
      label: `${document.filmSupplyOrderId ? orderCode(document.filmSupplyOrderId) : '発注未紐付け'}／${
        document.designKey ?? 'デザイン未指定'
      }／${document.filename}（版${version.versionNumber}／ID ${version.id.slice(0, 8)}…）`
    })));

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>承認（校了のダブル承認）</h1>
        <p style={noteStyle}>
          顧客とセブン化学の両組織の承認でダブル承認（校了）になります。承認は必ず証跡（approval_evidence）の
          書類バージョンを引用して記録します。どちらの組織が先でも構いません。
        </p>
        {workspace.error ? <div style={infoBoxStyle}>{workspace.error}</div> : null}
      </header>

      {orderIds.length === 0 ? (
        <div style={cardStyle}>
          <p style={noteStyle}>
            校了対象の版がまだありません。下の「校正ゲラの版を登録する」で版を登録すると、デザインごとの承認待ちが表示されます。
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
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>デザインキー</th>
                      <th style={thStyle}>現在の版</th>
                      <th style={thStyle}>顧客の承認</th>
                      <th style={thStyle}>セブン化学の承認</th>
                      <th style={thStyle}>ダブル承認</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gate.designs.map((design) => (
                      <tr key={design.designKey}>
                        <td style={tdStyle}>{design.designKey}</td>
                        <td style={tdStyle}>版{design.currentRevisionNo}</td>
                        <td style={tdStyle}>{organizationStateText(design.customer)}</td>
                        <td style={tdStyle}>{organizationStateText(design.seven)}</td>
                        <td style={tdStyle}>{design.dualApproved ? '済み（校了）' : '未達'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={infoBoxStyle}>
                  承認ゲート（/api/film-supply-orders/:id/approval-gate）の取得に失敗しました。
                </div>
              )}

              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 13, cursor: 'pointer' }}>登録済みの版（{orderRevisions.length}件）</summary>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                  {orderRevisions.map((revision) => (
                    <li key={revision.id}>
                      デザイン {revision.designKey} ／ 版{revision.revisionNo} ／ 登録 {formatTimestamp(revision.createdAt)}
                      {revision.invalidatedApprovals ? <span style={noteStyle}>（既存の承認を無効化）</span> : null}
                      ／ 版ID <span style={monoStyle}>{revision.id}</span>
                    </li>
                  ))}
                </ul>
              </details>

              {gate && gate.pendingManualVerifications.length > 0 ? (
                <PendingVerificationSection
                  pending={gate.pendingManualVerifications}
                  isAdmin={isAdmin}
                  evidenceLabel={evidenceLabel}
                  organizationText={organizationLabel}
                />
              ) : null}

              {gate
                ? gate.designs
                    .filter((design) => !design.dualApproved)
                    .map((design) => (
                      <div key={design.designKey} style={{ marginTop: 16, borderTop: '1px solid #eef1f6', paddingTop: 12 }}>
                        <h3 style={{ fontSize: 16, margin: '0 0 4px' }}>
                          承認を記録する：デザイン {design.designKey}（版{design.currentRevisionNo}）
                        </h3>
                        <p style={noteStyle}>
                          必要な証跡：この発注とデザイン「{design.designKey}」に紐付けた承認証跡（approval_evidence）の
                          書類バージョン。両組織が同じ版を引用できますが、承認証跡識別子（承認メッセージのMessage-IDや
                          署名ブロックのハッシュ）は組織ごとに固有の値を入力してください。
                        </p>
                        <ApprovalDecisionForm
                          action={recordArtworkApprovalAction}
                          revisionId={design.currentRevisionId}
                          designKey={design.designKey}
                          evidenceChoices={approvalEvidenceChoices(orderId, design.designKey)}
                          evidenceSourceChoices={evidenceSourceChoices()}
                          defaultEventTime={nowInputValue()}
                        />
                      </div>
                    ))
                : null}
            </div>
          );
        })
      )}

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>校正ゲラの版を登録する</h2>
        <p style={noteStyle}>
          発注が「セブン化学発注書確認済」以降の状態のとき、proof 書類のバージョンを版として登録できます。
          新しい版を登録すると、そのデザインの既存の承認は無効になり承認待ちに戻ります。
        </p>
        <ActionForm action={registerArtworkRevisionAction} submitLabel="版を登録する">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <SelectField
              name="orderId"
              label="フィルム発注"
              required
              width={300}
              choices={workspace.filmOrders.map((order) => ({
                value: order.id,
                label: `${order.code}（${stateLabel(order.status)}）`
              }))}
            />
            <TextField name="designKey" label="デザインキー" required width={180} hint="例：T-35" />
            <SelectField
              name="fileDocumentVersionId"
              label="版ファイル（proofのバージョン）"
              required
              width={420}
              choices={proofChoices}
            />
            <TextField name="lotMarking" label="ロット表記（任意）" width={180} />
            <TextField name="note" label="備考（任意）" width={220} />
          </div>
        </ActionForm>
        {proofChoices.length === 0 ? (
          <p style={noteStyle}>proof 書類がまだありません。文書画面から校正ゲラをアップロードしてください。</p>
        ) : null}
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>承認の記録履歴</h2>
        {workspace.approvalEvents.length === 0 ? (
          <p style={noteStyle}>記録された承認はまだありません。</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>デザイン</th>
                <th style={thStyle}>版</th>
                <th style={thStyle}>組織</th>
                <th style={thStyle}>決定</th>
                <th style={thStyle}>入手経路</th>
                <th style={thStyle}>引用した証跡バージョン</th>
                <th style={thStyle}>承認日時</th>
                <th style={thStyle}>記録</th>
              </tr>
            </thead>
            <tbody>
              {workspace.approvalEvents.map((event) => (
                <tr key={event.id}>
                  <td style={tdStyle}>{event.designKey}</td>
                  <td style={tdStyle}>版{event.revisionNo}</td>
                  <td style={tdStyle}>{organizationLabel(event.organization)}</td>
                  <td style={tdStyle}>{APPROVAL_DECISION_LABELS[event.decision] ?? event.decision}</td>
                  <td style={tdStyle}>
                    {EVIDENCE_SOURCE_LABELS[event.evidenceSource as keyof typeof EVIDENCE_SOURCE_LABELS]
                      ?? event.evidenceSource}
                  </td>
                  <td style={monoStyle}>{event.evidenceDocumentVersionId}</td>
                  <td style={tdStyle}>{formatTimestamp(event.eventTime)}</td>
                  <td style={tdStyle}>{formatTimestamp(event.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  if (state.revoked) return '取消済み（REVOKE）';
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
  isAdmin,
  evidenceLabel,
  organizationText
}: {
  pending: PendingManualVerificationView[];
  isAdmin: boolean;
  evidenceLabel: (versionId: string | null) => string;
  organizationText: (key: string) => string;
}) {
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid #eef1f6', paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>
        承認証跡の手動確認（PDF・画像の識別子確認）— {pending.length}件
      </h3>
      <p style={noteStyle}>
        バイナリ証跡（PDF・画像）の承認は、識別子を自動検証できないため手動確認待ちとして記録されます。
        確認が記録されるまで二重承認には算入されません。確認の記録は代表者だけです。
      </p>
      {pending.map((entry) => (
        <div key={entry.approvalEventId} style={{ marginBottom: 16 }}>
          <div style={{ ...infoBoxStyle, borderColor: '#e4d3b9', color: '#8a6a3b' }}>
            <span style={badgeStyle}>手動確認待ち</span>{' '}
            <strong>{organizationText(entry.organization)}</strong> の承認（デザイン {entry.designKey}／版
            {entry.revisionNo}）は手動確認待ちです。
            <div style={noteStyle}>
              原本証跡（원본 증빙）: {evidenceLabel(entry.evidenceDocumentVersionId)}
              <div style={monoStyle}>証跡バージョンID: {entry.evidenceDocumentVersionId ?? '—'}</div>
              <div style={monoStyle}>承認証跡識別子: {entry.evidenceIdentifier ?? '—'}</div>
              <div style={monoStyle}>版ハッシュ（approved_file_sha256）: {entry.approvedFileSha256}</div>
              교정본（確認対象の校正）: デザイン {entry.designKey} ／ 版{entry.revisionNo} ／{' '}
              {formatTimestamp(entry.eventTime)} 承認（記録 {formatTimestamp(entry.recordedAt)}）
              {entry.manualVerification ? (
                <div>
                  前回の確認: {entry.manualVerification.result === 'confirmed' ? '確認' : '却下'} ／ 検証者{' '}
                  {entry.manualVerification.verifierName} ／ {formatTimestamp(entry.manualVerification.verifiedAt)}
                </div>
              ) : null}
            </div>
          </div>
          {isAdmin ? (
            <ActionForm
              action={verifyEvidenceManualAction}
              submitLabel="手動確認を記録する"
              hint="確認の記録は新しい追記型イベントです。元の承認イベントとその監査記録は書き換えられません。"
            >
              <input type="hidden" readOnly name="approvalEventId" value={entry.approvalEventId} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <TextField name="verifierName" label="検証者" required width={200} />
                <TextField name="verifiedAt" label="検証日時" type="datetime-local" required width={240} />
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
            <p style={noteStyle}>
              次のアクション: 代表者による原本証跡の確認を待ちます（担当者・閲覧者は確認を記録できません）。
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Current wall-clock time as a datetime-local value (server local time). */
function nowInputValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(
    now.getMinutes()
  )}`;
}
