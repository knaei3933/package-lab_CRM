import { ActionForm } from '../../components/ActionForm';
import { DeliveryRecordForm } from '../../components/DeliveryRecordForm';
import { SelectField, TextField } from '../../components/fields';
import { confirmDeliveryAction, evaluateCommissionReadinessAction, recordDeliveryAction } from '../actions';
import { readSelectedProjectId } from '../../lib/api';
import { labelLookup, loadWorkspace } from '../../lib/project-data';
import type { DeliveryView } from '../../lib/project-data';
import {
  badgeStyle,
  cardStyle,
  infoBoxStyle,
  monoStyle,
  noteStyle,
  tableStyle,
  tdStyle,
  thStyle
} from '../../lib/ui';
import { formatTimestamp, READINESS_BLOCKING_LABELS, unitChoices, VERIFICATION_STATUS_LABELS } from '../../lib/vocabulary';

export const dynamic = 'force-dynamic';

/**
 * Criterion 6: 納品確認・手数料準備. Deliveries are listed with their
 * confirmation state (the Japanese labels come from GET /api/status-labels),
 * each pending one offers a confirm control that posts to the delivery
 * confirmation endpoints with a verified acceptance-evidence version, and the
 * commission readiness panel shows readinessState / isReady /
 * commissionCalculationAllowed / blocking in Japanese.
 */
export default async function DeliveriesPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。</div>;
  }

  const workspace = await loadWorkspace(projectId);
  const confirmationLabel = labelLookup(workspace.labels, 'fillingDeliveryConfirmationStates');
  const readinessStateLabel = labelLookup(workspace.labels, 'commissionReadinessStates');

  const orderCode = (orderId: string) =>
    workspace.filmOrders.find((order) => order.id === orderId)?.code
      ?? workspace.fillingOrders.find((order) => order.id === orderId)?.code
      ?? orderId;

  // Confirmation evidence: 受領証跡（acceptance_evidence）のうち人が確認済みの
  // バージョンだけが納品確認に使える。フィルム納品は発注への紐付けも一致が必要
  // （APIが検証するので、ここでは候補を絞り込んで提示する）。
  const acceptanceChoices = (delivery: DeliveryView) =>
    workspace.documents
      .filter((document) => document.documentType === 'acceptance_evidence'
        && document.verificationStatus === 'verified'
        && (delivery.kind === 'filling' || document.filmSupplyOrderId === delivery.orderId))
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        label: `${document.filename}（版${version.versionNumber}／${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${version.id.slice(0, 8)}…）`
      })));

  const filmOrderOptions = workspace.filmOrders.map((order) => ({
    id: order.id,
    code: order.code,
    lines: order.lines.map((line) => ({
      value: line.id,
      label: `明細${line.lineNumber}：${line.description}（${line.orderedQuantity}${line.unit}）`
    }))
  }));
  const fillingOrderOptions = workspace.fillingOrders.map((order) => ({
    id: order.id,
    code: order.code,
    lines: order.lines.map((line) => ({
      value: line.id,
      label: `明細${line.lineNumber}：${line.description}（${line.orderedQuantity}${line.unit}）`
    }))
  }));

  const readiness = workspace.readiness;
  const readinessIsReady = readiness?.isReady === true;

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>納品確認・手数料準備</h1>
        <p style={noteStyle}>
          納品行の受領を、確認済みの受領証跡（acceptance_evidence）を引用して確認します。すべての納品が確認できて
          セブン発注書の公式登録がそろったとき、手数料計算の準備が整います（READY）。
        </p>
        {workspace.error ? <div style={infoBoxStyle}>{workspace.error}</div> : null}
      </header>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>手数料計算の準備状態</h2>
        {readiness ? (
          <table style={tableStyle}>
            <tbody>
              <tr>
                <th style={thStyle}>準備状態（readinessState）</th>
                <td style={tdStyle}>{readinessStateLabel(readiness.readinessState)}（{readiness.readinessState}）</td>
              </tr>
              <tr>
                <th style={thStyle}>準備完了（isReady）</th>
                <td style={tdStyle}>{readinessIsReady ? 'はい' : 'いいえ'}</td>
              </tr>
              <tr>
                <th style={thStyle}>手数料計算（commissionCalculationAllowed）</th>
                <td style={tdStyle}>
                  {readinessIsReady ? '可能です' : 'まだできません'}
                  <span style={noteStyle}>（READY のときだけ手数料計算ができます）</span>
                </td>
              </tr>
              <tr>
                <th style={thStyle}>未達の要件（blocking）</th>
                <td style={tdStyle}>
                  {readiness.blocking.length === 0
                    ? 'ありません'
                    : (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {readiness.blocking.map((code) => (
                          <li key={code}>
                            {READINESS_BLOCKING_LABELS[code] ?? code}
                            <span style={monoStyle}>（{code}）</span>
                          </li>
                        ))}
                      </ul>
                    )}
                </td>
              </tr>
              <tr>
                <th style={thStyle}>評価日時</th>
                <td style={tdStyle}>{formatTimestamp(readiness.evaluatedAt)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p style={noteStyle}>まだ評価されていません。納品と公式登録がそろったら「準備状態を再評価する」を実行してください。</p>
        )}
        <div style={{ marginTop: 12 }}>
          <ActionForm action={evaluateCommissionReadinessAction} submitLabel="準備状態を再評価する">
            <p style={noteStyle}>
              評価は API（POST /api/projects/:projectId/commission-readiness）が行います。記録は明示的な評価時だけ更新されます。
            </p>
          </ActionForm>
        </div>
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>納品 一覧と確認</h2>
        <p style={noteStyle}>
          確認状態のラベルは API（/api/status-labels）の共通定義です。確認には引用する受領証跡のバージョンが必須で、
          未確認の納品は手数料計算の準備を進めません。
        </p>
        {workspace.deliveries.length === 0 ? (
          <p style={noteStyle}>納品の記録はまだありません。</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>種別</th>
                <th style={thStyle}>発注</th>
                <th style={thStyle}>数量／単位</th>
                <th style={thStyle}>連番</th>
                <th style={thStyle}>納品日</th>
                <th style={thStyle}>確認状態</th>
                <th style={thStyle}>引用した証跡</th>
                <th style={thStyle}>確認を記録する</th>
              </tr>
            </thead>
            <tbody>
              {workspace.deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td style={tdStyle}>{delivery.kind === 'film' ? 'フィルム納品' : '充填製品納品'}</td>
                  <td style={tdStyle}>
                    {orderCode(delivery.orderId)}
                    <div style={monoStyle}>{delivery.id}</div>
                  </td>
                  <td style={tdStyle}>{delivery.deliveredQuantity} {delivery.unit}</td>
                  <td style={tdStyle}>{delivery.deliverySequence}</td>
                  <td style={tdStyle}>{formatTimestamp(delivery.deliveredAt)}</td>
                  <td style={tdStyle}>
                    <span style={{ ...badgeStyle, borderColor: delivery.confirmed ? '#166534' : '#b45309', color: delivery.confirmed ? '#166534' : '#b45309' }}>
                      {confirmationLabel(delivery.confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION')}
                    </span>
                  </td>
                  <td style={monoStyle}>
                    {delivery.evidenceDocumentVersionId ?? '—'}
                    {delivery.confirmedAt ? <div>確認 {formatTimestamp(delivery.confirmedAt)}</div> : null}
                  </td>
                  <td style={{ ...tdStyle, minWidth: 260 }}>
                    {delivery.confirmed ? (
                      <span style={noteStyle}>確認済みです（確認は1回だけ記録できます）。</span>
                    ) : (
                      <ActionForm
                        action={confirmDeliveryAction}
                        submitLabel="納品を確認する"
                        hint={
                          acceptanceChoices(delivery).length === 0
                            ? '確認済みの受領証跡（acceptance_evidence）がまだありません。文書画面でアップロードして確認を記録してください。'
                            : undefined
                        }
                      >
                        <input type="hidden" readOnly name="kind" value={delivery.kind} />
                        <input type="hidden" readOnly name="deliveryId" value={delivery.id} />
                        <SelectField
                          name="evidenceDocumentVersionId"
                          label="受領証跡の書類バージョン（確認済みのみ）"
                          required
                          width={360}
                          choices={acceptanceChoices(delivery)}
                        />
                        <TextField name="note" label="確認メモ（任意）" width={220} />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>納品を記録する</h2>
        <p style={noteStyle}>
          納品行の記録と受領の確認は別の操作です。記録だけでは準備状態は進まず、確認（証跡の引用）がそろって初めて進みます。
        </p>
        <h3 style={{ fontSize: 16, margin: '12px 0 8px' }}>フィルム納品</h3>
        <DeliveryRecordForm
          action={recordDeliveryAction}
          kind="film"
          orders={filmOrderOptions}
          unitChoices={unitChoices('film')}
        />
        <hr style={{ border: 'none', borderTop: '1px solid #eef1f6', margin: '16px 0' }} />
        <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>充填製品納品</h3>
        <DeliveryRecordForm
          action={recordDeliveryAction}
          kind="filling"
          orders={fillingOrderOptions}
          unitChoices={unitChoices('filling')}
        />
      </div>
    </section>
  );
}
