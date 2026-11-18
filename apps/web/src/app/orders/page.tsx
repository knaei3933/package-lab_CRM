import type { Metadata } from 'next';
import { LEGACY_HOLD_RELEASE_TARGETS } from '@kanei/core';
import { ActionForm } from '../../components/ActionForm';
import { ChoiceDisclosure, ChoiceToneActionForm } from '../../components/ChoiceDrivenForm';
import { OrderCreateForm } from '../../components/OrderCreateForm';
import { RepresentativeQueuePanel } from '../../components/RepresentativeQueue';
import { loadRepresentativeQueue } from '../../lib/representative-queue';
import { ProjectProgress } from '../../components/ProjectProgress';
import { ProjectUnavailable } from '../../components/ProjectUnavailable';
import { RoleGate, ViewerPageNotice } from '../../components/RoleGate';
import { TechDetails } from '../../components/TechDetails';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { CheckboxField, DateTextField, SelectField, TextareaField, TextField } from '../../components/fields';
import {
  assumeFilmReceiptAction,
  createFilmSupplyOrderAction,
  createFillingOrderAction,
  createSevenPurchaseOrderAction,
  registerSevenPurchaseOrderAction,
  releaseFilmOrderHoldAction,
  resolveCancellationReviewAction,
  selectProjectAction,
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
  loadSelectableProjects,
  loadWorkspace,
  makerCleanupRecords,
  NO_PROJECT_SELECTED_MESSAGE,
  officialRegistrationText,
  sevenPurchaseOrderChoiceLabel,
  UNLINKED_ORDER_REMEDY,
  uncancellableLivePapers
} from '../../lib/project-data';
import type { FilmSupplyOrderView, Workspace } from '../../lib/project-data';
import { holdReleaseFacts, holdSummaryText } from '../../lib/decision-facts';
import { EVIDENCE_GAP_SUFFIX, EVIDENCE_NOTE_FIELD, evidenceGapsFor } from '../../lib/transition-evidence';
import type { MakerPaperCleanupSummary } from '../../lib/maker-po-data';
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
    // UI batch E (F-23): the first screen after login — the representative sees
    // what waits for them across projects before choosing one.
    const firstUser = await loadSessionUser();
    const queue = firstUser?.role === 'admin' ? await loadRepresentativeQueue(await loadSelectableProjects()) : null;
    return (
      <section style={{ display: 'grid', gap: 24 }}>
        <div style={infoBoxStyle}>{NO_PROJECT_SELECTED_MESSAGE}</div>
        {queue ? (
          <div style={cardStyle}>
            <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>代表者の対応待ち（全案件）</h2>
            <RepresentativeQueuePanel queue={queue} selectAction={selectProjectAction} currentProjectId={null} />
          </div>
        ) : null}
      </section>
    );
  }

  const [user, workspace] = await Promise.all([loadSessionUser(), loadWorkspace(projectId)]);
  // UI batch E (F-23): the other projects' waiting decisions (this project's are in 「次にやること」 below).
  const representativeQueue = user?.role === 'admin' && !workspace.projectRefused
    ? await loadRepresentativeQueue((await loadSelectableProjects()).filter((project) => project.id !== projectId))
    : null;
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (workspace.projectRefused) return <ProjectUnavailable title="案件（発注）一覧／作成" reason={workspace.error} />;
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
        {representativeQueue && representativeQueue.tasks.length > 0 ? (
          <details className="progress-completed" style={{ marginTop: 12 }}>
            <summary>ほかの案件の代表者の対応待ち（{representativeQueue.tasks.length}件）</summary>
            <RepresentativeQueuePanel queue={representativeQueue} selectAction={selectProjectAction} currentProjectId={projectId} />
          </details>
        ) : null}
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
                      {status === 'ON_HOLD' && order.hold ? <div style={noteStyle}>{holdSummaryText(order.hold)}</div> : null}
                    </td>
                    <td style={tdStyle}>
                      {order.sevenPurchaseOrderId
                        ? poLabelById.get(order.sevenPurchaseOrderId) ?? '紐付けあり'
                        : order.detailsHidden
                          ? HIDDEN_BY_ROLE_LABEL
                          : '紐付けなし'}
                      {/* UI batch E (F-05): an unlinked draft cannot leave DRAFT — say what to do. */}
                      {!order.sevenPurchaseOrderId && !order.detailsHidden && status === 'DRAFT' ? (
                        <p className="role-notice">
                          {`この発注は「${stateLabel('SEVEN_PO_VERIFIED')}」へ進められません。${UNLINKED_ORDER_REMEDY(stateLabel)}。`}
                        </p>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <OrderLinesCell order={order} />
                    </td>
                    <td style={tdStyle}>{formatTimestamp(order.createdAt)}</td>
                    <td style={tdStyle}>{formatTimestamp(order.updatedAt)}</td>
                    {showOrderOperations ? (
                      <td style={{ ...tdStyle, minWidth: 'min(260px, 80vw)' }}>
                        {status === null ? null : (
                          <TransitionCell
                            order={order}
                            status={status}
                            stateLabel={stateLabel}
                            role={role}
                            makerCleanup={workspace.makerPaperCleanup?.[order.id]}
                            workspace={workspace}
                          />
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
                                {/* UI batch E (F-17): required here, so an unticked box stops before the dialog. */}
                                <CheckboxField name="acknowledgeNoEvidence" label="証跡なしで問題なしとみなすことに同意します" required />
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
  stateLabel,
  role,
  makerCleanup,
  workspace
}: {
  order: FilmSupplyOrderView;
  status: string;
  stateLabel: (key: string) => string;
  role: string | null;
  /** Medium-3: the maker paper left on a cancelled or frozen order (absent: not read). */
  makerCleanup: MakerPaperCleanupSummary | undefined;
  workspace: Pick<Workspace, 'documents' | 'revisions' | 'revisionsWithheld' | 'deliveries'>;
}) {
  const set = transitionChoicesFor(status, stateLabel, order.lastNormalStatus, makerCleanup?.state ?? 'unknown');
  const offersHold = set.choices.some((choice) => choice.value === 'ON_HOLD');
  // UI batch E (F-06): targets whose evidence the workspace shows missing — warned, never blocked.
  const gaps = evidenceGapsFor(order, workspace, set.choices.map((choice) => choice.value));
  const gapTargets = gaps.map((gap) => gap.target);
  const summaryFields = [
    'to',
    ...(offersHold ? ['holdReason'] : []),
    ...(gaps.length > 0 ? [EVIDENCE_NOTE_FIELD] : [])
  ];
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
            summaryFields,
            // UI batch E (F-18): each reason row only for the target it belongs to.
            summaryWhen: {
              holdReason: { field: 'to', values: ['ON_HOLD'] },
              [EVIDENCE_NOTE_FIELD]: { field: 'to', values: gapTargets }
            }
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
          {offersHold ? (
            // The API refuses a hold without a reason (HOLD_REASON_REQUIRED);
            // the other targets take none, so the field stays folded (one per
            // row would double every row's height). Low-7 (d): choosing
            // 「保留中」 opens it and makes it required; a refusal focuses it.
            <ChoiceDisclosure
              selectName="to"
              value="ON_HOLD"
              fieldName="holdReason"
              summary={`「${stateLabel('ON_HOLD')}」にするときの理由（必須）`}
            >
              <TextareaField
                name="holdReason"
                label={`保留にする理由（「${stateLabel('ON_HOLD')}」を選ぶときは必須）`}
                rows={2}
                width={280}
              />
            </ChoiceDisclosure>
          ) : null}
          {gaps.length > 0 ? (
            <ChoiceDisclosure
              selectName="to"
              value={gapTargets}
              fieldName={EVIDENCE_NOTE_FIELD}
              summary={`証跡がないまま進める場合（${gaps.map((gap) => `「${stateLabel(gap.target)}」`).join('・')}）`}
            >
              {gaps.map((gap) => (
                <p key={gap.target} className="role-notice">
                  {`注意（「${stateLabel(gap.target)}」）: ${gap.message}${EVIDENCE_GAP_SUFFIX}`}
                </p>
              ))}
              <TextareaField
                name={EVIDENCE_NOTE_FIELD}
                label="証跡がないまま進める理由（この選択のときは必須）"
                hint="確認のための入力です。今は履歴には保存されません。証跡があとから届く場合は、その予定を書いてください。"
                rows={2}
                width={280}
              />
            </ChoiceDisclosure>
          ) : null}
        </ActionForm>
      )}
      {status === 'ON_HOLD' ? <HoldReleaseForm order={order} role={role} stateLabel={stateLabel} /> : null}
      {status === 'CANCELLATION_REVIEW' ? (
        <CancellationReviewForm order={order} role={role} stateLabel={stateLabel} makerCleanup={makerCleanup} />
      ) : null}
    </>
  );
}

/**
 * A legacy hold or review whose origin the API has no audit row for: the API
 * then needs the resume target named (HOLD_ORIGIN_UNKNOWN /
 * CANCELLATION_RESUME_REQUIRED) and accepts only DRAFT through
 * MAKER_PO_ACCEPTED. The screen cannot tell such a row apart (it replays all
 * transitions; the API reads only the hold/review event), so the field is
 * always there but folded and blank: nothing is sent unless picked, and with a
 * recorded origin the API refuses any other value.
 */
function LegacyResumeField({ stateLabel, hint }: { stateLabel: (key: string) => string; hint: string }) {
  return (
    <details>
      <summary style={{ fontSize: 13, cursor: 'pointer' }}>前の状態が記録されていない古い発注の場合</summary>
      <SelectField
        name="resumeStatus"
        label="再開する状態（「再開する状態の指定が必要です」と表示されたときだけ選びます）"
        includeBlank
        blankLabel="（選ばない：記録された前の状態に戻す）"
        width={280}
        hint={hint}
        choices={LEGACY_HOLD_RELEASE_TARGETS.map((value) => ({ value, label: stateLabel(value) }))}
      />
    </details>
  );
}

/**
 * Hold release: representative only, reason required. The API returns the
 * order to the state it left (from its own hold audit row) — or to
 * MAKER_PO_READY when the maker paper of that state was cancelled meanwhile —
 * so no target is chosen here, except for a legacy hold (LegacyResumeField).
 */
function HoldReleaseForm({
  order,
  role,
  stateLabel
}: {
  order: FilmSupplyOrderView;
  role: string | null;
  stateLabel: (key: string) => string;
}) {
  return (
    <RoleGate role={role} operation="film_order:release_hold" label="保留の解除">
      <details style={{ marginTop: 8 }} open>
        <summary style={{ fontSize: 13, cursor: 'pointer' }}>保留を解除する（代表者のみ）</summary>
        <ActionForm
          action={releaseFilmOrderHoldAction}
          submitLabel="保留を解除する"
          hint={`理由は必須です（1000字以内）。発注は原則として保留にする前の状態に戻ります。保留中にその段階のメーカー発注書が取り消され、残っている発注書がない場合は「${stateLabel('MAKER_PO_READY')}」（発注書の作成）から再開します。解除に取り消し承認は要りませんが、送信ずみの発注書を取り消した場合、新しい発注書の作成の前に「取り消し承認」の記録が必要です（保留中でもメーカー発注画面で記録できます）。`}
          confirm={{
            title: '保留を解除しますか？',
            body: `発注 ${order.code} の保留を解除し、原則として保留にする前の状態に戻します（保留中にメーカー発注書がすべて取り消された場合は「${stateLabel('MAKER_PO_READY')}」に戻ります）。解除の理由と結果は履歴に記録されます（記録は消えません）。`,
            tone: 'primary',
            facts: holdReleaseFacts(order),
            summaryFields: ['reason', 'resumeStatus']
          }}
        >
          <input type="hidden" readOnly name="orderId" value={order.id} />
          {order.hold ? <p style={noteStyle}>{holdSummaryText(order.hold)}</p> : null}
          <TextareaField name="reason" label="保留解除の理由" required rows={2} width={280} />
          <LegacyResumeField
            stateLabel={stateLabel}
            hint="保留前の状態が記録から分からない場合だけ選んでください。記録と違う状態を選ぶと、解除は記録されません。"
          />
        </ActionForm>
      </details>
    </RoleGate>
  );
}

const CANCELLATION_OUTCOME_CHOICES = [
  { value: 'resume', label: '再開する（取消レビュー前の状態に戻す）' },
  { value: 'cancel', label: '取消で終了する（キャンセル終了・元に戻せません）' }
];

/**
 * Cancellation review resolution: representative only, reason required.
 * resume returns the order to the state it left; cancel ends it for good
 * (CANCELLED — no transition, release or new maker PO afterwards).
 */
function CancellationReviewForm({
  order,
  role,
  stateLabel,
  makerCleanup
}: {
  order: FilmSupplyOrderView;
  role: string | null;
  stateLabel: (key: string) => string;
  makerCleanup: MakerPaperCleanupSummary | undefined;
}) {
  const body = `発注 ${order.code} の取消レビューを、選んだ処理で終えます。「取消で終了する」は元に戻せません（以後、状態の変更・保留の解除・メーカー発注書の作成はできません）。「再開する」は取消レビュー前の状態に戻します。`;
  const warning = makerPaperWarning(makerCleanup);
  return (
    <RoleGate role={role} operation="film_order:resolve_cancellation_review" label="取消レビューの処理">
      <details style={{ marginTop: 8 }} open>
        <summary style={{ fontSize: 13, cursor: 'pointer' }}>取消レビューを処理する（代表者のみ）</summary>
        {warning ? <p className="role-notice">{warning}</p> : null}
        <ChoiceToneActionForm
          selectName="outcome"
          dangerValue="cancel"
          dangerConfirmBody={warning ? `${body}${warning}` : undefined}
          action={resolveCancellationReviewAction}
          submitLabel="取消レビューを処理する"
          hint={`理由は必須です（1000字以内）。「取消で終了する」を選ぶと状態は「${stateLabel('CANCELLED')}」になり、以後この発注は進められません。`}
          confirm={{
            title: '取消レビューを処理しますか？',
            body,
            summaryFields: ['outcome', 'reason', 'resumeStatus']
          }}
        >
          <input type="hidden" readOnly name="orderId" value={order.id} />
          <SelectField
            name="outcome"
            label="処理"
            required
            includeBlank
            blankLabel="（処理を選ぶ）"
            width={280}
            choices={CANCELLATION_OUTCOME_CHOICES}
          />
          <TextareaField name="reason" label="処理の理由" required rows={2} width={280} />
          <LegacyResumeField
            stateLabel={stateLabel}
            hint="「再開する」で、取消レビュー前の状態が記録から分からない場合だけ選んでください（「取消で終了する」では使いません）。"
          />
        </ChoiceToneActionForm>
      </details>
    </RoleGate>
  );
}

/**
 * Recheck 7 Medium-3: ending the order does not touch its maker paper (the
 * server resolves the review without retiring it), so the dialog says what
 * is left before 「取消で終了する」 is confirmed.
 */
function makerPaperWarning(cleanup: MakerPaperCleanupSummary | undefined): string | null {
  if (cleanup === undefined || cleanup.state === 'unknown') {
    return '注意: この発注のメーカー発注書の状態を確認できませんでした。取消で終了しても、メーカー発注書は自動では取り消されません。メーカー発注画面で残っている発注書がないか確認してください。';
  }
  if (cleanup.state === 'none') return null;
  const parts = [
    cleanup.livePapers > 0
      ? `取り消されていないメーカー発注書が${cleanup.livePapers}件あります（メーカーが生産する可能性があります）`
      : null,
    cleanup.acknowledgementPapers > 0
      ? `送信ずみのまま取り消し、取り消し承認が未記録の発注書が${cleanup.acknowledgementPapers}件あります`
      : null
  ].filter((part): part is string => part !== null);
  const stuck = uncancellableLivePapers(cleanup) > 0
    ? `そのうち${uncancellableLivePapers(cleanup)}件は取り消せない状態（送信未確認・受入済み）のため、メーカーへの連絡と対応を代表者が判断してください。`
    : '';
  const records = makerCleanupRecords(cleanup);
  return `注意: ${parts.join('。')}。${stuck}取消で終了しても、メーカー発注書は自動では取り消されません。`
    + (records.length > 0 ? `終了の前後に、メーカー発注画面で${records.join('・')}を記録してください。` : '');
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
