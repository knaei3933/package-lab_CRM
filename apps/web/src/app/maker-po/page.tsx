import type { Metadata } from 'next';
import { ActionForm } from '../../components/ActionForm';
import { MakerPoSendEvidenceForm } from '../../components/MakerPoSendEvidenceForm';
import { OrderCreateForm } from '../../components/OrderCreateForm';
import { OffsetDateTimeField } from '../../components/OffsetDateTimeField';
import { ProjectProgress } from '../../components/ProjectProgress';
import { RoleGate, ViewerPageNotice } from '../../components/RoleGate';
import { TechDetails } from '../../components/TechDetails';
import { SelectField, TextareaField, TextField } from '../../components/fields';
import { callApi, loadSessionUser, readSelectedProjectId } from '../../lib/api';
import {
  hasCancellationAcknowledgement,
  hasVerifiedSendEvent,
  formatMakerPoVerificationChecks,
  isCancellableMakerPoStatus,
  isOrderPastMakerAcceptance,
  loadMakerPoBoard,
  loadMakerPoDetail,
  MAKER_PO_EVENT_TYPE_LABELS,
  MAKER_PO_STATUS_LABELS,
  nextActionForStatus,
  PAYMENT_TERMS_LABELS,
  pendingManualVerificationEvents,
  rejectedSendManualVerifications,
  sendManualVerificationsFromAuditEvents
} from '../../lib/maker-po-data';
import type {
  MakerPoEventRow,
  MakerPoSendManualVerification,
  MakerPoViewRow,
  OrderMakerPoBoard
} from '../../lib/maker-po-data';
import type { AuditEventView } from '../../lib/project-data';
import {
  filmOrderChoiceLabel,
  knownStatus,
  labelLookup,
  NO_PROJECT_SELECTED_MESSAGE,
  sevenPurchaseOrderChoiceLabel,
  STATUS_HIDDEN_NOTICE
} from '../../lib/project-data';
import { canRoleOperate, normalizeRole, operationRefusal } from '../../lib/permissions';
import { shortId } from '../../lib/short-id';
import { roleLabel } from '../../lib/session-display';
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
import {
  DOCUMENT_TYPE_LABELS,
  formatTimestamp,
  MAKER_PO_EVENT_VERIFICATION_LABELS,
  MAKER_PO_MANUAL_VERIFICATION_RESULT_LABELS,
  MAKER_PO_MANUAL_VERIFICATION_RESULTS,
  unitChoices,
  VERIFICATION_STATUS_LABELS
} from '../../lib/vocabulary';
import type { Choice } from '../../lib/types';
import { createFilmSupplyOrderAction } from '../actions';
import {
  acknowledgeMakerPoCancellationAction,
  approveMakerPoAction,
  cancelMakerPoAction,
  createMakerPoAction,
  recordFinalAcceptanceAction,
  recordMakerPoSendEvidenceAction,
  recordProvisionalAcceptanceAction,
  verifyMakerPoSendAction
} from './actions';

export const dynamic = 'force-dynamic';

/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */
export const metadata: Metadata = { title: 'メーカー発注' };

/**
 * M8-OPERATOR S5: メーカー発注オペレーション画面.
 *
 * Screens over the real API: (1) 発注書の作成と一覧, (2) 代表承認 with the
 * G6 payment-gate state, (3) 手動送信記録（原本のEMLをその場で登録できる）, (3′)
 * 送信の手動確認（PENDING_MANUAL_VERIFICATION の代表者確認）, (4) メーカー受入記録
 * split into the provisional staff record and the admin final confirmation, and
 * (5) the role-aware audit dashboard behind the S3 filter. M8-UI2 adds the
 * cancellation work: 発注書の取り消し for live paper — with the sent／unsent
 * distinction the API itself re-derives — and 取り消し承認 for a cancelled paper
 * whose send was proven. Every block shows the NEXT action and the reason the
 * paper is blocked (G6未満・二重承認不足・送信証跡なし・取り消し承認待ち), and
 * the amounts are rendered only for the representative — the API already
 * answers staff and viewer with the filtered view, so a role that cannot see an
 * amount never receives one to render.
 */

const PAYMENT_TERMS_CHOICES: Choice[] = [
  { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
  { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
  { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
];

const MAKER_PO_READY = 'MAKER_PO_READY';

export default async function MakerPoPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>{NO_PROJECT_SELECTED_MESSAGE}</div>;
  }

  const [user, board] = await Promise.all([loadSessionUser(), loadMakerPoBoard(projectId)]);
  const role = user?.role ?? null;
  // UI batch B (④): display-only role checks; representative-only work reads
  // the shared permission helper (canRoleOperate) below, exactly as before.
  const isAdmin = normalizeRole(role) === 'admin';
  const stateLabel = labelLookup(board.workspace.labels, 'filmSupplyOrderStates');
  const poChoices = board.workspace.sevenPurchaseOrders.map((po) => ({
    value: po.id,
    label: sevenPurchaseOrderChoiceLabel(po)
  }));

  const audit = await loadMakerPoAudit(projectId);
  const sendManualVerifications = sendManualVerificationsFromAuditEvents(audit.events);

  const documentVersionChoices = (orderId: string, documentType: string): Choice[] =>
    board.workspace.documents
      .filter((document) => document.documentType === documentType && document.filmSupplyOrderId === orderId)
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        label: `${document.filename}（版${version.versionNumber}／確認状態 ${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${shortId(version.id)}）`
      })));

  // 取り消し承認が引用できる証跡（メーカー側の取消承諾メールなど）は種別を決め
  // つけない。この発注に紐付いた書類バージョンをすべて候補にする（任意入力）。
  const orderDocumentVersionChoices = (orderId: string): Choice[] =>
    board.workspace.documents
      .filter((document) => document.filmSupplyOrderId === orderId)
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        label: `${
          DOCUMENT_TYPE_LABELS[document.documentType as keyof typeof DOCUMENT_TYPE_LABELS] ?? document.documentType
        } ${document.filename}（版${version.versionNumber}／ID ${shortId(version.id)}）`
      })));

  const readyOrders = board.boards.filter((entry) => knownStatus(entry.order) === MAKER_PO_READY);
  // M2: orders whose status the role may not read (viewer) are never "no work".
  const statusHiddenOrders = board.workspace.filmOrders.filter((order) => knownStatus(order) === null).length;

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>メーカー発注（発注書・承認・送信・受入）</h1>
        <ProjectProgress workspace={board.workspace} role={role} currentPath="/maker-po" />
        <ViewerPageNotice role={role} />
        {board.workspace.project ? (
          <p style={noteStyle}>
            案件 {board.workspace.project.code}（{board.workspace.project.name}） ／
            ログイン中の役割: {role === null ? '確認できません' : roleLabel(role)} ／
            金額は代表者にのみ表示されます。
          </p>
        ) : null}
        {board.workspace.error ? <div style={infoBoxStyle}>{board.workspace.error}</div> : null}
      </header>

      <MakerPoCreateSection
        readyOrders={readyOrders}
        isAdmin={isAdmin}
        role={role}
        stateLabel={stateLabel}
        statusHiddenOrders={statusHiddenOrders}
      />

      {/* M8-OPER2 FIX 1: a new order can be created with its G6 terms already set. */}
      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>決済条件を設定して発注を作成する</h2>
        <RoleGate role={role} operation="film_order:create" label="フィルム発注の作成">
          <p style={noteStyle}>
            フィルム発注を作るときに決済条件（G6: 前払い／搬入時払い／未確定）を設定できます。
            決済条件は発注が下書きの間だけ変更でき、ここでの記録は入金確認ではありません
            — 入金の確認は別の手動ステップです。未確定のままでは代表承認（G6）は拒否されます。
          </p>
          <OrderCreateForm
            action={createFilmSupplyOrderAction}
            orderKind="film"
            unitChoices={unitChoices('film')}
            sevenPurchaseOrderChoices={poChoices}
            paymentTermsChoices={PAYMENT_TERMS_CHOICES}
          />
        </RoleGate>
      </div>

      {board.boards.map((entry) => (
        <MakerPoOrderSection
          key={entry.order.id}
          entry={entry}
          isAdmin={isAdmin}
          role={role}
          stateLabel={stateLabel}
          sendEvidenceChoices={documentVersionChoices(entry.order.id, 'send_evidence')}
          acceptanceEvidenceChoices={documentVersionChoices(entry.order.id, 'acceptance_evidence')}
          orderEvidenceChoices={orderDocumentVersionChoices(entry.order.id)}
          sendManualVerifications={sendManualVerifications}
        />
      ))}

      {board.boards.length === 0 && statusHiddenOrders > 0 ? (
        <div style={cardStyle}>
          <p style={noteStyle}>
            {STATUS_HIDDEN_NOTICE}。メーカー発注の作業対象になっている発注があるかどうかは、この画面に表示できません。
          </p>
        </div>
      ) : null}

      {board.boards.length === 0 && statusHiddenOrders === 0 ? (
        <div style={cardStyle}>
          <p style={noteStyle}>
            メーカー発注の作業対象の発注はまだありません。フィルム発注が「{stateLabel(MAKER_PO_READY)}」（校正のダブル承認が完了）に
            なると、この画面に表示されます。製造中・出荷済み・納品済みに進んだ発注も、発注書と承認・送信・受入の
            履歴が読めるままこの画面に表示されます。次のアクション:
            「案件（発注）一覧／作成」画面で承認を進めてください。
          </p>
        </div>
      ) : null}

      <AuditDashboardSection events={audit.events} error={audit.error} role={role} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen 1: 発注書作成 + 一覧
// ---------------------------------------------------------------------------

function MakerPoCreateSection({
  readyOrders,
  isAdmin,
  role,
  stateLabel,
  statusHiddenOrders
}: {
  readyOrders: OrderMakerPoBoard[];
  isAdmin: boolean;
  role: string | null;
  stateLabel: (key: string) => string;
  statusHiddenOrders: number;
}) {
  const orderChoices: Choice[] = readyOrders.map((entry) => ({
    value: entry.order.id,
    label: filmOrderChoiceLabel(entry.order, stateLabel)
  }));

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>① 発注書の作成（メーカー発注書の作成）</h2>
      <p style={noteStyle}>
        校正のダブル承認が完了して「{stateLabel(MAKER_PO_READY)}」になった発注の紙を凍結し、メーカー発注書を作ります。
        作成は代表者だけです（担当者・閲覧者は作成できません）。
      </p>
      {readyOrders.length === 0 && statusHiddenOrders > 0 ? (
        <p style={noteStyle}>{STATUS_HIDDEN_NOTICE}。作成できる発注があるかどうかは表示できません。</p>
      ) : readyOrders.length === 0 ? (
        <p style={noteStyle}>
          作成できる発注（{stateLabel(MAKER_PO_READY)}）はまだありません。ブロック理由: 二重承認不足（顧客とセブン化学の
          ダブル承認が未完了）、または発注自体がまだありません。次のアクション:
          「承認」画面でダブル承認を完了させてください。
        </p>
      ) : (
        <RoleGate role={role} operation="maker_po:create" label="メーカー発注書の作成">
          <ActionForm
            action={createMakerPoAction}
            submitLabel="メーカー発注書を作成する"
            hint="宛先住所はメーカーへの送り先です。金額は代表者のみ入力できます（担当者の画面には金額欄がありません）。"
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <SelectField name="orderId" label="対象のフィルム発注" required choices={orderChoices} width={420} />
              <TextField name="recipientAddress" label="宛先住所（メーカーの送り先）" required width={320} />
              {isAdmin ? (
                <>
                  <TextField name="currency" label="通貨（例 JPY）" width={140} />
                  <TextField name="totalAmount" label="金額（例 480000）" width={180} />
                </>
              ) : null}
            </div>
          </ActionForm>
        </RoleGate>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens 2, 3 and 4: per-order paper
// ---------------------------------------------------------------------------

function MakerPoOrderSection({
  entry,
  isAdmin,
  role,
  stateLabel,
  sendEvidenceChoices,
  acceptanceEvidenceChoices,
  orderEvidenceChoices,
  sendManualVerifications
}: {
  entry: OrderMakerPoBoard;
  isAdmin: boolean;
  role: string | null;
  stateLabel: (key: string) => string;
  sendEvidenceChoices: Choice[];
  acceptanceEvidenceChoices: Choice[];
  orderEvidenceChoices: Choice[];
  sendManualVerifications: MakerPoSendManualVerification[];
}) {
  const gate = entry.paymentGate;
  const list = entry.makerPurchaseOrders;
  // M8-OPER2 FIX 3: an order in the production/shipping/delivery chain has a
  // closed paper. The section answers with the read-only history and never
  // renders the approval / send / acceptance forms again.
  const status = knownStatus(entry.order);
  const pastAcceptance = status !== null && isOrderPastMakerAcceptance(status);

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>
        フィルム発注 {filmOrderChoiceLabel(entry.order, stateLabel)}
        {pastAcceptance ? <span style={noteStyle}> ／ メーカー発注の紙は受入済み（履歴は下に表示）</span> : null}
      </h2>

      {/* G6 payment gate: 決済条件の状態 and the block reason, always visible. */}
      <div style={{ ...infoBoxStyle, borderColor: gate?.gate.satisfied ? 'var(--ok)' : 'var(--danger)', color: gate?.gate.satisfied ? 'var(--ok)' : 'var(--danger)', background: gate?.gate.satisfied ? 'var(--ok-tint)' : 'var(--danger-tint)' }}>
        <strong>決済条件（G6）の状態: </strong>
        {gate ? (
          <>
            {PAYMENT_TERMS_LABELS[gate.paymentTerms] ?? gate.paymentTerms}
            {gate.gate.satisfied
              ? ' ／ ゲート: 満たしています（代表承認の前提を満たしています）'
              : ` ／ ゲート: 満たしていません（ブロック理由: ${gate.gate.reason ?? gate.gate.code ?? '未確定'}）`}
            <div style={noteStyle}>
              入金確認（檢証）: {gate.paymentConfirmedAt ? formatTimestamp(gate.paymentConfirmedAt) : '未確認'}。
              決済条件の記録（前払い・搬入時払い）は入金確認ではありません。入金の確認は、
              専用の確認操作で別に記録する手動のステップです（現在はまだ記録操作がありません）。
            </div>
          </>
        ) : (
          <>決済条件の状態を取得できませんでした。{entry.paymentGateError ?? ''}</>
        )}
      </div>

      {/* UI batch B (L10): the 決済条件 form for a DRAFT order stood here, but this
          board lists only the maker-chain states (MAKER_PO_ORDER_STATES has no
          DRAFT), so it never rendered. G6 terms are recorded on the /orders
          screen while the order is a draft (tests/web-ui-batch-b.test.tsx). */}

      {list.length === 0 ? (
        <p style={noteStyle}>
          この発注のメーカー発注書はまだありません。次のアクション: {canRoleOperate(role, 'maker_po:create')
            ? '上の「① 発注書の作成」で作成してください。'
            : '代表者による発注書の作成を待ちます。'}
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>発注書ID</th>
              <th style={thStyle}>状態</th>
              <th style={thStyle}>発注コード</th>
              {isAdmin ? <th style={thStyle}>金額</th> : null}
              {isAdmin ? <th style={thStyle}>宛先／ダイジェスト</th> : null}
              {!isAdmin ? <th style={thStyle}>宛先</th> : null}
              <th style={thStyle}>代表承認</th>
              <th style={thStyle}>更新</th>
            </tr>
          </thead>
          <tbody>
            {list.map((po) => (
              <tr key={po.id}>
                <td style={tdStyle}>
                  {shortId(po.id)}
                  <TechDetails context="ID">{po.id}</TechDetails>
                </td>
                <td style={tdStyle}>
                  <span style={badgeStyle}>{MAKER_PO_STATUS_LABELS[po.status] ?? po.status}</span>
                  <div style={noteStyle}>{nextActionForStatus(po.status, role ?? 'viewer')}</div>
                </td>
                <td style={tdStyle}>{po.orderCode ?? po.snapshot?.order?.code ?? '—'}</td>
                {isAdmin ? (
                  <td style={tdStyle}>
                    {po.snapshot?.amounts
                      ? `${po.snapshot.amounts.currency} ${po.snapshot.amounts.totalAmount}`
                      : '—'}
                  </td>
                ) : null}
                {isAdmin ? (
                  <td style={tdStyle}>
                    <div>{po.snapshot?.recipient?.address ?? po.recipientAddress ?? '—'}</div>
                    <div style={monoStyle}>{po.snapshotSha256 ? `${po.snapshotSha256.slice(0, 16)}…` : '—'}</div>
                  </td>
                ) : (
                  <td style={tdStyle}>{po.recipientAddress ?? '—'}</td>
                )}
                <td style={tdStyle}>{po.ceoApprovedAt ? formatTimestamp(po.ceoApprovedAt) : '未承認'}</td>
                <td style={tdStyle}>{formatTimestamp(po.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {entry.makerPoError ? <div style={infoBoxStyle}>{entry.makerPoError}</div> : null}

      {pastAcceptance ? (
        // M8-OPER2 FIX 3: read-only history instead of the recording forms.
        <MakerPoHistoryBlock list={list} />
      ) : (
        <>
          {/* Screen 2: 代表承認 */}
          <MakerPoApprovalBlock entry={entry} role={role} />

          {/* Screens 3 and 4, plus the admin cancellation work (M8-UI2) */}
          {list.map((po) => (
            <MakerPoWorkBlocks
              key={po.id}
              po={po}
              role={role}
              sendEvidenceChoices={sendEvidenceChoices}
              acceptanceEvidenceChoices={acceptanceEvidenceChoices}
              orderEvidenceChoices={orderEvidenceChoices}
              sendManualVerifications={sendManualVerifications}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * M8-OPER2 FIX 3: the 発注書・代表承認・送信・受入 history of a closed paper,
 * read from the role-shaped API answer. No form is rendered here: past
 * MAKER_PO_ACCEPTED the paper is done and the screen only reports what happened.
 */
async function MakerPoHistoryBlock({ list }: { list: MakerPoViewRow[] }) {
  if (list.length === 0) {
    return (
      <p style={noteStyle}>
        この発注は受入後の状態（製造中・出荷済み・納品済み）ですが、この画面に表示できるメーカー発注書はまだありません。
      </p>
    );
  }
  const details = await Promise.all(list.map((po) => loadMakerPoDetail(po.id)));

  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>メーカー発注の履歴（発注書・代表承認・送信・受入）</h3>
      <p style={noteStyle}>
        受入済みのため、これ以上の承認・送信・受入の記録操作は表示しません。以下は記録の履歴です。
      </p>
      {list.map((po, index) => {
        const detail = details[index] ?? { purchaseOrder: null, events: [], error: '取得できませんでした。' };
        const sentEvent = detail.events.find((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
        const acceptedEvent = detail.events.find((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED');
        const provisionalEvents = detail.events.filter((event) => event.provisional === true);
        return (
          <div key={po.id} style={{ marginBottom: 12 }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>発注書</th>
                  <th style={thStyle}>状態</th>
                  <th style={thStyle}>発注書の作成</th>
                  <th style={thStyle}>代表承認</th>
                  <th style={thStyle}>送信記録</th>
                  <th style={thStyle}>受入確認（最終）</th>
                  <th style={thStyle}>受入記録（仮）</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={tdStyle}>
                    {shortId(po.id)}
                    <TechDetails context="ID">{po.id}</TechDetails>
                  </td>
                  <td style={tdStyle}>{MAKER_PO_STATUS_LABELS[po.status] ?? po.status}</td>
                  <td style={tdStyle}>{po.createdAt ? formatTimestamp(po.createdAt) : '—'}</td>
                  <td style={tdStyle}>{po.ceoApprovedAt ? formatTimestamp(po.ceoApprovedAt) : '未承認'}</td>
                  <td style={tdStyle}>
                    {sentEvent?.sentAt ? formatTimestamp(sentEvent.sentAt) : '記録なし'}
                  </td>
                  <td style={tdStyle}>
                    {acceptedEvent ? formatTimestamp(acceptedEvent.recordedAt) : '記録なし'}
                  </td>
                  <td style={tdStyle}>
                    {provisionalEvents.length > 0
                      ? `${provisionalEvents.length}件（${provisionalEvents
                          .map((event) => formatTimestamp(event.recordedAt))
                          .join('、')}）`
                      : 'なし'}
                  </td>
                </tr>
              </tbody>
            </table>
            {detail.events.length > 0 ? (
              <details>
                <summary style={{ fontSize: 13, cursor: 'pointer' }}>
                  この発注書の記録イベント（{detail.events.length}件）
                </summary>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                  {detail.events.map((event) => (
                    <li key={event.id}>
                      {MAKER_PO_EVENT_TYPE_LABELS[event.eventType] ?? event.eventType} ／{' '}
                      {formatTimestamp(event.recordedAt)}
                      {event.provisional === true ? '（仮の受入記録）' : ''}
                      {event.verificationStatus
                        ? ` ／ 確認状態: ${MAKER_PO_EVENT_VERIFICATION_LABELS[event.verificationStatus] ?? event.verificationStatus}`
                        : ''}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {detail.error ? <div style={infoBoxStyle}>{detail.error}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function MakerPoApprovalBlock({ entry, role }: { entry: OrderMakerPoBoard; role: string | null }) {
  const canApprove = canRoleOperate(role, 'ceo_approve');
  const pending = entry.makerPurchaseOrders
    .filter((po) => po.status === 'DRAFT' || po.status === 'SNAPSHOT_VOIDED');
  if (pending.length === 0) return null;
  const gate = entry.paymentGate;
  const gateBlocks = gate !== null && !gate.gate.satisfied;

  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>② 代表承認（代表者のみ）</h3>
      <p style={noteStyle}>
        承認は凍結されたスナップショットのダイジェストに対して行われます。ブロック理由:
        {gateBlocks ? ' G6未満（決済条件が未確定）' : ''}
        {pending.some((po) => po.status === 'SNAPSHOT_VOIDED') ? ' スナップショット失効（再承認が必要）' : ''}
        {!gateBlocks ? ' なし（前提を満たしています）' : ''}
      </p>
      {pending.map((po) => (
        <div key={po.id} style={{ marginBottom: 12 }}>
          {canApprove ? (
            <ActionForm
              action={approveMakerPoAction}
              submitLabel="代表承認を記録する"
              hint="決済条件が未確定のまま実行すると、APIが G6 のブロック理由を返します。"
            >
              <input type="hidden" readOnly name="poId" value={po.id} />
            </ActionForm>
          ) : (
            <p className="role-notice">
              メーカー発注書 {shortId(po.id)} は代表承認待ちです。{operationRefusal(role, 'ceo_approve', '代表承認')}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * M8-UI2: the per-paper work area. One read of the event trail feeds every
 * block — the send registration, the representative's manual confirmation of a
 * pending send, the two-step acceptance, and the cancellation work (取消とその
 * 承認). The blocks appear from the paper's own state and events, so a form
 * the API would refuse is never offered, and every refusal the API does return
 * is what the operator reads next to the button.
 */
async function MakerPoWorkBlocks({
  po,
  role,
  sendEvidenceChoices,
  acceptanceEvidenceChoices,
  orderEvidenceChoices,
  sendManualVerifications
}: {
  po: MakerPoViewRow;
  role: string | null;
  sendEvidenceChoices: Choice[];
  acceptanceEvidenceChoices: Choice[];
  orderEvidenceChoices: Choice[];
  sendManualVerifications: MakerPoSendManualVerification[];
}) {
  const detail = await loadMakerPoDetail(po.id);
  const events = detail.events;
  const pendingVerifications = pendingManualVerificationEvents(events, sendManualVerifications);
  const eventIds = new Set(events.map((event) => event.id));
  const rejectedVerifications = rejectedSendManualVerifications(sendManualVerifications)
    .filter((verification) => eventIds.has(verification.makerPoEventId));
  const verifiedSend = hasVerifiedSendEvent(events);
  const acknowledgementRecorded = hasCancellationAcknowledgement(events);
  // UI batch B (④): the representative-only blocks, through the shared helper.
  const canVerifySend = canRoleOperate(role, 'maker_po:verify_send');
  const canCancel = canRoleOperate(role, 'maker_po:cancel');

  return (
    <>
      {detail.error ? <div style={infoBoxStyle}>{detail.error}</div> : null}

      {po.status === 'APPROVED_FOR_MANUAL_SEND' ? (
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
          <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>③ 手動送信記録（担当者・代表者が記録）</h3>
          <RoleGate role={role} operation="maker_po:send_evidence" label="送信の記録">
            <p style={noteStyle}>
              送信はシステムの外（メール）で行うので、ここでは証跡を記録します。宛先は発注書の宛先住所と一致が必要です。
              送信証跡は Thunderbirdの送信済みフォルダから書き出した原本のEML（.eml）です。PDFやスクリーンショット、
              メモでは送信は「確認済み」になりません。
            </p>
            <MakerPoSendEvidenceForm
              action={recordMakerPoSendEvidenceAction}
              poId={po.id}
              sendEvidenceChoices={sendEvidenceChoices}
              recipientAddress={po.recipientAddress ?? null}
              ceoApprovedAt={po.ceoApprovedAt ?? null}
              orderCode={po.orderCode ?? po.snapshot?.order?.code ?? null}
            />
            {sendEvidenceChoices.length === 0 ? (
              <p style={noteStyle}>
                参考: 「文書」画面に登録済みの送信証跡の書類はまだありません。原本を上のフォームで直接
                選ぶ場合は事前の登録は不要です。文書画面から登録するときは形式に「メール原文（EML）」を選んでください。
              </p>
            ) : null}
          </RoleGate>
        </div>
      ) : null}

      {canVerifySend && pendingVerifications.length > 0 ? (
        <MakerPoManualVerificationBlock poId={po.id} events={pendingVerifications} />
      ) : null}

      {canVerifySend && rejectedVerifications.length > 0 ? (
        <p style={noteStyle}>
          手動確認履歴（却下）: {rejectedVerifications.map((verification, index) => (
            <span key={`${verification.makerPoEventId}:${index}`}>
              <span style={monoStyle}>{shortId(verification.makerPoEventId)}</span>
              ／{MAKER_PO_MANUAL_VERIFICATION_RESULT_LABELS[verification.result]}
              ／{verification.verifierName ?? '—'}
              ／{formatTimestamp(verification.verifiedAt ?? verification.recordedAt)}
              {verification.reasonNote ? `／根拠: ${verification.reasonNote}` : ''}
            </span>
          ))}
        </p>
      ) : null}

      {po.status === 'MAKER_PO_SENT_MANUALLY' ? (
        <MakerPoAcceptanceBlock
          po={po}
          role={role}
          events={events}
          acceptanceEvidenceChoices={acceptanceEvidenceChoices}
        />
      ) : null}

      {canCancel && isCancellableMakerPoStatus(po.status) ? (
        <MakerPoCancelBlock po={po} verifiedSend={verifiedSend} />
      ) : null}

      {canCancel && po.status === 'CANCELLED' && verifiedSend && !acknowledgementRecorded ? (
        <MakerPoCancellationAcknowledgementBlock
          po={po}
          orderEvidenceChoices={orderEvidenceChoices}
        />
      ) : null}

      {canCancel && po.status === 'CANCELLED' && verifiedSend && acknowledgementRecorded ? (
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
          <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>取り消し承認（メーカー取消確認）: 記録済み</h3>
          <p style={noteStyle}>
            送信ずみの発注書の取消に対する取り消し承認は記録済みです。次のアクション:
            訂正後の発注書を新しく作成してください（①の作成フォームから）。
          </p>
        </div>
      ) : null}
    </>
  );
}

/**
 * M8-UI2: the representative's confirmation of a send the EML check could not
 * settle (PENDING_MANUAL_VERIFICATION). The block shows why the check waited
 * (verificationNote と機械読み取りのチェック一覧) so the human confirms against
 * the original, and posts the four fields the endpoint records: result,
 * verifierName, verifiedAt, reasonNote.
 */
function MakerPoManualVerificationBlock({ poId, events }: { poId: string; events: MakerPoEventRow[] }) {
  const resultChoices = MAKER_PO_MANUAL_VERIFICATION_RESULTS.map((value) => ({
    value,
    label: MAKER_PO_MANUAL_VERIFICATION_RESULT_LABELS[value] ?? value
  }));

  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>③′ 送信の手動確認（代表者のみ）</h3>
      <p style={noteStyle}>
        メールの自動検証が断定できなかった送信記録です。原本のEMLと発注内容を見比べて、
        納品を断定する（確認）か断定しない（却下）かを代表者が記録します。確認の
        記録は取り消せません（訂正は新しい記録として残します）。確認は発注書を受入確認待ちまで進めます。
      </p>
      {events.map((event) => (
        <div key={event.id} style={{ marginBottom: 16 }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>送信イベント</th>
                <th style={thStyle}>確認状態</th>
                <th style={thStyle}>送信日時</th>
                <th style={thStyle}>送信元</th>
                <th style={thStyle}>宛先</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={tdStyle}>
                  {shortId(event.id)}
                  <TechDetails context="ID">{event.id}</TechDetails>
                </td>
                <td style={tdStyle}>
                  {MAKER_PO_EVENT_VERIFICATION_LABELS[event.verificationStatus ?? ''] ?? event.verificationStatus}
                </td>
                <td style={tdStyle}>{event.sentAt ? formatTimestamp(event.sentAt) : '—'}</td>
                <td style={tdStyle}>{event.senderAddress ?? '—'}</td>
                <td style={tdStyle}>{(event.recipients ?? []).join('、') || '—'}</td>
              </tr>
            </tbody>
          </table>
          {event.verificationNote ? (
            <p style={noteStyle}>待っている理由: {event.verificationNote}</p>
          ) : null}
          {Array.isArray(event.verificationChecks) && event.verificationChecks.length > 0 ? (
            <div style={noteStyle}>
              自動チェックの結果: {event.verificationChecks.length}件
              <TechDetails context="チェック項目">{formatMakerPoVerificationChecks(event.verificationChecks).join('、')}</TechDetails>
            </div>
          ) : null}
          <ActionForm
            action={verifyMakerPoSendAction}
            submitLabel="手動確認を記録する"
            hint="検証者名・検証日時・結果・根拠はAPIの必須項目です。根拠には何を確認したか（原本の何を見たか）を書いてください。"
          >
            <input type="hidden" readOnly name="eventId" value={event.id} />
            <input type="hidden" readOnly name="poId" value={poId} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <SelectField name="result" label="確認結果" required choices={resultChoices} width={300} />
              <TextField name="verifierName" label="検証者名" required width={220} />
              <OffsetDateTimeField name="verifiedAt" label="検証日時" required width={240} />
              <TextareaField
                name="reasonNote"
                label="根拠（何を確認して納品を断定したか）"
                required
                rows={3}
                width={520}
              />
            </div>
          </ActionForm>
        </div>
      ))}
    </div>
  );
}

/**
 * M8-UI2: the cancel control for live paper. The hint states which
 * cancellation this is before the button is pressed: unsent paper is an
 * internal correction (the ordering step re-opens at once), paper whose send
 * was proven has already left the company, so cancelling it keeps the step
 * closed until the 取り消し承認 is recorded. SEND_UNVERIFIED and accepted
 * paper offer no button at all — the API refuses them.
 */
function MakerPoCancelBlock({ po, verifiedSend }: { po: MakerPoViewRow; verifiedSend: boolean }) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>発注書の取り消し（代表者のみ）</h3>
      <div style={{ ...infoBoxStyle, borderColor: verifiedSend ? 'var(--danger)' : 'var(--ok)', color: verifiedSend ? 'var(--danger)' : 'var(--ok)', background: verifiedSend ? 'var(--danger-tint)' : 'var(--ok-tint)' }}>
        <strong>この発注書の送信状態: </strong>
        {verifiedSend
          ? '送信ずみ（送信証跡が確認されています）。取り消すと生産手順の再開には「取り消し承認（メーカー取消確認）」が必要です。'
          : '未送信（送信証跡の確認はありません）。取り消すとすぐに発注の作成ステップが再度開きます。'}
      </div>
      <p style={noteStyle}>
        取り消しは記録を消しません（取消イベントと履歴が残ります）。訂正後の発注書は新しい発注書として作成します。
        送信未確認の発注書は取り消せません。受入確認済みの発注書も取り消せません。
      </p>
      <ActionForm
        action={cancelMakerPoAction}
        submitLabel="発注書を取り消す"
        hint="取消理由（note）はAPIの必須項目です。訂正・再発注の理由を記録してください。"
      >
        <input type="hidden" readOnly name="poId" value={po.id} />
        <TextareaField name="note" label="取消理由（訂正・再発注の理由）" required rows={3} width={520} />
      </ActionForm>
    </div>
  );
}

/**
 * M8-UI2: the representative's acknowledgement of a cancelled paper whose send
 * was proven (取消承認／メーカー取消確認). It is the record that re-opens the
 * ordering step: until it exists the create form refuses a replacement paper,
 * so sent paper and its replacement are never in production at the same time.
 */
function MakerPoCancellationAcknowledgementBlock({
  po,
  orderEvidenceChoices
}: {
  po: MakerPoViewRow;
  orderEvidenceChoices: Choice[];
}) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>取り消し承認を記録する（メーカー取消確認・代表者のみ）</h3>
      <p style={noteStyle}>
        この発注書は送信ずみのまま取り消されています。発注先（メーカー）が取り消しを受け入れたことを代表者が確認して
        「取り消し承認」を記録してください。承認の記録まで、この発注の新しい発注書は作成できません
        （作成フォームは API が「まず取り消し承認を記録してください」と返します）。
      </p>
      <ActionForm
        action={acknowledgeMakerPoCancellationAction}
        submitLabel="取り消し承認を記録する"
        hint="承認理由（note）はAPIの必須項目です。メーカー側の承諾メールの原本を文書画面に登録してある場合は、その書類バージョンを引用できます（任意）。"
      >
        <input type="hidden" readOnly name="poId" value={po.id} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <TextareaField name="note" label="承認理由（取り消しを確認した根拠）" required rows={3} width={520} />
          <OffsetDateTimeField name="acknowledgedAt" label="承認日時（任意）" width={240} />
          <SelectField
            name="evidenceDocumentVersionId"
            label="メーカー側の承諾を示す書類バージョン（任意）"
            includeBlank
            choices={orderEvidenceChoices}
            width={420}
          />
        </div>
      </ActionForm>
    </div>
  );
}

function MakerPoAcceptanceBlock({
  po,
  role,
  events,
  acceptanceEvidenceChoices
}: {
  po: MakerPoViewRow;
  role: string | null;
  events: MakerPoEventRow[];
  acceptanceEvidenceChoices: Choice[];
}) {
  const provisionalCount = events.filter((event) => event.provisional === true).length;
  const provisionalRecords: MakerPoEventRow[] = events.filter((event) => event.provisional === true);
  const canAcceptFinal = canRoleOperate(role, 'maker_po:accept_evidence');

  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>④ メーカー受入記録</h3>
      <p style={noteStyle}>
        受入は二段階です。まず担当者が「受入記録（仮）」を書き、そのあと代表者が受領証跡を検証して
        「最終受入確認」を記録します。仮の記録だけでは発注書は受入済みになりません。
      </p>
      <p style={noteStyle}>
        仮の受入記録: {provisionalCount}件
        {provisionalCount > 0 ? (
          <span style={monoStyle}>
            {' '}（{provisionalRecords.map((event) => formatTimestamp(event.recordedAt)).join('、')}）
          </span>
        ) : (
          ' ／ 次のアクション: 担当者が受入記録（仮）を記録してください。'
        )}
      </p>

      <RoleGate role={role} operation="maker_po:accept_provisional" label="受入記録（仮）">
        <details style={{ marginBottom: 12 }} open={provisionalCount === 0}>
          <summary style={{ fontSize: 13, cursor: 'pointer' }}>受入記録（仮）を書く（担当者・代表者）</summary>
          <ActionForm
            action={recordProvisionalAcceptanceAction}
            submitLabel="受入記録（仮）を記録する"
            hint="この記録は「仮」と明示され、発注書の状態は動きません。最終受入確認は代表者だけが記録できます。"
          >
            <input type="hidden" readOnly name="poId" value={po.id} />
            <OffsetDateTimeField name="acceptedAt" label="メーカー受入の日時" width={240} />
          </ActionForm>
        </details>
      </RoleGate>

      {canAcceptFinal ? (
        acceptanceEvidenceChoices.length === 0 ? (
          <p style={noteStyle}>
            最終受入確認のブロック理由: 受領証跡の書類バージョンがありません。
            次のアクション: 「文書」画面で受領証跡をアップロードし、確認済みにしてください。
          </p>
        ) : (
          <details>
            <summary style={{ fontSize: 13, cursor: 'pointer' }}>最終受入確認を記録する（代表者のみ）</summary>
            <ActionForm
              action={recordFinalAcceptanceAction}
              submitLabel="最終受入確認を記録する"
              hint={
                provisionalCount > 0
                  ? `仮の受入記録が ${provisionalCount}件 あります。最終確認はその記録を引き継いで確定します。`
                  : '仮の受入記録がなくても最終確認は可能です（記録には事前に確認済みの受領証跡が必要です）。'
              }
            >
              <input type="hidden" readOnly name="poId" value={po.id} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <SelectField
                  name="evidenceDocumentVersionId"
                  label="受領証跡の書類バージョン（確認済み）"
                  required
                  choices={acceptanceEvidenceChoices}
                  width={420}
                />
                <OffsetDateTimeField name="acceptedAt" label="受入日時" width={240} />
              </div>
            </ActionForm>
          </details>
        )
      ) : (
        <p className="role-notice">{operationRefusal(role, 'maker_po:accept_evidence', '最終受入確認')}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 5: role-aware audit dashboard (the API answers through the S3 filter)
// ---------------------------------------------------------------------------

interface MakerPoAuditPayload {
  events: AuditEventView[];
  error: string | null;
}

async function loadMakerPoAudit(projectId: string): Promise<MakerPoAuditPayload> {
  const base = `/api/projects/${encodeURIComponent(projectId)}/audit-history`;
  const [poEvents, makerEvents] = await Promise.all([
    callApi<{ events: AuditEventView[] }>(`${base}?entityType=maker_purchase_order&limit=200`),
    callApi<{ events: AuditEventView[] }>(`${base}?entityType=maker_po_event&limit=200`)
  ]);
  if (!poEvents.ok && !makerEvents.ok) {
    return { events: [], error: poEvents.error ?? makerEvents.error ?? '監査履歴が取得できませんでした。' };
  }
  // M8-UI3 FIX 1: the spread of a non-array answer (`...(data.events)`) throws
  // and, because this read happens on the /maker-po stream, the operator only
  // sees Next.js' opaque client-exception screen. The API returns `events` as
  // an array, but an answer that is not one must degrade to an empty dashboard,
  // never to a thrown page.
  const poRows = poEvents.ok && poEvents.data && Array.isArray(poEvents.data.events) ? poEvents.data.events : [];
  const makerRows = makerEvents.ok && makerEvents.data && Array.isArray(makerEvents.data.events)
    ? makerEvents.data.events
    : [];
  const events = [...poRows, ...makerRows].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  return { events, error: null };
}

/** UI batch B (⑤): the audit rows' entity types and the actions the event-type labels do not name. */
const AUDIT_ENTITY_LABELS: Readonly<Record<string, string>> = {
  maker_purchase_order: 'メーカー発注書',
  maker_po_event: 'メーカー発注書の記録'
};

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  MAKER_PO_CREATED: 'メーカー発注書の作成',
  MAKER_PO_CEO_APPROVED: '代表承認',
  MAKER_PO_STATUS_CHANGED: '状態の変更',
  MAKER_PO_DUAL_APPROVAL_RECHECK: 'ダブル承認の再確認',
  MAKER_PO_SEND_EVIDENCE_REGISTERED: '送信証跡の記録（確認済み）',
  MAKER_PO_SEND_PENDING_MANUAL_VERIFICATION: '送信証跡の記録（手動確認待ち）',
  MAKER_PO_SEND_RECORDED_UNVERIFIED: '送信証跡の記録（未確認）',
  MAKER_PO_SEND_REJECTED: '送信却下',
  MAKER_PO_SNAPSHOT_VOIDED: 'スナップショット失効',
  MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED: '送信の手動確認',
  MAKER_PO_ACCEPT_RECORDED_PROVISIONAL: '受入記録（仮）',
  MAKER_PO_ACCEPT_EVIDENCE_REGISTERED: '受入証跡の記録（最終）',
  MAKER_PO_CANCELLED: '発注取消',
  MAKER_CANCELLATION_ACKNOWLEDGED: '取り消し承認（メーカー取消確認）'
};

function AuditDashboardSection({
  events,
  error,
  role
}: {
  events: AuditEventView[];
  error: string | null;
  role: string | null;
}) {
  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>⑤ 監査ダッシュボード（役割に応じた表示）</h2>
      <p style={noteStyle}>
        監査履歴をメーカー発注の記録だけに絞って表示します。
        表示内容は API が役割ごとに決めます: 代表者は金額やスナップショットまで、担当者は状態の形だけ、
        閲覧者は概要だけを見ます。現在の役割: {role === null ? '確認できません' : roleLabel(role)}。
      </p>
      {error ? <div style={infoBoxStyle}>{error}</div> : null}
      {events.length === 0 ? (
        <p style={noteStyle}>メーカー発注の監査記録はまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>日時</th>
              <th style={thStyle}>記録の内容</th>
              <th style={thStyle}>種別</th>
              <th style={thStyle}>状態（役割に見える範囲）</th>
              <th style={thStyle}>実行者</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const after = (event.afterState ?? null) as Record<string, unknown> | null;
              const status = after && typeof after.status === 'string' ? after.status : null;
              return (
                <tr key={event.id}>
                  <td style={tdStyle}>{formatTimestamp(event.occurredAt)}</td>
                  <td style={tdStyle}>
                    {AUDIT_ACTION_LABELS[event.action] ?? MAKER_PO_EVENT_TYPE_LABELS[event.action] ?? event.action}
                  </td>
                  <td style={tdStyle}>
                    {AUDIT_ENTITY_LABELS[event.entityType] ?? event.entityType}
                    <TechDetails context="コード・ID">
                      <p>{event.action}</p>
                      <p>{event.entityId}</p>
                    </TechDetails>
                  </td>
                  <td style={tdStyle}>
                    {status ? MAKER_PO_STATUS_LABELS[status] ?? status : '—'}
                    {after && after.provisional === true ? '（仮の受入記録を含む）' : ''}
                  </td>
                  <td style={tdStyle}>{event.actor?.displayName ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
