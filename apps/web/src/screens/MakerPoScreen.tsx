import type { Metadata } from 'next';
import Link from 'next/link';
import { webErrorText } from '../lib/error-dictionary';
import { EXPECTED_TERMS_MISSING_MESSAGE } from '../lib/form-messages';
import { ActionForm } from '../components/ActionForm';
import { MakerPoSendEvidenceForm } from '../components/MakerPoSendEvidenceForm';
import { OrderCreateForm } from '../components/OrderCreateForm';
import { OffsetDateTimeField } from '../components/OffsetDateTimeField';
import { ProjectProgress } from '../components/ProjectProgress';
import { ProjectUnavailable } from '../components/ProjectUnavailable';
import type { ProjectScreenProps } from './screen-props';
import { DataTable } from '../components/DataTable';
import { RecipientChooser } from '../components/RecipientChooser';
import { RoleGate, ViewerPageNotice } from '../components/RoleGate';
import { StatusBadge } from '../components/StatusBadge';
import { TechDetails } from '../components/TechDetails';
import { SelectField, TextareaField, TextField } from '../components/fields';
import { callApi, loadSessionUser } from '../lib/api';
import {
  acknowledgementBlocksCreation,
  acknowledgementEvidenceDocuments,
  acknowledgementKindsFromAuditEvents,
  acknowledgementOwed,
  cancellationAcknowledgementFlags,
  cancellationAcknowledgementKind,
  cancellationAcknowledgementLabel,
  cancellationAcknowledgementMayBeRequired,
  cleanupNextActionForStatus,
  hasMakerPaperCleanup,
  MAKER_PO_AUDIT_WINDOW,
  makerPaperCleanupSummary,
  makerPaperCleanupWork,
  hasCancellationAcknowledgement,
  formatMakerPoVerificationChecks,
  isCancellableMakerPoStatus,
  isOrderPastMakerAcceptance,
  loadMakerPoBoard,
  loadMakerPoDetail,
  makerPoName,
  makerPoNumberOf,
  loadManualVerificationsForEvents,
  makerPoSendProof,
  MAKER_PO_EVENT_TYPE_LABELS,
  MAKER_PO_STATUS_LABELS,
  nextActionForStatus,
  offersPostDeliveryConfirmation,
  PAYMENT_TERMS_LABELS,
  pendingManualVerificationEvents,
  cancelSendStateCopy,
  rejectedSendManualVerifications,
  sendEventsWithoutKnownDecision,
  sendManualVerificationsFromAuditEvents,
  undisclosedSendDecisionEventIds,
  unsettledSendsOfCancelledPaper
} from '../lib/maker-po-data';
import type {
  CancellationAcknowledgementKind,
  CancelSendStateCopy,
  MakerPaperJudgement,
  MakerPoOrderClosure,
  MakerPoEventRow,
  MakerPoSendProof,
  MakerPoSendManualVerification,
  MakerPoViewRow,
  OrderMakerPoBoard
} from '../lib/maker-po-data';
import { makerPoStages, paymentGateDecides, stageHeadline, stageLabel, upcomingStagesLine } from '../lib/maker-po-stage';
import type { MakerPoStageKey, MakerPoStagePaper, MakerPoStageView } from '../lib/maker-po-stage';
import type { AuditEventView } from '../lib/project-data';
import { loadMakerRecipients } from '../lib/maker-master';
import type { RecipientChoices } from '../lib/maker-master';
import {
  filmOrderChoiceLabel,
  knownStatus,
  labelLookup,
  NO_PROJECT_SELECTED_MESSAGE,
  sevenPurchaseOrderChoiceLabel,
  STATUS_HIDDEN_NOTICE
} from '../lib/project-data';
import { canRoleOperate, normalizeRole, operationRefusal } from '../lib/permissions';
import { shortId } from '../lib/short-id';
import { roleLabel } from '../lib/session-display';
import { cardStyle, infoBoxStyle, monoStyle, noteStyle, tdStyle, thStyle } from '../lib/ui';
import { orderPath, projectPath } from '../lib/project-route';
import {
  DOCUMENT_TYPE_LABELS,
  formatMoney,
  formatTimestamp,
  MAKER_PO_EVENT_VERIFICATION_LABELS,
  MAKER_PO_MANUAL_VERIFICATION_RESULT_LABELS,
  MAKER_PO_MANUAL_VERIFICATION_RESULTS,
  unitChoices,
  VERIFICATION_STATUS_LABELS
} from '../lib/vocabulary';
import type { Choice } from '../lib/types';
import { createFilmSupplyOrderAction } from '../app/actions';
import {
  acknowledgeMakerPoCancellationAction,
  cancelMakerPoAction,
  createMakerPoAction,
  recordFinalAcceptanceAction,
  recordMakerPoSendEvidenceAction,
  recordProvisionalAcceptanceAction,
  verifyMakerPoSendAction
} from '../app/maker-po/actions';

/** P0 review M1: shown in place of the approval form when the 支払条件 could not be read. */
const APPROVAL_HELD_NO_TERMS = EXPECTED_TERMS_MISSING_MESSAGE;

/** P0 R09: the payment-gate block in operator words (never the API's English reason or a code). */
function paymentGateBlockText(code: string | null | undefined): string {
  return code ? webErrorText(code).message : '支払条件が「未定」です';
}


/** UI batch A: per-screen tab title (layout template adds 「｜KANEI CRM」). */

/**
 * M8-OPERATOR S5: メーカー発注オペレーション画面.
 *
 * Screens over the real API: (1) 発注書の作成と一覧, (2) 代表承認 with the
 * G6 payment-gate state, (3) 送信の記録（原本のEMLをその場で登録できる）, (3′)
 * 送信の手動確認（PENDING_MANUAL_VERIFICATION の代表者確認）, (4) メーカー受入記録
 * split into the provisional staff record and the admin final confirmation, and
 * (5) the role-aware audit dashboard behind the S3 filter. M8-UI2 adds the
 * cancellation work: 発注書の取り消し for live paper — with the sent／unsent
 * distinction the API itself re-derives — and 取り消し承認 for a cancelled paper
 * whose send was proven. Every block shows the NEXT action and the reason the
 * paper is blocked (G6未満・両組織の承認不足・送信証跡なし・取り消し承認待ち), and
 * the amounts are rendered only for the representative — the API already
 * answers staff and viewer with the filtered view, so a role that cannot see an
 * amount never receives one to render.
 */

/** UI batch E (F-15): the currencies a maker paper is written in (JPY first, the usual one). */
const CURRENCY_CHOICES = [
  { value: 'JPY', label: '日本円（JPY）' },
  { value: 'USD', label: '米ドル（USD）' },
  { value: 'CNY', label: '人民元（CNY）' },
  { value: 'KRW', label: '韓国ウォン（KRW）' }
];

const PAYMENT_TERMS_CHOICES: Choice[] = [
  { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
  { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
  { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
];

const MAKER_PO_READY = 'MAKER_PO_READY';

export async function MakerPoScreen({ projectId, projectCode }: ProjectScreenProps) {

  const [user, board] = await Promise.all([loadSessionUser(), loadMakerPoBoard(projectId)]);
  // UI batch E (F-12): a remembered project the API no longer opens — no forms, only the way out.
  if (board.workspace.projectRefused) return <ProjectUnavailable title="メーカー発注（発注書・承認・送信・受入）" reason={board.workspace.error} returnTo="/maker-po" />;
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
  // One read of every paper's trail feeds the create section (Low-7 f), the
  // cleanup filter (Medium-3) and the cards.
  const allCards = await Promise.all(board.boards.map((entry) => loadOrderPapers(entry, {
    role,
    projectId,
    sendManualVerifications,
    cancellationFlags: cancellationAcknowledgementFlags(audit.events),
    acknowledgementKinds: acknowledgementKindsFromAuditEvents(audit.events),
    undisclosedDecisions: undisclosedSendDecisionEventIds(audit.events),
    auditWindowComplete: audit.makerEventsComplete
  })));
  // Medium-3: a cancelled or frozen order is on the board only while its
  // maker paper still needs cleaning up (or its list could not be read).
  // The 次にやること card (ProjectProgress) reads the same judgement.
  const workspace = {
    ...board.workspace,
    makerPaperCleanup: Object.fromEntries(allCards
      .filter((card) => card.entry.closure !== null)
      .map((card) => [card.entry.order.id, makerPaperCleanupSummary(judged(card.papers), card.entry.makerPoError !== null)]))
  };
  const cards = allCards.filter((card) => card.entry.closure === null
    || card.entry.makerPoError !== null
    || hasMakerPaperCleanup(makerPaperCleanupWork(judged(card.papers))));

  const documentVersionChoices = (orderId: string, documentType: string): Choice[] =>
    board.workspace.documents
      .filter((document) => document.documentType === documentType && document.filmSupplyOrderId === orderId)
      // UI batch E (review M2): the final acceptance cites a checked 受領証跡 only (the API
      // refuses an unchecked one), so an upload still 未確認 neither opens that form nor
      // hides the 「確認済みにしてください」 step.
      .filter((document) => documentType !== 'acceptance_evidence'
        || (!document.verificationHidden && document.verificationStatus === 'verified'))
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        label: `${document.filename}（版${version.versionNumber}／確認状態 ${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${shortId(version.id)}）`
      })));

  // 取り消し承認が引用できる証跡（メーカー側の取消承諾メールなど）は種別を決め
  // つけない（任意入力）。ただし API は同じ発注・同じメーカー発注書に紐付いた
  // 書類だけを受け付ける（Low-6: MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH）ので、
  // その発注書に紐付いた書類バージョンだけを候補にする。
  const acknowledgementEvidenceChoices = (orderId: string, poId: string): Choice[] =>
    acknowledgementEvidenceDocuments(board.workspace.documents, orderId, poId)
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        label: `${
          DOCUMENT_TYPE_LABELS[document.documentType as keyof typeof DOCUMENT_TYPE_LABELS] ?? document.documentType
        } ${document.filename}（版${version.versionNumber}／ID ${shortId(version.id)}）`
      })));

  const readyCards = cards.filter((card) => knownStatus(card.entry.order) === MAKER_PO_READY);
  // Low-7 (f): the API refuses a new paper while a proven send was cancelled
  // without its 取り消し承認, so such an order is not offered for creation.
  // UI batch E (F-21): an order that already has a live paper (anything but 取消)
  // is not offered again — the API refuses a second one (MAKER_PO_ALREADY_EXISTS).
  const hasLivePaper = (card: (typeof readyCards)[number]) =>
    card.entry.makerPoError === null && card.entry.makerPurchaseOrders.some((po) => po.status !== 'CANCELLED');
  const readyOrders = readyCards
    .filter((card) => !acknowledgementBlocksCreation(judged(card.papers)) && !hasLivePaper(card))
    .map((card) => card.entry);
  const alreadyCreatedOrders = readyCards.filter(hasLivePaper).map((card) => card.entry);
  // UI batch E (F-15) → P2 R33 (DESIGN §4): the latest paper's address on this project is no
  // longer typed in for the operator (a wrong maker's address would go out); when it is not one
  // of the master addresses it is shown as a hint of 「直接入力する」 only.
  const latestRecipientAddress = cards
    .flatMap((card) => card.entry.makerPurchaseOrders)
    // Review L1: a cancelled paper may have been cancelled for its wrong address.
    .filter((po) => po.status !== 'CANCELLED')
    .map((po) => ({ at: po.createdAt ?? '', address: po.snapshot?.recipient?.address ?? po.recipientAddress ?? null }))
    .filter((row): row is { at: string; address: string } => typeof row.address === 'string' && row.address.length > 0)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.address;
  // P2 R33: the maker's addresses, read only when this role is offered the create form.
  const recipients: RecipientChoices = readyOrders.length > 0 && canRoleOperate(role, 'maker_po:create')
    ? await loadMakerRecipients(projectId)
    : { kind: 'not_loaded' };
  const previousTypedRecipient = latestRecipientAddress
    && !(recipients.kind === 'list' && recipients.addresses.some((address) => address.email.toLowerCase() === latestRecipientAddress.toLowerCase()))
    ? latestRecipientAddress
    : null;
  const acknowledgementBlockedOrders = readyCards
    .filter((card) => acknowledgementBlocksCreation(judged(card.papers)))
    .map((card) => card.entry);
  // M2: orders whose status the role may not read (viewer) are never "no work".
  const statusHiddenOrders = board.workspace.filmOrders.filter((order) => knownStatus(order) === null).length;

  return (
    <section className="sx-11bfff5">
      <header>
        <h1 className="sx-15b888e">メーカー発注（発注書・承認・送信・受入）</h1>
        <ProjectProgress workspace={workspace} role={role} currentPath="/maker-po" projectCode={projectCode} />
        <ViewerPageNotice role={role} />
        {board.workspace.project ? (
          <p className="ui-note">
            案件 {board.workspace.project.code}（{board.workspace.project.name}） ／
            ログイン中の役割: {role === null ? '確認できません' : roleLabel(role)}
            {/* DESIGN 共通ルール: no amount wording at all on a staff/viewer/auditor screen. */}
            {isAdmin ? ' ／ 金額は代表者にのみ表示されます。' : null}
          </p>
        ) : null}
        {board.workspace.error ? <div className="ui-info">{board.workspace.error}</div> : null}
      </header>

      <MakerPoCreateSection
        readyOrders={readyOrders}
        alreadyCreatedOrders={alreadyCreatedOrders}
        recipients={recipients}
        previousTypedRecipient={previousTypedRecipient}
        acknowledgementBlockedOrders={acknowledgementBlockedOrders}
        boardOrderCount={cards.length}
        isAdmin={isAdmin}
        role={role}
        stateLabel={stateLabel}
        statusHiddenOrders={statusHiddenOrders}
      />

      {cards.map((card) => (
        <MakerPoOrderSection
          key={card.entry.order.id}
          card={card}
          projectCode={projectCode}
          isAdmin={isAdmin}
          role={role}
          stateLabel={stateLabel}
          sendEvidenceChoices={documentVersionChoices(card.entry.order.id, 'send_evidence')}
          acceptanceEvidenceChoices={documentVersionChoices(card.entry.order.id, 'acceptance_evidence')}
          acknowledgementEvidenceChoices={(poId: string) => acknowledgementEvidenceChoices(card.entry.order.id, poId)}
        />
      ))}

      {cards.length === 0 && statusHiddenOrders > 0 ? (
        <div className="ui-card">
          <p className="ui-note">
            {STATUS_HIDDEN_NOTICE}。メーカー発注の作業対象になっている発注があるかどうかは、この画面に表示できません。
          </p>
        </div>
      ) : null}

      {cards.length === 0 && statusHiddenOrders === 0 ? (
        <div className="ui-card">
          <p className="ui-note">
            メーカー発注の作業対象の発注はまだありません。フィルム発注が「{stateLabel(MAKER_PO_READY)}」（校正の両組織の承認が完了）に
            なると、この画面に表示されます。製造中・出荷済み・納品済みに進んだ発注も、発注書と承認・送信・受入の
            履歴が読めるままこの画面に表示されます。次のアクション:
            「発注の一覧」画面で承認を進めてください。
          </p>
        </div>
      ) : null}

      {/* M8-OPER2 FIX 1: a new order can be created with its G6 terms already set.
          UI batch C (2-④): folded — the daily work on this screen is the paper below. */}
      <details className="collapsed-card ui-card">
        <summary>
          <h2 className="sx-51ef381">
            新しいフィルム発注を作成する（支払条件つき）
          </h2>
        </summary>
        <RoleGate role={role} operation="film_order:create" label="フィルム発注の作成">
          <p className="ui-note">
            フィルム発注を作るときに支払条件（前払い／納品後払い／未定）を必ず選びます。
            代表承認の前なら発注一覧で変更でき、ここでの記録は入金確認ではありません
            — 入金の確認は別の手順です。「未定」のままでは代表承認できません。
          </p>
          <OrderCreateForm
            action={createFilmSupplyOrderAction}
            orderKind="film"
            unitChoices={unitChoices('film')}
            sevenPurchaseOrderChoices={poChoices}
            paymentTermsChoices={PAYMENT_TERMS_CHOICES}
          />
        </RoleGate>
      </details>

      <AuditDashboardSection
        events={audit.events}
        error={audit.error}
        role={role}
        acknowledgementKinds={acknowledgementKindsOfCards(allCards)}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen 1: 発注書作成 + 一覧
// ---------------------------------------------------------------------------

function MakerPoCreateSection({
  readyOrders,
  alreadyCreatedOrders,
  recipients,
  previousTypedRecipient,
  acknowledgementBlockedOrders,
  boardOrderCount,
  isAdmin,
  role,
  stateLabel,
  statusHiddenOrders
}: {
  readyOrders: OrderMakerPoBoard[];
  /** UI batch E (F-21): orders at MAKER_PO_READY that already carry a live paper. */
  alreadyCreatedOrders: OrderMakerPoBoard[];
  /** P2 R33: the project maker's recipient addresses (typed address only when not usable). */
  recipients: RecipientChoices;
  /** P2 R33: the latest paper's address when it is not a master address (a hint, never filled in). */
  previousTypedRecipient: string | null;
  /** Low-7 (f): orders at MAKER_PO_READY whose cancelled, sent paper still owes the 取り消し承認. */
  acknowledgementBlockedOrders: OrderMakerPoBoard[];
  /** Orders on the maker board (MAKER_PO_READY or a later maker/production state). */
  boardOrderCount: number;
  isAdmin: boolean;
  role: string | null;
  stateLabel: (key: string) => string;
  statusHiddenOrders: number;
}) {
  const orderChoices: Choice[] = readyOrders.map((entry) => ({
    value: entry.order.id,
    label: filmOrderChoiceLabel(entry.order, stateLabel)
  }));
  const title = <h2 className="sx-c5c15d8">手順1: 発注書の作成（メーカー発注書の作成）</h2>;
  const createdNote = alreadyCreatedOrders.length > 0 ? (
    <p className="ui-note">
      {`${alreadyCreatedOrders.map((entry) => entry.order.code).join('、')}: メーカー発注書は作成済みです。`
        + '次の手順は下のその発注に表示されます（作り直すときは、先にその発注書を取り消します）。'}
    </p>
  ) : null;
  const blockedNote = acknowledgementBlockedOrders.length > 0 ? (
    <p className="ui-note">
      {`${acknowledgementBlockedOrders.map((entry) => entry.order.code).join('、')}: 送信ずみのまま取り消した発注書の`
        + '「取り消し承認（メーカー取消確認）」がまだ記録されていないため、新しい発注書はまだ作成できません。'
        + '次のアクション: 下のその発注の「取り消し（代表者のみ）」で取り消し承認を記録してください。'}
    </p>
  ) : null;

  // UI batch C (2-④): nothing to create → one line. Orders already past ① are
  // not 「両組織の承認不足」; that guidance stays for a board with no order at all.
  if (readyOrders.length === 0) {
    return (
      <div className="ui-card">
        {title}
        {createdNote}
        {blockedNote}
        {blockedNote || createdNote ? null : statusHiddenOrders > 0 ? (
          <p className="ui-note">{STATUS_HIDDEN_NOTICE}。作成できる発注があるかどうかは表示できません。</p>
        ) : boardOrderCount > 0 ? (
          <p className="ui-note">作成待ちの発注はありません。作成済みの発注書は下の各発注に表示されます。</p>
        ) : (
          <p className="ui-note">
            作成できる発注（{stateLabel(MAKER_PO_READY)}）はまだありません。ブロック理由: 両組織の承認不足（顧客とセブン化学の
            両組織の承認が未完了）、または発注自体がまだありません。次のアクション:
            「承認」画面で両組織の承認を完了させてください。
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="ui-card">
      {title}
      <p className="ui-note">
        校正の両組織の承認が完了して「{stateLabel(MAKER_PO_READY)}」になった発注の紙を凍結し、メーカー発注書を作ります。
        作成は代表者だけです（担当者・閲覧者は作成できません）。
      </p>
      {createdNote}
      {blockedNote}
      <RoleGate role={role} operation="maker_po:create" label="メーカー発注書の作成">
        <ActionForm
          action={createMakerPoAction}
          submitLabel="メーカー発注書を作成する"
          hint={`送信先メールアドレスは、メーカーへ発注書を送るメールの宛先です（郵便の住所ではありません）。送信の記録では、送ったメールの宛先にこのアドレスが含まれている必要があります。${isAdmin ? '金額は代表者のみ入力できます（担当者の画面には金額欄がありません）。' : ''}`}
          confirm={{
            title: 'メーカー発注書を作成しますか？',
            body: `宛先と内容（${isAdmin ? '明細・金額' : '明細'}）をこの時点の内容で確定します。確定した内容は変えられないため、直すときはこの発注書を取り消して作り直します。`,
            tone: 'primary',
            summaryFields: isAdmin
              ? ['orderId', 'recipientChoice', 'recipientAddress', 'currency', 'totalAmount']
              : ['orderId', 'recipientChoice', 'recipientAddress']
          }}
          successHint="次の手順: 手順2: 代表承認（下の発注に表示されます）"
        >
          <div className="form-row">
            <SelectField name="orderId" label="対象のフィルム発注" required choices={orderChoices} width={420} />
          </div>
          {/* P0 R10 (H5): a typed address is checked as an e-mail before the paper is frozen.
              P2 R33: or one of the project maker's addresses (the default preselected). */}
          <RecipientChooser choices={recipients} previousTyped={previousTypedRecipient} showMakersLink={isAdmin} width={320} />
          {isAdmin ? (
            <div className="form-row">
              <SelectField name="currency" label="通貨" width={160} defaultValue="JPY" choices={CURRENCY_CHOICES} />
              <TextField name="totalAmount" label="金額（数字のみ）" width={180} hint="例 480000（¥・カンマは不要です）" inputMode="decimal" />
            </div>
          ) : null}
        </ActionForm>
      </RoleGate>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens 2, 3 and 4: per-order paper
// ---------------------------------------------------------------------------

/** The paper with its event trail, read once per card (UI batch C). */
interface PaperWork extends MakerPoStagePaper {
  po: MakerPoViewRow;
  events: MakerPoEventRow[];
  error: string | null;
  pendingVerifications: MakerPoEventRow[];
  rejectedVerifications: MakerPoSendManualVerification[];
  /** The API's proven-send rule (VERIFIED or confirmed manual verification); see makerPoSendProof. */
  sendProof: MakerPoSendProof;
  acknowledgementRecorded: boolean;
  /** Recheck 8 Medium-B: what the recorded acknowledgement is (null: none recorded). */
  acknowledgementKind: CancellationAcknowledgementKind | 'unknown' | null;
  /** Representative decision (a): the post-delivery confirmation form is offered. */
  offersPostDelivery: boolean;
  /** Medium-1: sends of a cancelled paper nobody can settle any more (read-only note, never ③′). */
  unsettledCancelledSends: MakerPoEventRow[];
  /**
   * Recheck 9 Medium-3: sends of a cancelled paper whose decision this screen
   * cannot read (staff: the audit rows carry no result) — neither 「手動確認待ち」 nor settled.
   */
  undecidableCancelledSends: MakerPoEventRow[];
}

/** The papers as the shared cleanup / creation judgements read them. */
function judged(papers: ReadonlyArray<PaperWork>): MakerPaperJudgement[] {
  return papers.map((paper) => ({
    status: paper.po.status,
    sendProof: paper.sendProof,
    acknowledgementRecorded: paper.acknowledgementRecorded
  }));
}

/** One order's card: the board entry and its papers, read once at page level. */
interface OrderCard {
  entry: OrderMakerPoBoard;
  papers: PaperWork[];
}

/**
 * Reads each paper's event trail and judges its send proof by the API's rule.
 *
 * Recheck 7 Info-4 / Medium-1: a send with no decision in the project-wide
 * audit read is asked about by its own id only when that read was capped
 * (auditWindowComplete false) — a shorter answer is the whole list, so the
 * send simply has no decision. A cancelled paper is never asked about once its
 * proof is settled without it (its 取り消し承認, or the API's own cancel
 * classification), so a pending send of a cancelled paper does not cost one
 * read per page load for ever.
 */
async function loadOrderPapers(
  entry: OrderMakerPoBoard,
  context: {
    role: string | null;
    projectId: string;
    sendManualVerifications: MakerPoSendManualVerification[];
    cancellationFlags: ReadonlyMap<string, boolean>;
    acknowledgementKinds: ReadonlyMap<string, CancellationAcknowledgementKind>;
    /** Sends that have a decision this role cannot read (recheck 9 Medium-3). */
    undisclosedDecisions: ReadonlySet<string>;
    auditWindowComplete: boolean;
  }
): Promise<OrderCard> {
  const list = entry.makerPurchaseOrders;
  const details = await Promise.all(list.map((po) => loadMakerPoDetail(po.id)));
  // Only the representative's screen needs (and can read) the decisions.
  const readsDecisions = canRoleOperate(context.role, 'maker_po:verify_send')
    || canRoleOperate(context.role, 'maker_po:cancel');
  const known = context.sendManualVerifications;
  const askable = details.flatMap((detail, index) => {
    const po = list[index];
    if (!po || !detail || detail.error) return [];
    if (po.status === 'CANCELLED' && (hasCancellationAcknowledgement(detail.events)
      || makerPoSendProof(detail.events, known, new Set(), context.cancellationFlags) === 'proven')) {
      return [];
    }
    return detail.events;
  });
  const undecided = readsDecisions && !context.auditWindowComplete
    ? sendEventsWithoutKnownDecision(askable, known)
    : [];
  const targeted = undecided.length > 0
    ? await loadManualVerificationsForEvents(context.projectId, undecided)
    : { verifications: [], unreadEventIds: new Set<string>() };
  const knownVerifications = [...known, ...targeted.verifications];
  // Recheck 9 Medium-3: a send whose decision cannot be read is not "never
  // confirmed". Staff cannot read the decisions (their audit rows carry no
  // result) nor ask for them, so a decision row they see without its result,
  // or a send past a capped audit read, leaves the proof unknown — never
  // 'unproven', which inverted the kind of a proven send's 取り消し承認.
  const undecidable = new Set<string>([...targeted.unreadEventIds, ...context.undisclosedDecisions]);
  if (!readsDecisions && !context.auditWindowComplete) {
    for (const id of sendEventsWithoutKnownDecision(details.flatMap((detail) => detail?.events ?? []), known)) {
      undecidable.add(id);
    }
  }
  const papers = list.map((po, index): PaperWork => {
    const detail = details[index] ?? { purchaseOrder: null, events: [], error: '取得できませんでした。' };
    const events = detail.events;
    const eventIds = new Set(events.map((event) => event.id));
    const pendingVerifications = pendingManualVerificationEvents(events, knownVerifications, po.status);
    // A failed read of the paper's own events cannot prove "unsent" (review M1).
    const sendProof: MakerPoSendProof = detail.error
      ? 'unknown'
      : makerPoSendProof(events, knownVerifications, undecidable, context.cancellationFlags);
    const acknowledgementRecorded = hasCancellationAcknowledgement(events);
    const acknowledgementKind = detail.error
      ? null
      : cancellationAcknowledgementKind(events, sendProof, context.acknowledgementKinds);
    return {
      po,
      events,
      error: detail.error,
      pendingVerifications,
      pendingVerification: pendingVerifications.length > 0,
      confirmedVerification: knownVerifications.find((verification) =>
        verification.result === 'confirmed' && eventIds.has(verification.makerPoEventId)) ?? null,
      rejectedVerifications: rejectedSendManualVerifications(knownVerifications)
        .filter((verification) => eventIds.has(verification.makerPoEventId)),
      sendProof,
      acknowledgementRecorded,
      acknowledgementKind,
      offersPostDelivery: !detail.error && offersPostDeliveryConfirmation(po.status, sendProof, events),
      acknowledgementOwed: acknowledgementOwed({ status: po.status, sendProof, acknowledgementRecorded }),
      unsettledCancelledSends: unsettledSendsOfCancelledPaper(events, knownVerifications, po.status, undecidable),
      undecidableCancelledSends: po.status === 'CANCELLED'
        ? events.filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED'
          && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
          && undecidable.has(event.id)
          && !knownVerifications.some((verification) => verification.makerPoEventId === event.id))
        : []
    };
  });
  return { entry, papers };
}

/** The digit inside an upcoming stage's mark (the label carries the name). */
const STAGE_MARK_DIGITS: Readonly<Record<MakerPoStageKey, string>> = {
  create: '1',
  approve: '2',
  send: '3',
  verify: '3′',
  accept: '4',
  complete: '完'
};

/**
 * UI batch C (2-④): the paper's stages in the batch B stepper language — 済
 * stamps, an indigo いま on the current stage, 停止 when the paper is halted,
 * a dashed — for a stage this paper will not reach. Every mark is text.
 */
function MakerPoStageList({ view }: { view: MakerPoStageView }) {
  return (
    <ol className="stepper" aria-label="メーカー発注の段階">
      {view.stages.map((stage) => {
        const halted = stage.state === 'current' && view.condition === 'halted';
        const mark = stage.state === 'done'
          ? '済'
          : stage.state === 'current'
            ? halted ? '停止' : 'いま'
            : stage.state === 'skipped'
              ? '—'
              : STAGE_MARK_DIGITS[stage.key];
        return (
          <li
            key={stage.key}
            className={`step step--${halted ? 'interrupted' : stage.state}`}
            aria-current={stage.state === 'current' ? 'step' : undefined}
          >
            <span className="step-mark">{mark}</span>
            <span className="step-label">{stage.name}</span>
            {stage.state === 'skipped' ? <span className="visually-hidden">（この発注書では行われません）</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Recheck 8 Medium-B: what follows the read-only note on a cancelled paper's
 * unsettled send. Decision (a) gave the representative a record for the
 * internal cancel that reached the maker after all.
 */
function unsettledCancelledSendFollowUp(paper: PaperWork, canCancel: boolean): string {
  if (paper.acknowledgementRecorded) {
    return `「${cancellationAcknowledgementLabel(paper.acknowledgementKind)}」は記録済みです。`;
  }
  if (!paper.offersPostDelivery) return '';
  return canCancel
    ? 'メーカーに届いていたと分かった場合は、下の「メーカー到達の事後確認を記録する（記録のみ）」で記録できます（発注の状態と新しい発注書の作成可否は変わりません）。'
    : 'メーカーに届いていたと分かった場合は代表者へ伝えてください。代表者が「メーカー到達の事後確認（記録のみ）」を記録します。';
}

/**
 * P2 R32 (DESIGN §6): a paper on this board by its MPO number (code: no
 * translation) — the short id when the API did not answer a number, so papers of
 * one order (a cancelled one and its replacement) stay apart.
 */
function paperRef(po: MakerPoViewRow): string {
  return makerPoNumberOf(po.displayNumber) ?? shortId(po.id);
}

function PaperRef({ po }: { po: MakerPoViewRow }) {
  const number = makerPoNumberOf(po.displayNumber);
  return number
    ? <strong translate="no" className="p1-figure p2-mpo-number">{number}</strong>
    : <>{shortId(po.id)}</>;
}

/** The card head's paper name: 「メーカー発注書 MPO-…」, else 「{発注コード} のメーカー発注書」. */
function PaperName({ po, orderCode }: { po: MakerPoViewRow; orderCode: string }) {
  const number = makerPoNumberOf(po.displayNumber);
  return (
    <span className="p2-paper-name">
      {number ? <>メーカー発注書 <span translate="no" className="p1-figure p2-mpo-number">{number}</span></> : makerPoName(po, orderCode)}
    </span>
  );
}

function MakerPoOrderSection({
  card,
  projectCode,
  isAdmin,
  role,
  stateLabel,
  sendEvidenceChoices,
  acceptanceEvidenceChoices,
  acknowledgementEvidenceChoices
}: {
  card: OrderCard;
  projectCode: string;
  isAdmin: boolean;
  role: string | null;
  stateLabel: (key: string) => string;
  sendEvidenceChoices: Choice[];
  acceptanceEvidenceChoices: Choice[];
  /** The document versions bound to this order and to the given maker PO (Low-6). */
  acknowledgementEvidenceChoices: (poId: string) => Choice[];
}) {
  const { entry, papers } = card;
  const gate = entry.paymentGate;
  const list = entry.makerPurchaseOrders;
  // M8-OPER2 FIX 3: an order in the production/shipping/delivery chain has a
  // closed paper. The section answers with the read-only history and never
  // renders the approval / send / acceptance forms again.
  const status = knownStatus(entry.order);
  const pastAcceptance = status !== null && isOrderPastMakerAcceptance(status);
  // Medium-3: a cancelled or frozen order — cleanup only (取り消し・取り消し承認).
  const closure = entry.closure;
  // UI batch B (④): the representative-only blocks, through the shared helper.
  const canVerifySend = canRoleOperate(role, 'maker_po:verify_send');
  const canCancel = canRoleOperate(role, 'maker_po:cancel');
  // Review M4: a failed list read is not "no paper yet".
  const stages = makerPoStages({ orderStatus: status, papers, listFailed: entry.makerPoError !== null });
  const primary = papers.find((paper) => paper.po.id === stages.primaryPoId) ?? null;
  const current = stages.current;
  // The G6 box is large while it still decides something (① and ②, or back
  // at ① after every paper was cancelled).
  const gateDecides = paymentGateDecides(stages);
  const doneStages = stages.stages.filter((stage) => stage.state === 'done' && stage.summary);
  const nextLine = upcomingStagesLine(stages);

  // The danger zone holds the cancel control of live paper and the
  // 取り消し承認 work of a cancelled paper whose send is proven — by the same
  // rule the API applies (VERIFIED or confirmed manual verification) — or
  // cannot be judged because its decision records could not be read.
  // Recheck 8 Medium-B: also a cancelled paper with a recorded acknowledgement
  // (its kind is shown) and the internally cancelled paper of decision (a).
  // Past acceptance only those two stay: the internal cancel that reached the
  // maker while its replacement is in production is the case decision (a) is for.
  const cancelWork = canCancel
    ? papers.filter((paper) => (!pastAcceptance && (isCancellableMakerPoStatus(paper.po.status)
      || cancellationAcknowledgementMayBeRequired(paper.po.status, paper.sendProof)))
      || paper.offersPostDelivery
      || (paper.po.status === 'CANCELLED' && paper.acknowledgementRecorded))
    : [];
  const acknowledgementDue = cancelWork.some((paper) =>
    cancellationAcknowledgementMayBeRequired(paper.po.status, paper.sendProof) && !paper.acknowledgementRecorded);
  // Medium-3: live paper the screen cannot cancel (SEND_UNVERIFIED, accepted) on a closed order.
  const stuckPapers = closure ? papers.filter((paper) =>
    paper.po.status !== 'CANCELLED' && !isCancellableMakerPoStatus(paper.po.status)) : [];
  const unsettledCancelledSends = papers.filter((paper) => paper.unsettledCancelledSends.length > 0);
  const undecidableCancelledSends = papers.filter((paper) => paper.undecidableCancelledSends.length > 0);

  // A line for a current stage that has no block of its own for this role.
  const fallback: string | null = stages.unknown === 'list-error'
    ? 'メーカー発注書の一覧を取得できなかったため、いまの段階を表示できません。画面を再読み込みしてください。'
    : stages.unknown === 'missing-paper'
      ? 'この発注はメーカー発注書の作成より先の状態ですが、メーカー発注書が見つかりません。画面を再読み込みし、表示が変わらない場合は記録の状態を確認してください。'
      : list.length === 0
        ? `この発注のメーカー発注書はまだありません。次のアクション: ${canRoleOperate(role, 'maker_po:create')
          ? '上の「手順1: 発注書の作成」で作成してください。'
          : '代表者による発注書の作成を待ちます。'}`
        : current?.key === 'verify' && !canVerifySend
          ? '送信記録は代表者の手動確認待ちです。代表者が原本のEMLと発注内容を見比べて記録します。'
          : primary && ['SEND_UNVERIFIED', 'MAKER_PO_ACCEPTED', 'CANCELLED'].includes(primary.po.status)
            ? nextActionForStatus(primary.po.status, role ?? 'viewer')
            : null;

  return (
    // UI nav-dashboard: the dashboard links to this card (#maker-order-<id>).
    <div id={`maker-order-${entry.order.id}`} className="anchor-target ui-card">
      <h2 className="card-head">
        <span>フィルム発注 {filmOrderChoiceLabel(entry.order, stateLabel)}</span>
        {primary ? (
          <StatusBadge
            domain="makerPo"
            status={primary.po.status}
            label={MAKER_PO_STATUS_LABELS[primary.po.status] ?? primary.po.status}
          />
        ) : null}
        {primary ? <PaperName po={primary.po} orderCode={entry.order.code} /> : null}
      </h2>
      {pastAcceptance ? <p className="ui-note">メーカー発注の紙は受入済みです（記録は下の「メーカー発注の履歴」にあります）。</p> : null}
      {closure ? <MakerPoCleanupNotice closure={closure} status={status} stateLabel={stateLabel} canCancel={canCancel} /> : null}

      {closure ? null : <MakerPoStageList view={stages} />}

      {/* G6 payment gate: 支払条件の状態 and the block reason, always visible. */}
      {closure ? null : gateDecides ? (
        <div style={{ ...infoBoxStyle, marginTop: 12, borderColor: gate?.gate.satisfied ? 'var(--ok)' : 'var(--danger)', color: gate?.gate.satisfied ? 'var(--ok)' : 'var(--danger)', background: gate?.gate.satisfied ? 'var(--ok-tint)' : 'var(--danger-tint)' }}>
          <strong>支払条件の状態: </strong>
          {gate ? (
            <>
              {PAYMENT_TERMS_LABELS[gate.paymentTerms] ?? gate.paymentTerms}
              {gate.gate.satisfied
                ? ' ／ 代表承認の前提: 満たしています'
                : ` ／ 代表承認の前提: 満たしていません（${paymentGateBlockText(gate.gate.code)}）`}
              <div className="ui-note">
                入金確認: {gate.paymentConfirmedAt ? formatTimestamp(gate.paymentConfirmedAt) : '未確認'}。
                支払条件の記録（前払い・納品後払い）は入金確認ではありません。入金の確認は別に記録する
                手動のステップで、入金確認の記録はこの画面ではできません。
              </div>
            </>
          ) : (
            <>支払条件の状態を取得できませんでした。{entry.paymentGateError ?? ''}</>
          )}
        </div>
      ) : (
        <p className="gate-line">
          支払条件:{' '}
          {gate ? (
            <>
              {PAYMENT_TERMS_LABELS[gate.paymentTerms] ?? gate.paymentTerms}{' '}
              {/* The badge holds the state only (it does not wrap); the reason is ordinary text. */}
              <StatusBadge tone={gate.gate.satisfied ? 'done' : 'blocked'} label={gate.gate.satisfied ? '満たしています' : '満たしていません'} />
              {gate.gate.satisfied ? null : (
                <span className="gate-line-reason">（{paymentGateBlockText(gate.gate.code)}）</span>
              )}
              {' '}／ 入金確認: {gate.paymentConfirmedAt ? formatTimestamp(gate.paymentConfirmedAt) : '未確認'}
            </>
          ) : (
            <>状態を取得できませんでした。{entry.paymentGateError ?? ''}</>
          )}
        </p>
      )}

      {/* UI batch B (L10): the 支払条件 form for a DRAFT order stood here, but this
          board lists only the maker-chain states (MAKER_PO_ORDER_STATES has no
          DRAFT), so it never rendered. G6 terms are recorded on the /orders
          screen while the order is a draft (tests/web-ui-batch-b.test.tsx). */}

      {list.length === 0 ? null : (
        <DataTable caption="この発注のメーカー発注書">
          <thead>
            <tr>
              <th className="ui-th" scope="col">発注書</th>
              <th className="ui-th" scope="col">状態</th>
              <th className="ui-th" scope="col">発注コード</th>
              {isAdmin ? <th className="ui-th" scope="col">金額</th> : null}
              {isAdmin ? <th className="ui-th" scope="col">宛先</th> : null}
              {!isAdmin ? <th className="ui-th" scope="col">宛先</th> : null}
              <th className="ui-th" scope="col">代表承認</th>
              <th className="ui-th" scope="col">更新</th>
            </tr>
          </thead>
          <tbody>
            {list.map((po) => (
              <tr key={po.id} data-record-id={po.id}>
                <td className="ui-td">
                  <PaperRef po={po} />
                  <TechDetails context="ID">{po.id}</TechDetails>
                </td>
                <td className="ui-td">
                  <StatusBadge domain="makerPo" status={po.status} label={MAKER_PO_STATUS_LABELS[po.status] ?? po.status} />
                  <div className="ui-note">
                    {closure
                      ? cleanupNextActionForStatus(po.status, role ?? 'viewer', closure)
                      : nextActionForStatus(po.status, role ?? 'viewer')}
                  </div>
                </td>
                {/* P4 L5: an order code is one token — it never breaks across lines, and the browser never translates it. */}
                <td className="ui-td p4-nowrap" translate="no">{po.orderCode ?? po.snapshot?.order?.code ?? '—'}</td>
                {isAdmin ? (
                  <td className="ui-td sx-b6f5052">
                    {po.snapshot?.amounts
                      ? formatMoney(po.snapshot.amounts.currency, po.snapshot.amounts.totalAmount)
                      : '—'}
                  </td>
                ) : null}
                {isAdmin ? (
                  <td className="ui-td">
                    <div>{po.snapshot?.recipient?.address ?? po.recipientAddress ?? '—'}</div>
                    {/* UI batch E (F-14): the digest is a system value — under 「詳細」. */}
                    {po.snapshotSha256 ? <TechDetails context="作成時の内容のハッシュ">{po.snapshotSha256}</TechDetails> : null}
                  </td>
                ) : (
                  <td className="ui-td">{po.recipientAddress ?? '—'}</td>
                )}
                <td className="ui-td">{po.ceoApprovedAt ? formatTimestamp(po.ceoApprovedAt) : '未承認'}</td>
                <td className="ui-td">{formatTimestamp(po.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {entry.makerPoError ? <div className="ui-info">{entry.makerPoError}</div> : null}
      {papers.map((paper) => (paper.error ? <div className="ui-info" key={paper.po.id}>{paper.error}</div> : null))}

      {/* Medium-1: the sends of a cancelled paper are history, not ③′ work — the API refuses both decisions. */}
      {unsettledCancelledSends.map((paper) => (
        <p key={`unsettled:${paper.po.id}`} className="role-notice">
          {`取り消し済みの発注書 ${paperRef(paper.po)} の送信記録（${paper.unsettledCancelledSends
            .map((event) => shortId(event.id)).join('、')}）は手動確認待ちのまま残っています。`
            + '取り消し済みの発注書の送信は、確認も却下も記録できません（APIが拒否します）。記録は履歴として残ります。'
            + (paper.sendProof === 'unproven' ? 'この取り消しは内部の訂正として扱われたため、取り消し承認も不要です。' : '')
            + unsettledCancelledSendFollowUp(paper, canCancel)}
        </p>
      ))}

      {/* Recheck 9 Medium-3: a decision this screen cannot read is said as such — never 「手動確認待ち」 or 内部の訂正. */}
      {undecidableCancelledSends.map((paper) => (
        <p key={`undecidable:${paper.po.id}`} className="role-notice">
          {`取り消し済みの発注書 ${paperRef(paper.po)} の送信記録（${paper.undecidableCancelledSends
            .map((event) => shortId(event.id)).join('、')}）は、`
            + (canVerifySend || canCancel
              ? '送信の手動確認の記録を読み込めなかったため、'
              : '送信の手動確認の結果（確認・却下）がこの役割の画面には表示されないため、')
            + '送信ずみとして取り消されたのか、内部の訂正として取り消されたのかをこの画面では判定できません。'
            + (paper.acknowledgementRecorded
              ? `取り消し後の記録（${cancellationAcknowledgementLabel(paper.acknowledgementKind)}）はあります。`
              : '')
            + (canVerifySend || canCancel
              ? '画面を再読み込みしてください。'
              : 'メーカーへの連絡が必要かどうかは代表者に確認してください。')}
        </p>
      ))}

      {stuckPapers.map((paper) => (
        <p key={`stuck:${paper.po.id}`} className="role-notice">
          {`発注書 ${paperRef(paper.po)} は「${MAKER_PO_STATUS_LABELS[paper.po.status] ?? paper.po.status}」のため、この画面から取り消せません`
            + '（APIが取り消しを受け付けない状態です）。メーカーへの連絡と対応は代表者が判断してください。'}
        </p>
      ))}

      {pastAcceptance || closure ? null : (
        // UI batch C (2-④): only the current stage is open and marked.
        <div className={`stage-current stage-current--${stages.condition}`}>
          <p className="stage-current-head">
            <span className="stage-now">いまの段階</span>
            <strong>{stageHeadline(stages)}</strong>
          </p>
          {fallback ? <p className="ui-note">{fallback}</p> : null}

          {/* Screen 2: 代表承認 */}
          <MakerPoApprovalBlock entry={entry} role={role} projectCode={projectCode} />

          {/* Screens 3′, 3 and 4 */}
          {papers.map((paper) => (
            <MakerPoWorkBlocks
              key={paper.po.id}
              paper={paper}
              role={role}
              canVerifySend={canVerifySend}
              sendEvidenceChoices={sendEvidenceChoices}
              acceptanceEvidenceChoices={acceptanceEvidenceChoices}
            />
          ))}
        </div>
      )}

      {doneStages.length > 0 || stages.cancelledPapers.length > 0 || pastAcceptance ? (
        <details className="stage-done">
          <summary>{pastAcceptance ? 'メーカー発注の履歴（済んだ段階）' : `済んだ段階（${doneStages.length}件）`}</summary>
          {doneStages.length > 0 || stages.cancelledPapers.length > 0 ? (
            <ul>
              {doneStages.map((stage) => (
                <li key={stage.key}>
                  {stageLabel(stage)}: {stage.summary}
                </li>
              ))}
              {stages.cancelledPapers.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
          {pastAcceptance ? (
            // M8-OPER2 FIX 3: read-only history instead of the recording forms.
            <MakerPoHistoryBlock papers={papers} />
          ) : null}
        </details>
      ) : null}

      {nextLine && !pastAcceptance && !closure ? <p className="stage-next">{nextLine}</p> : null}

      {cancelWork.length > 0 ? (
        // M8-UI2 cancellation work, apart at the bottom (UI batch C). Open while
        // a sent paper's 取り消し承認 is the work left.
        // Medium-3: open on a closed order too — the cleanup is all that is left.
        <details className="danger-zone" open={acknowledgementDue || closure !== null}>
          <summary>{closure ? '整理: 取り消し・取り消し承認（代表者のみ）' : '取り消し（代表者のみ）'}</summary>
          {cancelWork.map((paper) => (
            <MakerPoCancelWork
              key={paper.po.id}
              paper={paper}
              closure={closure}
              evidenceChoices={acknowledgementEvidenceChoices(paper.po.id)}
            />
          ))}
        </details>
      ) : null}
    </div>
  );
}

/**
 * Recheck 7 Medium-3: the card of a cancelled or frozen order says why only the
 * cleanup is offered — the API refuses 代表承認・送信・手動確認・受入 there and
 * keeps 取り消し and 取り消し承認 open.
 */
function MakerPoCleanupNotice({
  closure,
  status,
  stateLabel,
  canCancel
}: {
  closure: MakerPoOrderClosure;
  status: string | null;
  stateLabel: (key: string) => string;
  canCancel: boolean;
}) {
  return (
    <div className="ui-info sx-9c9cee2">
      <strong>整理だけができます: </strong>
      {closure === 'cancelled'
        ? `この発注は「${stateLabel(status ?? 'CANCELLED')}」ですが、メーカー発注書の整理が残っています。取り消されていない発注書はメーカーが生産する可能性があります。`
        : `この発注は「${status ? stateLabel(status) : '保留・見直し中'}」です。解除・処理（発注一覧画面）の前でも、メーカー発注書の整理はここで記録できます。`}
      代表承認・送信・送信の手動確認・受入はこの状態では記録できません（APIが拒否します）。
      {canCancel
        ? '下の「整理: 取り消し・取り消し承認（代表者のみ）」で記録してください。'
        : '整理（発注書の取り消し・取り消し承認）は代表者が行います。'}
    </div>
  );
}

/**
 * M8-OPER2 FIX 3: the 発注書・代表承認・送信・受入 history of a closed paper,
 * read from the role-shaped API answer. No form is rendered here: past
 * MAKER_PO_ACCEPTED the paper is done and the screen only reports what happened.
 */
function MakerPoHistoryBlock({ papers }: { papers: PaperWork[] }) {
  if (papers.length === 0) {
    return (
      <p className="ui-note">
        この発注は受入後の状態（製造中・出荷済み・納品済み）ですが、この画面に表示できるメーカー発注書はまだありません。
      </p>
    );
  }

  return (
    <div className="sx-9c9cee2">
      <h3 className="sx-e6251b7">メーカー発注の履歴（発注書・代表承認・送信・受入）</h3>
      <p className="ui-note">
        受入済みのため、これ以上の承認・送信・受入の記録操作は表示しません。以下は記録の履歴です。
      </p>
      {papers.map(({ po, events, acknowledgementKind }) => {
        const sentEvent = events.find((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
        const acceptedEvent = events.find((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED');
        const provisionalEvents = events.filter((event) => event.provisional === true);
        return (
          <div className="sx-72d6c38" key={po.id}>
            <DataTable caption={`発注書 ${paperRef(po)} の記録`} captionHidden>
              <thead>
                <tr>
                  <th className="ui-th" scope="col">発注書</th>
                  <th className="ui-th" scope="col">状態</th>
                  <th className="ui-th" scope="col">発注書の作成</th>
                  <th className="ui-th" scope="col">代表承認</th>
                  <th className="ui-th" scope="col">送信記録</th>
                  <th className="ui-th" scope="col">受入確認（最終）</th>
                  <th className="ui-th" scope="col">受入記録（仮）</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="ui-td">
                    <PaperRef po={po} />
                    <TechDetails context="ID">{po.id}</TechDetails>
                  </td>
                  <td className="ui-td">
                    <StatusBadge domain="makerPo" status={po.status} label={MAKER_PO_STATUS_LABELS[po.status] ?? po.status} />
                  </td>
                  <td className="ui-td">{po.createdAt ? formatTimestamp(po.createdAt) : '—'}</td>
                  <td className="ui-td">{po.ceoApprovedAt ? formatTimestamp(po.ceoApprovedAt) : '未承認'}</td>
                  <td className="ui-td">
                    {sentEvent?.sentAt ? formatTimestamp(sentEvent.sentAt) : '記録なし'}
                  </td>
                  <td className="ui-td">
                    {acceptedEvent ? formatTimestamp(acceptedEvent.recordedAt) : '記録なし'}
                  </td>
                  <td className="ui-td">
                    {provisionalEvents.length > 0
                      ? `${provisionalEvents.length}件（${provisionalEvents
                          .map((event) => formatTimestamp(event.recordedAt))
                          .join('、')}）`
                      : 'なし'}
                  </td>
                </tr>
              </tbody>
            </DataTable>
            {events.length > 0 ? (
              <details>
                <summary className="sx-eefff2f">
                  この発注書の記録イベント（{events.length}件）
                </summary>
                <ul className="sx-c083946">
                  {events.map((event) => (
                    <li key={event.id}>
                      {event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED'
                        ? cancellationAcknowledgementLabel(acknowledgementKind)
                        : MAKER_PO_EVENT_TYPE_LABELS[event.eventType] ?? event.eventType} ／{' '}
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
          </div>
        );
      })}
    </div>
  );
}

export function MakerPoApprovalBlock({ entry, role, projectCode }: { entry: OrderMakerPoBoard; role: string | null; projectCode: string }) {
  const canApprove = canRoleOperate(role, 'ceo_approve');
  const pending = entry.makerPurchaseOrders
    .filter((po) => po.status === 'DRAFT' || po.status === 'SNAPSHOT_VOIDED');
  if (pending.length === 0) return null;
  const gate = entry.paymentGate;
  const gateBlocks = gate !== null && !gate.gate.satisfied;
  const voided = pending.some((po) => po.status === 'SNAPSHOT_VOIDED');
  const blocks = [
    gateBlocks ? '支払条件が「未定」です（下の「発注の画面で支払条件を選ぶ」から決めてください）' : null,
    voided ? '作成時の内容が無効になっています（もう一度承認が必要です）' : null
  ].filter((part): part is string => part !== null);

  return (
    <div className="stage-block sx-2468269">
      <h3 className="sx-e6251b7">手順2: 代表承認（代表者のみ）</h3>
      <p className="ui-note">
        {canApprove ? '作成したときの内容（宛先・明細・金額）に対して承認します。' : '作成したときの内容（宛先・明細）に対して代表者が承認します。'}
        {blocks.length > 0 ? `承認できない理由: ${blocks.join('。')}。` : '承認の前提はそろっています。'}
      </p>
      {/* P0 R01 (B1): the fix sits where the refusal is — the order's own 支払条件 form. */}
      {gateBlocks ? (
        <p className="sx-e40c8fc">
          {/* P4 B1③ / N6: the order's own screen of THIS project, never the remembered-project address. */}
          <a className="dash-next-link" href={orderPath(projectCode, entry.order.code)}>
            発注の画面で支払条件を選ぶ（{entry.order.code}）
          </a>
        </p>
      ) : null}
      {pending.map((po) => (
        <div className="sx-72d6c38" key={po.id}>
          {canApprove && !gate?.paymentTerms ? (
            // P0 review M1: the approval certifies the 支払条件 the representative saw
            // (expectedPaymentTerms). When it cannot be read, the approval waits.
            <p className="role-notice" role="status">{APPROVAL_HELD_NO_TERMS}</p>
          ) : canApprove ? (
            // P4 N5 / H4②: the approval is recorded on the order screen's card only — the card carries the
            // terms stamp (expectedTermsStamp), the snapshot hash and the amount/date checks. This list no
            // longer records one (it sent neither the stamp nor the card's four facts).
            <p className="ui-note">
              <Link className="p1-button p1-button--primary" href={orderPath(projectCode, entry.order.code, 8)}>
                内容を見て代表承認する<span className="visually-hidden">（{entry.order.code}・{paperRef(po)}）</span>
              </Link>
              <span className="p1-muted-inline"> 承認カード（宛先・明細・金額・支払条件・納期）は発注の画面にあります。</span>
            </p>
          ) : (
            <p className="role-notice">
              メーカー発注書 {paperRef(po)} は代表承認待ちです。{operationRefusal(role, 'ceo_approve', '代表承認')}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * M8-UI2: the per-paper work area — the representative's manual confirmation
 * of a pending send, the send registration and the two-step acceptance. The
 * blocks appear from the paper's own state and events, so a form the API
 * would refuse is never offered. UI batch C: they sit inside the current-stage
 * block (③′ first while a send waits for it); the cancellation work moved to
 * the danger zone (MakerPoCancelWork) under the same conditions.
 */
/**
 * P0 R12 (M8): the send-evidence form offers only the EMLs the API would accept
 * for this paper — GET …/send-evidence-candidates leaves out the evidence of a
 * cancelled paper (its send mail cannot prove this paper's send), and says how
 * many it left out. When the list cannot be read, every registered EML stays
 * offered and the API refuses a cancelled one (SEND_EVIDENCE_FROM_CANCELLED_PO).
 */
async function SendEvidenceSection({ po, sendEvidenceChoices }: { po: MakerPoViewRow; sendEvidenceChoices: Choice[] }) {
  const result = await callApi<{ candidates?: Array<{ versionId?: unknown }>; excludedCancelledCount?: unknown }>(
    `/api/maker-purchase-orders/${encodeURIComponent(po.id)}/send-evidence-candidates`
  );
  const allowed = result.ok && Array.isArray(result.data?.candidates)
    ? new Set(result.data.candidates.map((candidate) => candidate.versionId).filter((id): id is string => typeof id === 'string'))
    : null;
  const choices = allowed ? sendEvidenceChoices.filter((choice) => allowed.has(choice.value)) : sendEvidenceChoices;
  const excluded = typeof result.data?.excludedCancelledCount === 'number' ? result.data.excludedCancelledCount : 0;
  return (
    <>
      <MakerPoSendEvidenceForm
        action={recordMakerPoSendEvidenceAction}
        poId={po.id}
        sendEvidenceChoices={choices}
        recipientAddress={po.recipientAddress ?? null}
        ceoApprovedAt={po.ceoApprovedAt ?? null}
        orderCode={po.orderCode ?? po.snapshot?.order?.code ?? null}
      />
      {excluded > 0 ? (
        <p className="ui-note">取り消したメーカー発注書の送信メール（{excluded}件）は、この発注書の送信証跡には使えないため表示していません。</p>
      ) : null}
      {choices.length === 0 ? (
        <p className="ui-note">
          参考: 「文書」画面に登録済みの送信証跡の書類はまだありません。原本を上のフォームで直接
          選ぶ場合は事前の登録は不要です。文書画面から登録するときは形式に「メール原文（EML）」を選んでください。
        </p>
      ) : null}
    </>
  );
}

function MakerPoWorkBlocks({
  paper,
  role,
  canVerifySend,
  sendEvidenceChoices,
  acceptanceEvidenceChoices
}: {
  paper: PaperWork;
  role: string | null;
  canVerifySend: boolean;
  sendEvidenceChoices: Choice[];
  acceptanceEvidenceChoices: Choice[];
}) {
  const { po, events, pendingVerifications, rejectedVerifications } = paper;

  return (
    <>
      {canVerifySend && pendingVerifications.length > 0 ? (
        <MakerPoManualVerificationBlock poId={po.id} events={pendingVerifications} />
      ) : null}

      {canVerifySend && rejectedVerifications.length > 0 ? (
        <p className="ui-note">
          手動確認履歴（却下）: {rejectedVerifications.map((verification, index) => (
            <span key={`${verification.makerPoEventId}:${index}`}>
              <span className="ui-mono">{shortId(verification.makerPoEventId)}</span>
              ／{MAKER_PO_MANUAL_VERIFICATION_RESULT_LABELS[verification.result]}
              ／{verification.verifierName ?? '—'}
              ／{formatTimestamp(verification.verifiedAt ?? verification.recordedAt)}
              {verification.reasonNote ? `／根拠: ${verification.reasonNote}` : ''}
            </span>
          ))}
        </p>
      ) : null}

      {po.status === 'APPROVED_FOR_MANUAL_SEND' ? (
        <div className="stage-block sx-2468269">
          <h3 className="sx-e6251b7">手順3: 送信の記録（担当者・代表者が記録）</h3>
          <RoleGate role={role} operation="maker_po:send_evidence" label="送信の記録">
            <p className="ui-note">
              送信はシステムの外（メール）で行うので、ここでは証跡を記録します。宛先には発注書の送信先メールアドレスが含まれている必要があります。
              送信証跡は、メールソフトの送信済みフォルダから書き出した原本のEML（.eml）です。PDFやスクリーンショット、
              メモでは送信は「確認済み」になりません。
            </p>
            <SendEvidenceSection po={po} sendEvidenceChoices={sendEvidenceChoices} />
          </RoleGate>
        </div>
      ) : null}

      {po.status === 'MAKER_PO_SENT_MANUALLY' ? (
        <MakerPoAcceptanceBlock
          po={po}
          role={role}
          events={events}
          acceptanceEvidenceChoices={acceptanceEvidenceChoices}
        />
      ) : null}
    </>
  );
}

/**
 * M8-UI2: the cancellation work of one paper (取消とその承認), rendered by the
 * caller only for the representative (maker_po:cancel) — the same conditions
 * as before, now inside the 「取り消し（代表者のみ）」 danger zone.
 */
function MakerPoCancelWork({
  paper,
  closure,
  evidenceChoices
}: {
  paper: PaperWork;
  closure: MakerPoOrderClosure | null;
  evidenceChoices: Choice[];
}) {
  const { po, sendProof, acknowledgementRecorded } = paper;
  const acknowledgementMayBeRequired = cancellationAcknowledgementMayBeRequired(po.status, sendProof);
  // A pending send counts as "recorded but unconfirmed" for the cancel copy,
  // whether or not ③′ is offered (it is not on a closed order).
  const pendingSend = paper.pendingVerification || (closure !== null && paper.events.some((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED' && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'));
  return (
    <>
      {isCancellableMakerPoStatus(po.status) ? (
        <MakerPoCancelBlock po={po} sendProof={sendProof} pendingSend={pendingSend} closure={closure} />
      ) : null}

      {acknowledgementMayBeRequired && !acknowledgementRecorded ? (
        <MakerPoCancellationAcknowledgementBlock po={po} sendProof={sendProof} closure={closure} evidenceChoices={evidenceChoices} />
      ) : null}

      {paper.offersPostDelivery ? (
        <MakerPoPostDeliveryConfirmationBlock po={po} closure={closure} evidenceChoices={evidenceChoices} />
      ) : null}

      {po.status === 'CANCELLED' && acknowledgementRecorded ? (
        <MakerPoAcknowledgementRecordedNote kind={paper.acknowledgementKind} closure={closure} />
      ) : null}
    </>
  );
}

/**
 * Recheck 8 Medium-B: a recorded acknowledgement, said as what it is. Only the
 * 取り消し承認 of a proven send speaks of 送信ずみ and of the next paper; the
 * post-delivery confirmation (decision a) is a record that changed nothing.
 */
function MakerPoAcknowledgementRecordedNote({
  kind,
  closure
}: {
  kind: CancellationAcknowledgementKind | 'unknown' | null;
  closure: MakerPoOrderClosure | null;
}) {
  const nextPaper = closure === 'cancelled'
    ? 'この発注は取消で終了しているため、新しい発注書は作成しません。'
    : closure === 'frozen'
      ? '新しい発注書は、保留・見直しが解除されてから「手順1: 発注書の作成」のフォームで作成します。'
      : '次のアクション: 訂正後の発注書を新しく作成してください（「手順1: 発注書の作成」のフォームから）。';
  return (
    <div className="sx-2468269">
      <h3 className="sx-e6251b7">{cancellationAcknowledgementLabel(kind)}: 記録済み</h3>
      <p className="ui-note">
        {kind === 'POST_DELIVERY_CONFIRMATION'
          ? 'この発注書は送信が確認されないまま取り消され（内部の訂正）、そのあとメーカーに届いていたことが記録されています。'
            + 'この記録は事実を残すだけで、取り消し承認ではありません。発注の状態も、新しい発注書を作成できるかどうかも変えていません。'
          : kind === 'unknown'
            ? '取り消し後の記録はありますが、送信の記録を読み込めなかったため、取り消し承認かメーカー到達の事後確認（記録のみ）かを画面で判定できません。画面を再読み込みしてください。'
            : `送信ずみの発注書の取消に対する取り消し承認は記録済みです。${nextPaper}`}
      </p>
    </div>
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
    <div className="stage-block sx-2468269">
      <h3 className="sx-e6251b7">手順3の確認: 送信の手動確認（代表者のみ）</h3>
      <p className="ui-note">
        メールの自動検証が断定できなかった送信記録です。原本のEMLと発注内容を見比べて、
        送信を確定する（確認）か、確定しない（却下）かを代表者が記録します。確認の
        記録は取り消せません（訂正は新しい記録として残します）。確認は発注書を受入確認待ちまで進めます。
      </p>
      {events.map((event) => (
        <div className="sx-045aac8" key={event.id}>
          <DataTable caption={`送信記録 ${shortId(event.id)}`} captionHidden>
            <thead>
              <tr>
                <th className="ui-th" scope="col">送信イベント</th>
                <th className="ui-th" scope="col">確認状態</th>
                <th className="ui-th" scope="col">送信日時</th>
                <th className="ui-th" scope="col">送信元</th>
                <th className="ui-th" scope="col">宛先</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="ui-td">
                  {shortId(event.id)}
                  <TechDetails context="ID">{event.id}</TechDetails>
                </td>
                <td className="status-cell ui-td">
                  <StatusBadge
                    tone={event.verificationStatus === 'VERIFIED' ? 'done' : 'waiting'}
                    label={MAKER_PO_EVENT_VERIFICATION_LABELS[event.verificationStatus ?? ''] ?? event.verificationStatus ?? '—'}
                  />
                </td>
                <td className="ui-td">{event.sentAt ? formatTimestamp(event.sentAt) : '—'}</td>
                <td className="ui-td">{event.senderAddress ?? '—'}</td>
                <td className="ui-td">{(event.recipients ?? []).join('、') || '—'}</td>
              </tr>
            </tbody>
          </DataTable>
          {event.verificationNote ? (
            <p className="ui-note">待っている理由: {event.verificationNote}</p>
          ) : null}
          {Array.isArray(event.verificationChecks) && event.verificationChecks.length > 0 ? (
            <div className="ui-note">
              自動チェックの結果: {event.verificationChecks.length}件
              <TechDetails context="チェック項目">{formatMakerPoVerificationChecks(event.verificationChecks).join('、')}</TechDetails>
            </div>
          ) : null}
          <ActionForm
            action={verifyMakerPoSendAction}
            submitLabel="手動確認を記録する"
            hint="検証者（ログイン中の代表者）と検証日時（記録した時刻）はシステムが記録します。根拠には何を確認したか（原本の何を見たか）を書いてください。"
            confirm={{
              title: '送信の手動確認を記録しますか？',
              body: '選んだ確認結果を記録します。確認の記録は取り消せません（訂正は新しい記録として残します）。「確認」を記録すると、発注書は受入確認待ちに進みます。',
              tone: 'danger',
              summaryFields: ['result', 'reasonNote']
            }}
          >
            <input type="hidden" readOnly name="eventId" value={event.id} />
            <input type="hidden" readOnly name="poId" value={poId} />
            <div className="form-row">
              <SelectField name="result" label="確認結果" required choices={resultChoices} width={300} />
              <TextareaField
                name="reasonNote"
                label="根拠（何を確認して送信を確定したか）"
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
 * M8-UI2: the cancel control for live paper. The box and the dialog state which
 * cancellation this is before the button is pressed, by the API's own rule
 * (cancelSendStateCopy): a proven send — a VERIFIED event or a confirmed
 * manual verification — keeps the ordering step closed until the 取り消し承認;
 * an unproven one is an internal correction that re-opens it at once.
 * SEND_UNVERIFIED and accepted paper offer no button at all — the API refuses them.
 */
const SEND_STATE_BOX_COLORS: Readonly<Record<CancelSendStateCopy['tone'], { line: string; tint: string }>> = {
  danger: { line: 'var(--danger)', tint: 'var(--danger-tint)' },
  warning: { line: 'var(--warn)', tint: 'var(--warn-tint)' },
  ok: { line: 'var(--ok)', tint: 'var(--ok-tint)' }
};

function MakerPoCancelBlock({
  po,
  sendProof,
  pendingSend,
  closure
}: {
  po: MakerPoViewRow;
  sendProof: MakerPoSendProof;
  pendingSend: boolean;
  closure: MakerPoOrderClosure | null;
}) {
  const copy = cancelSendStateCopy(sendProof, pendingSend, closure);
  const colors = SEND_STATE_BOX_COLORS[copy.tone];
  return (
    <div className="sx-9c9cee2">
      <h3 className="sx-e6251b7">発注書の取り消し（代表者のみ）</h3>
      <div style={{ ...infoBoxStyle, borderColor: colors.line, color: colors.line, background: colors.tint }}>
        <strong>この発注書の送信状態: </strong>
        {copy.status}
      </div>
      <p className="ui-note">
        取り消しは記録を消しません（取消イベントと履歴が残ります）。訂正後の発注書は新しい発注書として作成します。
        送信未確認の発注書は取り消せません。受入確認済みの発注書も取り消せません。
      </p>
      <ActionForm
        action={cancelMakerPoAction}
        submitLabel="発注書を取り消す"
        hint="取消理由（note）はAPIの必須項目です。訂正・再発注の理由を記録してください。"
        tone="danger"
        confirm={{
          title: `メーカー発注書 ${shortId(po.id)} を取り消しますか？`,
          body: copy.dialog,
          tone: 'danger',
          summaryFields: ['note']
        }}
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
 * For a paper whose proof could not be read (unknown) the block is offered too:
 * the API decides by its own proven-send rule, and for an unproven send it
 * keeps the record as the post-delivery confirmation (record only, recheck 8).
 */
function MakerPoCancellationAcknowledgementBlock({
  po,
  sendProof,
  closure,
  evidenceChoices
}: {
  po: MakerPoViewRow;
  sendProof: MakerPoSendProof;
  closure: MakerPoOrderClosure | null;
  /** Versions bound to this order and this maker PO only (Low-6). */
  evidenceChoices: Choice[];
}) {
  return (
    <div className="sx-9c9cee2">
      <h3 className="sx-e6251b7">取り消し承認を記録する（メーカー取消確認・代表者のみ）</h3>
      <p className="ui-note">
        {sendProof === 'unknown'
          ? 'この発注書の送信の記録を読み込めなかったため、この取り消しに取り消し承認が必要かどうかを画面で判定できません。送信が確認されていなかった場合、API はこの記録を「メーカー到達の事後確認（記録のみ）」として残し、発注の状態は変わりません。'
          : 'この発注書は送信ずみ（送信証跡の確認、または送信の手動確認あり）のまま取り消されています。'}
        発注先（メーカー）が取り消しを受け入れたことを代表者が確認して
        「取り消し承認」を記録してください。
        {closure === 'cancelled'
          ? 'この発注は取消で終了しているため新しい発注書は作成しませんが、送信ずみの発注書をメーカーが取り消したことの記録として残します。'
          : closure === 'frozen'
            ? '保留・見直し中でも記録できます。承認の記録まで、解除後もこの発注の新しい発注書は作成できません。'
            : '承認の記録まで、この発注の新しい発注書は作成できません（作成フォームは API が「まず取り消し承認を記録してください」と返します）。'}
      </p>
      <ActionForm
        action={acknowledgeMakerPoCancellationAction}
        submitLabel="取り消し承認を記録する"
        hint="承認理由（note）はAPIの必須項目です。証跡の引用は任意で、引用できるのはこの発注書に紐付けて登録し、確認済みにした受領証跡のバージョンだけです。"
        confirm={{
          title: '取り消し承認を記録しますか？',
          body: `メーカーが発注書 ${shortId(po.id)} の取り消しを受け入れたことを記録します。${sendProof === 'unknown'
            ? '送信が確認されていなかった場合は「メーカー到達の事後確認（記録のみ）」として残り、新しい発注書の作成可否は変わりません。'
            : closure === 'cancelled'
              ? 'この発注は取消で終了しているため、新しい発注書は作成されません。'
              : closure === 'frozen'
                ? '保留・見直しの解除後に、この発注の新しい発注書を作成できるようになります。'
                : '記録すると、この発注の新しい発注書を作成できるようになります。'}記録は取り消せません。`,
          summaryFields: ['note', 'evidenceDocumentVersionId']
        }}
      >
        <input type="hidden" readOnly name="poId" value={po.id} />
        <div className="form-row">
          <TextareaField name="note" label="承認理由（取り消しを確認した根拠）" required rows={3} width={520} />
          <OffsetDateTimeField name="acknowledgedAt" label="承認日時（任意）" width={240} />
          {evidenceChoices.length > 0 ? (
            <SelectField
              name="evidenceDocumentVersionId"
              label="メーカー側の承諾を示す書類バージョン（任意・この発注書に紐付いた確認済みの受領証跡のみ）"
              includeBlank
              choices={evidenceChoices}
              width={420}
            />
          ) : null}
        </div>
        {evidenceChoices.length === 0 ? (
          <p className="ui-note">
            引用できる書類はありません（証跡は任意です）。証跡として引用できるのは、この発注とこのメーカー発注書
            （{shortId(po.id)}）の両方に紐付けて登録し、「確認済み」にした受領証跡（検収）の書類だけです。この発注の
            ほかの書類は API が拒否するため候補に出していません。根拠は承認理由に書いてください。
          </p>
        ) : null}
      </ActionForm>
    </div>
  );
}

/**
 * Recheck 8 Medium-B, representative decision (a): an internally cancelled
 * paper (its send was recorded but never proven) that turns out to have
 * reached the maker. The representative records that fact on the same
 * endpoint; the API keeps it as POST_DELIVERY_CONFIRMATION — record only: it
 * never re-opens the order, never lifts a gate, and answers a warning when a
 * replacement paper is already live (API_CONTRACT recheck8-fix). Folded: it is
 * not owed work, only an exception the representative may need.
 */
function MakerPoPostDeliveryConfirmationBlock({
  po,
  closure,
  evidenceChoices
}: {
  po: MakerPoViewRow;
  closure: MakerPoOrderClosure | null;
  /** Versions bound to this order and this maker PO only (Low-6). */
  evidenceChoices: Choice[];
}) {
  return (
    <details className="sx-9c9cee2">
      <summary className="sx-49f2b59">
        メーカー到達の事後確認を記録する（記録のみ・代表者のみ）— 発注書 {shortId(po.id)}
      </summary>
      <p className="ui-note">
        この発注書は送信が確認されないまま取り消されました（内部の訂正。取り消し承認は不要です）。
        あとからメーカーに届いていたと分かった場合だけ、その事実を記録します。
        この記録は取り消し承認ではありません。発注の状態も、新しい発注書を作成できるかどうかも変わりません
        {closure === 'cancelled' ? '（この発注は取消で終了したままです）' : ''}。
        訂正後の発注書がすでにある場合は、メーカーが二重に生産しないよう、記録とは別にメーカーへ連絡してください。
        記録は発注書ごとに1回だけで、取り消せません。
      </p>
      <ActionForm
        action={acknowledgeMakerPoCancellationAction}
        submitLabel="メーカー到達の事後確認を記録する"
        hint="確認の根拠（note）はAPIの必須項目です。日時を入れる場合は、この発注書の取り消しの記録より後の日時にしてください。"
        confirm={{
          title: 'メーカー到達の事後確認を記録しますか？',
          body: `取り消し済みの発注書 ${shortId(po.id)} がメーカーに届いていたことを記録します。記録のみで、発注の状態と新しい発注書の作成可否は変わりません。記録は取り消せません。`,
          summaryFields: ['note', 'evidenceDocumentVersionId']
        }}
      >
        <input type="hidden" readOnly name="poId" value={po.id} />
        <div className="form-row">
          <TextareaField name="note" label="確認の根拠（メーカーに届いていたと分かった経緯）" required rows={3} width={520} />
          <OffsetDateTimeField name="acknowledgedAt" label="確認日時（任意）" width={240} />
          {evidenceChoices.length > 0 ? (
            <SelectField
              name="evidenceDocumentVersionId"
              label="根拠の書類バージョン（任意・この発注書に紐付いた確認済みの受領証跡のみ）"
              includeBlank
              choices={evidenceChoices}
              width={420}
            />
          ) : null}
        </div>
        {evidenceChoices.length === 0 ? (
          <p className="ui-note">
            引用できる書類はありません（証跡は任意です）。根拠は「確認の根拠」に書いてください。
          </p>
        ) : null}
      </ActionForm>
    </details>
  );
}

/** UI batch E (F-22): 「受入日時 2026/11/19 14:00 JST（記録 2026/11/19 14:05 JST）」. */
function provisionalRecordText(event: MakerPoEventRow): string {
  const accepted = event.sentAt ? formatTimestamp(event.sentAt) : '未入力';
  return `メーカー受入の日時: ${accepted}（記録した日時: ${formatTimestamp(event.recordedAt)}）`;
}

/**
 * UI batch E (F-10): the final confirmation needs a 受領証跡 bound to this paper
 * and checked 確認済み. The sentence names who can do each part for this role
 * (display only; the API decides).
 */
function finalAcceptancePrerequisite(role: string | null, provisionalCount: number): string {
  const upload = canRoleOperate(role, 'document:create');
  const verify = canRoleOperate(role, 'document:verify');
  const head = provisionalCount > 0
    ? '仮の受入記録はあります。最終受入確認の前に、受領証跡（メーカーの受入・検収を示す書類）が必要です。'
    : '最終受入確認には、受領証跡（メーカーの受入・検収を示す書類）が必要です。';
  if (upload && verify) {
    return `${head}「文書」画面で、書類種別「受領証跡」としてこの発注とこのメーカー発注書に紐付けてアップロードし、確認済みにしてください。そのあと、ここで最終受入確認を記録します（代表者）。`;
  }
  if (upload) {
    return `${head}「文書」画面で、書類種別「受領証跡」としてこの発注とこのメーカー発注書に紐付けてアップロードしてください。確認済みにする記録と最終受入確認は代表者が行います。`;
  }
  return `${head}受領証跡の登録・確認と最終受入確認は、担当者と代表者が行います。`;
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
    <div className="stage-block sx-2468269">
      <h3 className="sx-e6251b7">手順4: メーカー受入記録</h3>
      <p className="ui-note">
        受入は二段階です。まず担当者が「受入記録（仮）」を書き、そのあと代表者が受領証跡を検証して
        「最終受入確認」を記録します。仮の記録だけでは発注書は受入済みになりません。
      </p>
      <p className="ui-note">
        仮の受入記録: {provisionalCount}件
        {provisionalCount > 0 ? null : ' ／ 次のアクション: 担当者が受入記録（仮）を記録してください。'}
      </p>
      {provisionalCount > 0 ? (
        // UI batch E (F-22): the maker's acceptance time (as entered, or 未入力) and
        // the time the record was written are two different things.
        <ul className="ui-note sx-31dd06c">
          {provisionalRecords.map((event) => (
            <li key={event.id}>{provisionalRecordText(event)}</li>
          ))}
        </ul>
      ) : null}
      {acceptanceEvidenceChoices.length === 0 ? (
        // UI batch E (F-10): what the final confirmation waits for, said to every
        // role — the staff member who can upload the evidence included.
        <p className="role-notice">{finalAcceptancePrerequisite(role, provisionalCount)}</p>
      ) : null}

      <RoleGate role={role} operation="maker_po:accept_provisional" label="受入記録（仮）">
        <details className="sx-72d6c38" open={provisionalCount === 0}>
          <summary className="sx-eefff2f">受入記録（仮）を書く（担当者・代表者）</summary>
          <ActionForm
            action={recordProvisionalAcceptanceAction}
            submitLabel="受入記録（仮）を記録する"
            hint="この記録は「仮」と明示され、発注書の状態は動きません。最終受入確認は代表者だけが記録できます。"
            confirm={{
              title: '受入記録（仮）を記録しますか？',
              body: 'メーカー受入を「仮」の記録として残します。発注書の状態は動きません。日時を入力しなかった場合は、受入日時なしで記録されます。記録は履歴に残り、取り消す操作はありません。',
              tone: 'primary',
              summaryFields: ['acceptedAt']
            }}
          >
            <input type="hidden" readOnly name="poId" value={po.id} />
            <OffsetDateTimeField name="acceptedAt" label="メーカー受入の日時" width={240} />
          </ActionForm>
        </details>
      </RoleGate>

      {canAcceptFinal ? (
        acceptanceEvidenceChoices.length === 0 ? null : (
          // UI batch E (F-21): this is the current step once the evidence exists — open.
          <details open>
            <summary className="sx-eefff2f">最終受入確認を記録する（代表者のみ）</summary>
            <ActionForm
              action={recordFinalAcceptanceAction}
              submitLabel="最終受入確認を記録する"
              hint={
                provisionalCount > 0
                  ? `仮の受入記録が ${provisionalCount}件 あります。最終確認はその記録を引き継いで確定します。`
                  : '仮の受入記録がなくても最終確認は可能です（記録には事前に確認済みの受領証跡が必要です）。'
              }
              confirm={{
                title: '最終受入確認を記録しますか？',
                body: '選んだ受領証跡を引用して最終受入確認を記録し、発注書を「受入確認済み（最終）」にします。この記録は取り消せません。',
                summaryFields: ['evidenceDocumentVersionId', 'acceptedAt']
              }}
            >
              <input type="hidden" readOnly name="poId" value={po.id} />
              <div className="form-row">
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
  /** The maker_po_event read came back whole (fewer rows than the cap). */
  makerEventsComplete: boolean;
}

async function loadMakerPoAudit(projectId: string): Promise<MakerPoAuditPayload> {
  const base = `/api/projects/${encodeURIComponent(projectId)}/audit-history`;
  const [poEvents, makerEvents] = await Promise.all([
    callApi<{ events: AuditEventView[] }>(`${base}?entityType=maker_purchase_order&limit=200`),
    callApi<{ events: AuditEventView[] }>(`${base}?entityType=maker_po_event&limit=${MAKER_PO_AUDIT_WINDOW}`)
  ]);
  if (!poEvents.ok && !makerEvents.ok) {
    return { events: [], error: poEvents.error ?? makerEvents.error ?? '監査履歴が取得できませんでした。', makerEventsComplete: false };
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
  const makerEventsComplete = makerEvents.ok && makerEvents.data !== null
    && Array.isArray(makerEvents.data?.events) && makerRows.length < MAKER_PO_AUDIT_WINDOW;
  return { events, error: null, makerEventsComplete };
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
  MAKER_PO_DUAL_APPROVAL_RECHECK: '両組織の承認の再確認',
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

/**
 * Recheck 9 Medium-3: the kind each card judged for its acknowledgement, by
 * acknowledgement event id — the dashboard says what the card says.
 */
function acknowledgementKindsOfCards(
  cards: ReadonlyArray<OrderCard>
): Map<string, CancellationAcknowledgementKind | 'unknown'> {
  const kinds = new Map<string, CancellationAcknowledgementKind | 'unknown'>();
  for (const card of cards) {
    for (const paper of card.papers) {
      if (paper.acknowledgementKind === null) continue;
      for (const event of paper.events) {
        if (event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED') kinds.set(event.id, paper.acknowledgementKind);
      }
    }
  }
  return kinds;
}

/**
 * The label of one MAKER_CANCELLATION_ACKNOWLEDGED audit row: the kind the
 * row carries (admin), else the card's judgement, else 'unknown' — never the
 * 取り消し承認 by default (staff rows carry no kind; recheck 9 Medium-3).
 */
function acknowledgementAuditLabel(
  event: AuditEventView,
  cardKinds: ReadonlyMap<string, CancellationAcknowledgementKind | 'unknown'>
): string {
  const audited = acknowledgementKindsFromAuditEvents([event]).get(event.entityId);
  return cancellationAcknowledgementLabel(audited ?? cardKinds.get(event.entityId) ?? 'unknown');
}

function AuditDashboardSection({
  events,
  error,
  role,
  acknowledgementKinds
}: {
  events: AuditEventView[];
  error: string | null;
  role: string | null;
  acknowledgementKinds: ReadonlyMap<string, CancellationAcknowledgementKind | 'unknown'>;
}) {
  return (
    // UI batch C (2-④): folded, its count in the summary.
    <details className="collapsed-card ui-card">
      <summary>
        <h2 className="sx-51ef381">
          監査ダッシュボード（役割に応じた表示）— {events.length}件
        </h2>
      </summary>
      <p className="ui-note">
        監査履歴をメーカー発注の記録だけに絞って表示します。
        {normalizeRole(role) === 'admin'
          ? '表示内容は API が役割ごとに決めます: 代表者は金額やスナップショットまで、担当者は状態の形だけ、閲覧者は概要だけを見ます。'
          : '表示内容は API が役割ごとに決めます（この役割には記録の概要だけが表示されます）。'}
        現在の役割: {role === null ? '確認できません' : roleLabel(role)}。
      </p>
      {error ? <div className="ui-info">{error}</div> : null}
      {events.length === 0 ? (
        <p className="ui-note">メーカー発注の監査記録はまだありません。</p>
      ) : (
        <DataTable caption="メーカー発注の監査記録" captionHidden>
          <thead>
            <tr>
              <th className="ui-th" scope="col">日時</th>
              <th className="ui-th" scope="col">記録の内容</th>
              <th className="ui-th" scope="col">種別</th>
              <th className="ui-th" scope="col">状態（役割に見える範囲）</th>
              <th className="ui-th" scope="col">実行者</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const after = (event.afterState ?? null) as Record<string, unknown> | null;
              const status = after && typeof after.status === 'string' ? after.status : null;
              return (
                <tr key={event.id}>
                  <td className="ui-td">{formatTimestamp(event.occurredAt)}</td>
                  <td className="ui-td">
                    {event.action === 'MAKER_CANCELLATION_ACKNOWLEDGED' && event.entityType === 'maker_po_event'
                      ? acknowledgementAuditLabel(event, acknowledgementKinds)
                      : AUDIT_ACTION_LABELS[event.action] ?? MAKER_PO_EVENT_TYPE_LABELS[event.action] ?? event.action}
                  </td>
                  <td className="ui-td">
                    {AUDIT_ENTITY_LABELS[event.entityType] ?? event.entityType}
                    <TechDetails context="コード・ID">
                      <p>{event.action}</p>
                      <p>{event.entityId}</p>
                    </TechDetails>
                  </td>
                  <td className="ui-td">
                    {status ? MAKER_PO_STATUS_LABELS[status] ?? status : '—'}
                    {after && after.provisional === true ? '（仮の受入記録を含む）' : ''}
                  </td>
                  <td className="ui-td">{event.actor?.displayName ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </details>
  );
}
