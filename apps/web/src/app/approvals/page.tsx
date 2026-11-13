import { ActionForm } from '../../components/ActionForm.js';
import { ApprovalDecisionForm } from '../../components/ApprovalDecisionForm.js';
import { SelectField, TextField } from '../../components/fields.js';
import { recordArtworkApprovalAction, registerArtworkRevisionAction } from '../actions.js';
import { readSelectedProjectId } from '../../lib/api.js';
import { labelLookup, loadApprovalGate, loadWorkspace } from '../../lib/project-data.js';
import type { ApprovalGateView, DesignApprovalGateView } from '../../lib/project-data.js';
import { cardStyle, infoBoxStyle, monoStyle, noteStyle, tableStyle, tdStyle, thStyle } from '../../lib/ui.js';
import {
  APPROVAL_DECISION_LABELS,
  EVIDENCE_SOURCE_LABELS,
  formatTimestamp,
  evidenceSourceChoices,
  VERIFICATION_STATUS_LABELS
} from '../../lib/vocabulary.js';
import type { Choice } from '../../lib/types.js';

export const dynamic = 'force-dynamic';

/**
 * Criterion 5: 承認（アートワークのダブル承認）. The pending designs of every
 * order that has revisions are read from the API's derived approval gate
 * (GET /api/film-supply-orders/:orderId/approval-gate), and each one offers the
 * two approval buttons. Both buttons submit the same evidence version select,
 * so whichever organization goes second cites the same evidence document
 * version; the screen re-renders after each click and shows the moved state.
 */
export default async function ApprovalsPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。</div>;
  }

  const workspace = await loadWorkspace(projectId);
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
                          書類バージョン。両組織が同じ版を引用します。
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
  if (state.valid) return '承認済み';
  if (state.revoked) return '取消済み（REVOKE）';
  if (state.invalidatedByNewerRevision) return '新しい版で無効化';
  if (state.latestDecision === 'REVOKE') return '取消済み';
  return '未承認';
}

/** Current wall-clock time as a datetime-local value (server local time). */
function nowInputValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(
    now.getMinutes()
  )}`;
}
