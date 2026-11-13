import { ActionForm } from '../../components/ActionForm.js';
import { OrderCreateForm } from '../../components/OrderCreateForm.js';
import { CheckboxField, SelectField, TextField } from '../../components/fields.js';
import {
  assumeFilmReceiptAction,
  createFilmSupplyOrderAction,
  createFillingOrderAction,
  createSevenPurchaseOrderAction,
  registerSevenPurchaseOrderAction,
  transitionFilmSupplyOrderAction,
  verifySevenPurchaseOrderAction
} from '../actions.js';
import { readSelectedProjectId } from '../../lib/api.js';
import { labelLookup, loadWorkspace } from '../../lib/project-data.js';
import type { FilmSupplyOrderView } from '../../lib/project-data.js';
import {
  cardStyle,
  infoBoxStyle,
  monoStyle,
  noteStyle,
  tableStyle,
  tdStyle,
  thStyle
} from '../../lib/ui.js';
import { formatTimestamp, unitChoices, unitLabel, VERIFICATION_STATUS_LABELS } from '../../lib/vocabulary.js';

export const dynamic = 'force-dynamic';

/**
 * Criterion 3: 案件（発注）一覧／作成. Film supply orders are listed with the
 * Japanese status labels served by GET /api/status-labels, and created through
 * the existing POST /api/projects/:projectId/film-supply-orders endpoint. The
 * seven purchase order intake (create → official registration → authenticity
 * checklist) lives here too, because a film order can only leave DRAFT once
 * its purchase order is registered and checklist-verified.
 */

const QUOTE_MATCH_CHOICES = [
  { value: 'true', label: '見積と一致している' },
  { value: 'false', label: '見積と一致していない' }
];

interface TransitionChoice {
  value: string;
  label: string;
}

export default async function OrdersPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。</div>;
  }

  const workspace = await loadWorkspace(projectId);
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const readinessLabel = labelLookup(workspace.labels, 'commissionReadinessStates');
  const transitionChoices: TransitionChoice[] = (workspace.labels?.filmSupplyOrderStates ?? []).map((entry) => ({
    value: entry.key,
    label: `${entry.label}（${entry.key}）`
  }));
  const poLabelById = new Map(workspace.sevenPurchaseOrders.map((po) => [po.id, po.poNumber]));
  const poChoices = workspace.sevenPurchaseOrders.map((po) => ({
    value: po.id,
    label: `${po.poNumber}（${po.officialRegisteredAt ? '公式登録済み' : '未登録'}）`
  }));

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>案件（発注）一覧／作成</h1>
        {workspace.project ? (
          <p style={noteStyle}>
            案件 {workspace.project.code}（{workspace.project.name}）／ ルート {workspace.project.route}
          </p>
        ) : (
          <p style={noteStyle}>案件ID: <span style={monoStyle}>{projectId}</span></p>
        )}
        {workspace.error ? <div style={infoBoxStyle}>{workspace.error}</div> : null}
      </header>

      <SevenPurchaseOrderSection
        orders={workspace.sevenPurchaseOrders}
        poChoices={poChoices}
        verificationLabel={VERIFICATION_STATUS_LABELS}
      />

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>フィルム発注 一覧</h2>
        <p style={noteStyle}>
          状態のラベルは API（/api/status-labels）の共通定義です。行の操作で状態を進め、受領確認（問題なしとみなす）は
          FILM_DELIVERED でのみ記録できます。
        </p>
        {workspace.filmOrders.length === 0 ? (
          <p style={noteStyle}>フィルム発注はまだありません。</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>発注コード</th>
                <th style={thStyle}>状態</th>
                <th style={thStyle}>セブン発注書</th>
                <th style={thStyle}>明細</th>
                <th style={thStyle}>作成</th>
                <th style={thStyle}>更新</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {workspace.filmOrders.map((order) => (
                <tr key={order.id}>
                  <td style={tdStyle}>
                    {order.code}
                    <div style={monoStyle}>{order.id}</div>
                  </td>
                  <td style={tdStyle}>{stateLabel(order.status)}</td>
                  <td style={tdStyle}>
                    {order.sevenPurchaseOrderId ? poLabelById.get(order.sevenPurchaseOrderId) ?? '紐付けあり' : '—'}
                  </td>
                  <td style={tdStyle}>
                    <OrderLinesCell order={order} />
                  </td>
                  <td style={tdStyle}>{formatTimestamp(order.createdAt)}</td>
                  <td style={tdStyle}>{formatTimestamp(order.updatedAt)}</td>
                  <td style={{ ...tdStyle, minWidth: 260 }}>
                    <ActionForm
                      action={transitionFilmSupplyOrderAction}
                      submitLabel="状態を進める"
                      hint="遷移はAPIの状態遷移表に従います。許可されていない遷移はAPIが拒否します。"
                    >
                      <input type="hidden" readOnly name="orderId" value={order.id} />
                      <SelectField name="to" label="遷移先の状態" required width={280} choices={transitionChoices} />
                    </ActionForm>
                    {order.status === 'FILM_DELIVERED' ? (
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ fontSize: 13, cursor: 'pointer' }}>受領確認（問題なしとみなす）</summary>
                        <ActionForm
                          action={assumeFilmReceiptAction}
                          submitLabel="受領確認を記録する"
                          hint="証跡の代わりに問題なしとみなす記録です。メモは必須で、状態は FILM_RECEIPT_ASSUMED_NO_ISSUE になります。"
                        >
                          <input type="hidden" readOnly name="orderId" value={order.id} />
                          <TextField name="note" label="確認メモ" required width={280} />
                          <CheckboxField name="acknowledgeNoEvidence" label="証跡なしで問題なしとみなすことに同意します" />
                        </ActionForm>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>フィルム発注を作成する</h2>
        <p style={noteStyle}>明細の単位はフィルム商材の単位（ロール／メートル／枚）です。</p>
        <OrderCreateForm
          action={createFilmSupplyOrderAction}
          orderKind="film"
          unitChoices={unitChoices('film')}
          sevenPurchaseOrderChoices={poChoices}
        />
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>充填発注 一覧・作成</h2>
        <p style={noteStyle}>
          充填製品（カプセル等）の発注です。単位はポッド／個。納品の確認状態は「納品確認・手数料準備」画面で扱います
          （準備状態: {readinessLabel(workspace.readiness?.readinessState ?? 'MISSING_DATA')}）。
        </p>
        {workspace.fillingOrders.length === 0 ? (
          <p style={noteStyle}>充填発注はまだありません。</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>発注コード</th>
                <th style={thStyle}>明細</th>
                <th style={thStyle}>作成</th>
              </tr>
            </thead>
            <tbody>
              {workspace.fillingOrders.map((order) => (
                <tr key={order.id}>
                  <td style={tdStyle}>
                    {order.code}
                    <div style={monoStyle}>{order.id}</div>
                  </td>
                  <td style={tdStyle}>
                    {order.lines.map((line) => (
                      <div key={line.id}>
                        {line.lineNumber}. {line.description} ／ {line.orderedQuantity}
                        {unitLabel(line.unit)} ／ 明細ID <span style={monoStyle}>{line.id}</span>
                      </div>
                    ))}
                  </td>
                  <td style={tdStyle}>{formatTimestamp(order.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <hr style={{ border: 'none', borderTop: '1px solid #eef1f6', margin: '16px 0' }} />
        <OrderCreateForm action={createFillingOrderAction} orderKind="filling" unitChoices={unitChoices('filling')} />
      </div>
    </section>
  );
}

function OrderLinesCell({ order }: { order: FilmSupplyOrderView }) {
  if (order.lines.length === 0) {
    return <span>{order.lineCount > 0 ? `${order.lineCount}行` : '—'}</span>;
  }
  return (
    <div>
      {order.lines.map((line) => (
        <div key={line.id}>
          {line.lineNumber}. {line.description} ／ {line.orderedQuantity}
          {unitLabel(line.unit)}
        </div>
      ))}
    </div>
  );
}

function SevenPurchaseOrderSection({
  orders,
  poChoices,
  verificationLabel
}: {
  orders: Awaited<ReturnType<typeof loadWorkspace>>['sevenPurchaseOrders'];
  poChoices: Array<{ value: string; label: string }>;
  verificationLabel: Record<string, string>;
}) {
  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>セブン化学発注書</h2>
      <p style={noteStyle}>
        フィルム発注を進めるには、発注書の公式登録と真性行チェックリストの記録（確認済み）が必要です。ここで記録すると、
        フィルム発注の紐付けと状態遷移、正式書類のアップロードの前提がそろいます。
      </p>

      {orders.length === 0 ? (
        <p style={noteStyle}>セブン化学発注書はまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>発注番号</th>
              <th style={thStyle}>公式登録</th>
              <th style={thStyle}>真性確認</th>
              <th style={thStyle}>操作</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr key={po.id}>
                <td style={tdStyle}>
                  {po.poNumber}
                  <div style={monoStyle}>{po.id}</div>
                </td>
                <td style={tdStyle}>{po.officialRegisteredAt ? formatTimestamp(po.officialRegisteredAt) : '未登録'}</td>
                <td style={tdStyle}>
                  {po.verificationStatus
                    ? verificationLabel[po.verificationStatus] ?? po.verificationStatus
                    : '未記録'}
                  {po.reviewPending ? <div style={noteStyle}>確認中（不一致レビュー）</div> : null}
                </td>
                <td style={{ ...tdStyle, minWidth: 280 }}>
                  {po.officialRegisteredAt ? null : (
                    <details style={{ marginBottom: 8 }}>
                      <summary style={{ fontSize: 13, cursor: 'pointer' }}>公式登録日を記録する</summary>
                      <ActionForm action={registerSevenPurchaseOrderAction} submitLabel="公式登録する">
                        <input type="hidden" readOnly name="poId" value={po.id} />
                        <TextField name="officialRegisteredAt" label="公式登録日" type="date" required width={200} />
                      </ActionForm>
                    </details>
                  )}
                  <details>
                    <summary style={{ fontSize: 13, cursor: 'pointer' }}>真性行チェックリストを記録する</summary>
                    <ActionForm
                      action={verifySevenPurchaseOrderAction}
                      submitLabel="チェックリストを記録する"
                      hint="人は必須の記録項目をすべて埋めてください。見積と一致していない場合は「相違あり・確認中」になり、前提ゲートは閉じたままです。"
                    >
                      <input type="hidden" readOnly name="poId" value={po.id} />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <CheckboxField name="issuerNameRecorded" label="発行者名を確認した" />
                        <TextField name="issuerName" label="発行者名" width={180} />
                        <CheckboxField name="documentNumberRecorded" label="文書番号を確認した" />
                        <TextField name="documentNumber" label="文書番号" width={160} />
                        <CheckboxField name="issueDateRecorded" label="発行日を確認した" />
                        <TextField name="issueDate" label="発行日" type="date" width={170} />
                        <CheckboxField name="sendingChannelRecorded" label="送信経路を確認した" />
                        <TextField name="sendingChannel" label="送信経路" width={180} />
                        <CheckboxField name="pastTransactionCompared" label="過去取引と突合した" />
                        <TextField name="pastTransactionNote" label="突合メモ" width={180} />
                        <CheckboxField name="quoteCompared" label="見積と突合した" />
                        <SelectField name="quoteMatchesPo" label="突合結果" required choices={QUOTE_MATCH_CHOICES} width={220} />
                        <TextField name="quoteComparisonNote" label="突合メモ" width={180} />
                        <TextField name="tamperHints" label="改ざん疑いのメモ（任意・参考記録）" width={220} />
                        <CheckboxField name="uncertain" label="確認が不確かだった" />
                        <CheckboxField name="confirmationReplyRecorded" label="確認の返信を記録した（不確かな場合必須）" />
                        <TextField name="confirmationReplyNote" label="返信メモ" width={180} />
                        <TextField name="verificationNote" label="検証メモ" width={220} />
                      </div>
                    </ActionForm>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid #eef1f6', margin: '16px 0' }} />
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>セブン化学発注書を登録する</h3>
      <ActionForm
        action={createSevenPurchaseOrderAction}
        submitLabel="発注書を登録する"
        hint="発注番号は紙の発注書の番号です。公式登録日は後から「公式登録日を記録する」でも入力できます。"
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <TextField name="poNumber" label="発注番号" required width={240} />
          <TextField name="officialRegisteredAt" label="公式登録日（任意）" type="date" width={200} />
        </div>
      </ActionForm>
      {poChoices.length === 0 ? null : (
        <p style={noteStyle}>登録済み: {poChoices.length}件</p>
      )}
    </div>
  );
}
