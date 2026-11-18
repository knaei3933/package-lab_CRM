import type { Metadata } from 'next';
import { ActionForm } from '../../components/ActionForm';
import { OrderCreateForm } from '../../components/OrderCreateForm';
import { ProjectProgress } from '../../components/ProjectProgress';
import { RoleGate, ViewerPageNotice } from '../../components/RoleGate';
import { TechDetails } from '../../components/TechDetails';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { CheckboxField, DateTextField, SelectField, TextField } from '../../components/fields';
import {
  assumeFilmReceiptAction,
  createFilmSupplyOrderAction,
  createFillingOrderAction,
  createSevenPurchaseOrderAction,
  registerSevenPurchaseOrderAction,
  transitionFilmSupplyOrderAction,
  updateFilmPaymentTermsAction,
  verifySevenPurchaseOrderAction
} from '../actions';
import { loadSessionUser, readSelectedProjectId } from '../../lib/api';
import { loadPaymentGate, PAYMENT_TERMS_LABELS } from '../../lib/maker-po-data';
import { canRoleOperate } from '../../lib/permissions';
import {
  knownStatus,
  labelLookup,
  loadWorkspace,
  NO_PROJECT_SELECTED_MESSAGE,
  officialRegistrationText,
  sevenPurchaseOrderChoiceLabel
} from '../../lib/project-data';
import type { FilmSupplyOrderView } from '../../lib/project-data';
import { MAKER_CHAIN_NOTICE, transitionChoicesFor } from '../../lib/transitions';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from '../../lib/redaction';
import { cardStyle, infoBoxStyle, noteStyle, tdStyle, thStyle } from '../../lib/ui';
import { formatTimestamp, unitChoices, unitLabel, VERIFICATION_STATUS_LABELS } from '../../lib/vocabulary';

export const dynamic = 'force-dynamic';

/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */
export const metadata: Metadata = { title: '案件（発注）一覧／作成' };

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

/** M8-OPER2 FIX 1: the G6 terms an operator can record while the order is a draft. */
const PAYMENT_TERMS_CHOICES = [
  { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
  { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
  { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
];

export default async function OrdersPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>{NO_PROJECT_SELECTED_MESSAGE}</div>;
  }

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  const role = user?.role ?? null;
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const readinessLabel = labelLookup(workspace.labels, 'commissionReadinessStates');
  // UI batch B (④): the 操作 column only when the role has a form to show in it.
  const showOrderOperations = canRoleOperate(role, 'film_order:transition');
  const poLabelById = new Map(workspace.sevenPurchaseOrders.map((po) => [po.id, po.poNumber]));
  const poChoices = workspace.sevenPurchaseOrders.map((po) => ({
    value: po.id,
    label: sevenPurchaseOrderChoiceLabel(po)
  }));

  // M8-OPER2 FIX 1: the current G6 terms of the draft orders, read from the
  // API's payment-gate answer (the same read the maker-PO screen uses), so the
  // form always shows the recorded value instead of guessing from history.
  // A withheld status (viewer) is not a draft: the 'DRAFT' value there is only
  // the data layer's placeholder, so no payment-gate read is made for it.
  const draftOrders = workspace.filmOrders.filter((order) => knownStatus(order) === 'DRAFT');
  const paymentGates = await Promise.all(draftOrders.map((order) => loadPaymentGate(order.id)));
  const paymentGateByOrderId = new Map<string, Awaited<ReturnType<typeof loadPaymentGate>>>();
  for (const [index, order] of draftOrders.entries()) {
    paymentGateByOrderId.set(order.id, paymentGates[index] ?? null);
  }

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>案件（発注）一覧／作成</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/orders" />
        <ViewerPageNotice role={role} />
        {workspace.project ? (
          <p style={noteStyle}>
            案件 {workspace.project.code}（{workspace.project.name}）／ ルート {workspace.project.route}
          </p>
        ) : (
          <TechDetails context="案件ID">{projectId}</TechDetails>
        )}
        {workspace.error ? <div style={infoBoxStyle}>{workspace.error}</div> : null}
      </header>

      <SevenPurchaseOrderSection
        orders={workspace.sevenPurchaseOrders}
        poChoices={poChoices}
        verificationLabel={VERIFICATION_STATUS_LABELS}
        role={role}
      />

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>フィルム発注 一覧</h2>
        <p style={noteStyle}>
          行の操作で状態を進めます。受領確認（問題なしとみなす）は「{stateLabel('FILM_DELIVERED')}」の発注でだけ記録できます。
        </p>
        {workspace.filmOrders.length === 0 ? (
          <p style={noteStyle}>フィルム発注はまだありません。</p>
        ) : (
          <DataTable caption="フィルム発注の一覧" captionHidden>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>発注コード</th>
                <th scope="col" style={thStyle}>状態</th>
                <th scope="col" style={thStyle}>セブン発注書</th>
                <th scope="col" style={thStyle}>明細</th>
                <th scope="col" style={thStyle}>作成</th>
                <th scope="col" style={thStyle}>更新</th>
                {showOrderOperations ? <th scope="col" style={thStyle}>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {workspace.filmOrders.map((order) => {
                const status = knownStatus(order);
                return (
                  <tr key={order.id}>
                    <td style={tdStyle}>
                      {order.code}
                      <TechDetails context="ID">{order.id}</TechDetails>
                    </td>
                    <td style={tdStyle} className="status-cell">
                      {status === null
                        ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                        : <StatusBadge domain="filmOrder" status={status} label={stateLabel(status)} />}
                    </td>
                    <td style={tdStyle}>
                      {order.sevenPurchaseOrderId
                        ? poLabelById.get(order.sevenPurchaseOrderId) ?? '紐付けあり'
                        : order.detailsHidden
                          ? HIDDEN_BY_ROLE_LABEL
                          : '—'}
                    </td>
                    <td style={tdStyle}>
                      <OrderLinesCell order={order} />
                    </td>
                    <td style={tdStyle}>{formatTimestamp(order.createdAt)}</td>
                    <td style={tdStyle}>{formatTimestamp(order.updatedAt)}</td>
                    {showOrderOperations ? (
                      <td style={{ ...tdStyle, minWidth: 'min(260px, 80vw)' }}>
                        {status === null ? null : (
                          <TransitionCell order={order} status={status} stateLabel={stateLabel} />
                        )}
                        {status === 'DRAFT' ? (
                          <RoleGate role={role} operation="film_order:update_payment_terms" label="決済条件の記録">
                            <PaymentTermsCell order={order} gate={paymentGateByOrderId.get(order.id) ?? null} />
                          </RoleGate>
                        ) : null}
                        {status === 'FILM_DELIVERED' ? (
                          <RoleGate role={role} operation="film_order:assume_receipt" label="受領確認の記録">
                            <details style={{ marginTop: 8 }}>
                              <summary style={{ fontSize: 13, cursor: 'pointer' }}>受領確認（問題なしとみなす）</summary>
                              <ActionForm
                                action={assumeFilmReceiptAction}
                                submitLabel="受領確認を記録する"
                                hint={`証跡の代わりに問題なしとみなす記録です。メモは必須で、状態は「${stateLabel('FILM_RECEIPT_ASSUMED_NO_ISSUE')}」になります。`}
                                confirm={{
                                  title: '受領確認（問題なしとみなす）を記録しますか？',
                                  body: `発注 ${order.code} を、証跡なしで問題なしとみなした記録として残し、状態を「${stateLabel('FILM_RECEIPT_ASSUMED_NO_ISSUE')}」にします。この状態は最終の状態で、記録は取り消せません。`,
                                  summaryFields: ['note', 'acknowledgeNoEvidence']
                                }}
                              >
                                <input type="hidden" readOnly name="orderId" value={order.id} />
                                <TextField name="note" label="確認メモ" required width={280} />
                                <CheckboxField name="acknowledgeNoEvidence" label="証跡なしで問題なしとみなすことに同意します" />
                              </ActionForm>
                            </details>
                          </RoleGate>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>フィルム発注を作成する</h2>
        <RoleGate role={role} operation="film_order:create" label="フィルム発注の作成">
          <p style={noteStyle}>明細の単位はフィルム商材の単位（ロール／メートル／枚）です。</p>
          <OrderCreateForm
            action={createFilmSupplyOrderAction}
            orderKind="film"
            unitChoices={unitChoices('film')}
            sevenPurchaseOrderChoices={poChoices}
            paymentTermsChoices={PAYMENT_TERMS_CHOICES}
          />
        </RoleGate>
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>充填発注 一覧・作成</h2>
        <p style={noteStyle}>
          充填製品（カプセル等）の発注です。単位はポッド／個。納品の確認状態は「納品確認・手数料準備」画面で扱います
          （準備状態: {workspace.readiness?.hidden
            ? HIDDEN_BY_ROLE_SHORT
            : readinessLabel(workspace.readiness?.readinessState ?? 'MISSING_DATA')}）。
        </p>
        {workspace.fillingOrders.length === 0 ? (
          <p style={noteStyle}>充填発注はまだありません。</p>
        ) : (
          <DataTable caption="充填発注の一覧" captionHidden>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>発注コード</th>
                <th scope="col" style={thStyle}>明細</th>
                <th scope="col" style={thStyle}>作成</th>
              </tr>
            </thead>
            <tbody>
              {workspace.fillingOrders.map((order) => (
                <tr key={order.id}>
                  <td style={tdStyle}>
                    {order.code}
                    <TechDetails context="ID">{order.id}</TechDetails>
                  </td>
                  <td style={tdStyle}>
                    {order.lines.length === 0 && order.detailsHidden ? HIDDEN_BY_ROLE_LABEL : null}
                    {order.lines.map((line) => (
                      <div key={line.id}>
                        {line.lineNumber}. {line.description} ／ {line.orderedQuantity}
                        {unitLabel(line.unit)}
                        <TechDetails context="明細ID">{line.id}</TechDetails>
                      </div>
                    ))}
                  </td>
                  <td style={tdStyle}>{formatTimestamp(order.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '16px 0' }} />
        <RoleGate role={role} operation="filling_order:create" label="充填発注の作成">
          <OrderCreateForm action={createFillingOrderAction} orderKind="filling" unitChoices={unitChoices('filling')} />
        </RoleGate>
      </div>
    </section>
  );
}

/**
 * UI batch B (③): the transition form offers only the targets the generic
 * transition endpoint can accept from this state (core state machine, minus
 * the maker chain and the 受領確認 terminal state), with an empty first choice
 * so nothing is pre-selected. The API still decides every request.
 */
function TransitionCell({
  order,
  status,
  stateLabel
}: {
  order: FilmSupplyOrderView;
  status: string;
  stateLabel: (key: string) => string;
}) {
  const set = transitionChoicesFor(status, stateLabel, order.lastNormalStatus);
  return (
    <>
      {set.makerChainNotice ? <p style={noteStyle}>{MAKER_CHAIN_NOTICE}。</p> : null}
      {set.resumeNotice ? <p className="role-notice">{set.resumeNotice}</p> : null}
      {set.choices.length === 0 ? (
        <p style={noteStyle}>{set.emptyReason}</p>
      ) : (
        <ActionForm
          action={transitionFilmSupplyOrderAction}
          submitLabel="状態を進める"
          hint="条件がそろっていない場合は、理由がここに表示されます。"
          confirm={{
            title: '発注の状態を変更しますか？',
            body: `状態を変更します。発注 ${order.code} の状態を、選んだ「進める先の状態」に変更し、変更は履歴に記録されます（記録は消えません）。`,
            summaryFields: ['to']
          }}
        >
          <input type="hidden" readOnly name="orderId" value={order.id} />
          <SelectField
            name="to"
            label="進める先の状態"
            required
            includeBlank
            blankLabel="（進める先を選ぶ）"
            width={280}
            choices={set.choices}
            hint={set.hint ?? undefined}
          />
        </ActionForm>
      )}
    </>
  );
}

function OrderLinesCell({ order }: { order: FilmSupplyOrderView }) {
  if (order.lines.length === 0) {
    if (order.lineCount > 0) return <span>{`${order.lineCount}行`}</span>;
    return <span>{order.detailsHidden ? HIDDEN_BY_ROLE_LABEL : '—'}</span>;
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

/**
 * M8-OPER2 FIX 1: the G6 terms of one DRAFT order — the current value from the
 * payment-gate read, the 入金確認 that never self-fills, and the recording form.
 * The API keeps the write open for drafts only and answers its own refusal once
 * the order has moved on.
 */
function PaymentTermsCell({
  order,
  gate
}: {
  order: FilmSupplyOrderView;
  gate: Awaited<ReturnType<typeof loadPaymentGate>>;
}) {
  const currentTerms = gate
    ? PAYMENT_TERMS_LABELS[gate.paymentTerms] ?? gate.paymentTerms
    : '（決済条件の状態を取得できませんでした）';
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ fontSize: 13, cursor: 'pointer' }}>
        決済条件（G6）: {currentTerms} ／ 入金確認: {gate?.paymentConfirmedAt ? '確認済み' : '未確認'}
      </summary>
      <ActionForm
        action={updateFilmPaymentTermsAction}
        submitLabel="決済条件を記録する"
        hint="決済条件は発注が下書きの間だけ記録できます。ここでの記録は入金確認（検証）ではありません。入金の確認は別の手動ステップです。"
        confirm={{
          title: '決済条件を記録しますか？',
          body: '選んだ決済条件（G6）をこのフィルム発注に記録します。記録は入金確認ではありません。発注が下書きの間は記録し直せますが、下書きでなくなると変更できません。',
          tone: 'primary',
          summaryFields: ['paymentTerms']
        }}
      >
        <input type="hidden" readOnly name="orderId" value={order.id} />
        <SelectField name="paymentTerms" label="決済条件" required width={280} choices={PAYMENT_TERMS_CHOICES} />
      </ActionForm>
    </details>
  );
}

function SevenPurchaseOrderSection({
  orders,
  poChoices,
  verificationLabel,
  role
}: {
  orders: Awaited<ReturnType<typeof loadWorkspace>>['sevenPurchaseOrders'];
  poChoices: Array<{ value: string; label: string }>;
  verificationLabel: Record<string, string>;
  role: string | null;
}) {
  // UI batch B (④): the 操作 column only for a role with a form to put in it.
  const showOperations = canRoleOperate(role, 'seven_po:register') || canRoleOperate(role, 'seven_po:verify');
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
        <DataTable caption="セブン化学発注書の一覧" captionHidden>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>発注番号</th>
              <th scope="col" style={thStyle}>公式登録</th>
              <th scope="col" style={thStyle}>真性確認</th>
              {showOperations ? <th scope="col" style={thStyle}>操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr key={po.id}>
                <td style={tdStyle}>
                  {po.poNumber}
                  <TechDetails context="ID">{po.id}</TechDetails>
                </td>
                <td style={tdStyle}>
                  {officialRegistrationText(po)}
                </td>
                <td style={tdStyle} className="status-cell">
                  {po.verificationStatus
                    ? (
                      <StatusBadge
                        domain="verification"
                        status={po.verificationStatus}
                        label={verificationLabel[po.verificationStatus] ?? po.verificationStatus}
                      />
                    )
                    : po.verificationHidden
                      ? <StatusBadge tone="hidden" label={HIDDEN_BY_ROLE_LABEL} />
                      : <StatusBadge tone="waiting" label="未記録" />}
                  {po.reviewPending ? <div style={noteStyle}>確認中（不一致レビュー）</div> : null}
                </td>
                {showOperations ? (
                  <td style={{ ...tdStyle, minWidth: 'min(280px, 80vw)' }}>
                    {po.officiallyRegistered ? null : (
                      <RoleGate role={role} operation="seven_po:register" label="公式登録日の記録">
                        <details style={{ marginBottom: 8 }}>
                          <summary style={{ fontSize: 13, cursor: 'pointer' }}>公式登録日を記録する</summary>
                          <ActionForm
                            action={registerSevenPurchaseOrderAction}
                            submitLabel="公式登録する"
                            confirm={{
                              title: '公式登録日を記録しますか？',
                              body: 'このセブン化学発注書の公式登録日を記録します。公式登録はフィルム発注を進める前提の一つです。記録した公式登録日をあとから変更できるのは代表者だけです。',
                              tone: 'primary',
                              summaryFields: ['officialRegisteredAt']
                            }}
                          >
                            <input type="hidden" readOnly name="poId" value={po.id} />
                            <DateTextField name="officialRegisteredAt" label="公式登録日" required width={200} />
                          </ActionForm>
                        </details>
                      </RoleGate>
                    )}
                    <RoleGate role={role} operation="seven_po:verify" label="チェックリストの記録">
                      <details>
                        <summary style={{ fontSize: 13, cursor: 'pointer' }}>真性行チェックリストを記録する</summary>
                        <ActionForm
                          action={verifySevenPurchaseOrderAction}
                          submitLabel="チェックリストを記録する"
                          hint="人は必須の記録項目をすべて埋めてください。見積と一致していない場合は「相違あり・確認中」になり、前提ゲートは閉じたままです。"
                          confirm={{
                            title: '真性行チェックリストを記録しますか？',
                            body: 'このセブン化学発注書の真性確認として、チェック内容を記録します。突合結果が「見積と一致していない」のときは「相違あり・確認中」になり、前提ゲートは閉じたままです。記録し直すと最新の内容で上書きされ、以前の記録は履歴に残ります。',
                            tone: 'primary',
                            summaryFields: [
                              'quoteMatchesPo',
                              'quoteCompared',
                              'uncertain',
                              'confirmationReplyRecorded',
                              'documentNumber',
                              'issueDate'
                            ]
                          }}
                        >
                          <input type="hidden" readOnly name="poId" value={po.id} />
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            <CheckboxField name="issuerNameRecorded" label="発行者名を確認した" />
                            <TextField name="issuerName" label="発行者名" width={180} />
                            <CheckboxField name="documentNumberRecorded" label="文書番号を確認した" />
                            <TextField name="documentNumber" label="文書番号" width={160} />
                            <CheckboxField name="issueDateRecorded" label="発行日を確認した" />
                            <DateTextField name="issueDate" label="発行日" width={170} />
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
                    </RoleGate>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '16px 0' }} />
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>セブン化学発注書を登録する</h3>
      <RoleGate role={role} operation="seven_po:create" label="発注書の登録">
        <ActionForm
          action={createSevenPurchaseOrderAction}
          submitLabel="発注書を登録する"
          hint="発注番号は紙の発注書の番号です。公式登録日は後から「公式登録日を記録する」でも入力できます。"
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <TextField name="poNumber" label="発注番号" required width={240} />
            <DateTextField name="officialRegisteredAt" label="公式登録日（任意）" width={200} />
          </div>
        </ActionForm>
      </RoleGate>
      {poChoices.length === 0 ? null : (
        <p style={noteStyle}>登録済み: {poChoices.length}件</p>
      )}
    </div>
  );
}
