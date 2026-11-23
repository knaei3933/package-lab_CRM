import { Bilingual } from './Bilingual';
import { OffsetDateTimeField } from './OffsetDateTimeField';
import Link from 'next/link';
import { ActionForm } from './ActionForm';
import { MakerPoSendEvidenceForm } from './MakerPoSendEvidenceForm';
import { RecipientChooser } from './RecipientChooser';
import { StepFileField } from './StepFileField';
import { CheckboxField, SelectField, TextareaField, TextField } from './fields';
import { transitionFilmSupplyOrderAction, updateFilmPaymentTermsAction } from '../app/actions';
import { recordMakerPoSendEvidenceAction, verifyMakerPoSendAction } from '../app/maker-po/actions';
import { ApprovalCard } from './ApprovalCard';
import type { ApprovalCardView } from '../lib/approval-card';
import {
  createMakerPoStepAction,
  recordAcceptanceStepAction,
  recordApprovalStepAction,
  recordDeliveryStepAction,
  submitArtworkStepAction,
  submitProofStepAction
} from '../app/step-actions';
import { EVIDENCE_NOTE_FIELD } from '../lib/transition-evidence';
import { makerPoNumberOf, PAYMENT_TERMS_LABELS } from '../lib/maker-po-data';
import type { RecipientChoices } from '../lib/maker-master';
import type { MakerPoEventRow, MakerPoViewRow } from '../lib/maker-po-data';
import { waitingText } from '../lib/order-flow';
import type { ApprovalSlotDesign, ApprovalSlotState, OrderFlowView } from '../lib/order-flow';
import type { ApprovalGateView, DocumentView, FilmSupplyOrderView, SevenPurchaseOrderView } from '../lib/project-data';
import { projectPath } from '../lib/project-route';
import { formatTimestampSeconds, sendApprovalGapText, unitLabel } from '../lib/vocabulary';
import { formatQuantity } from '../lib/number-format';
import { SevenPoChecklistForm, SevenPoRegisterForm } from './SevenPoForms';
import { PendingVerificationSection } from './EvidenceVerificationSection';
import { CancellationReviewForm, ChangeReviewResumeForm, HoldReleaseForm } from './OrderExceptionForms';
import { DeliveryReceiptStep, RECEIPT_ISSUER_CHOICES } from './DeliveryReceiptStep';
import type { DeliveryContext } from './DeliveryReceiptStep';
import type { MakerPaperCleanupSummary } from '../lib/maker-po-data';
import { canRoleOperate, normalizeRole } from '../lib/permissions';
import { VERIFICATION_STATUS_LABELS } from '../lib/vocabulary';

/**
 * P1 R21: the 「現在の手順」 panel — ONE primary action for the step, the
 * reason and the one fix when it is blocked (§3-3), or what the step waits for
 * when the signed-in role cannot do it (相手待ち). Forms are the shared shells
 * (FeedbackForm: rendered project, Idempotency-Key, field errors, focus on the
 * result); evidence is uploaded inside the step (R22). The API decides.
 */
interface StepPanelProps {
  flow: OrderFlowView;
  order: FilmSupplyOrderView;
  projectCode: string;
  role: string;
  po: SevenPurchaseOrderView | null;
  gate: ApprovalGateView | null;
  maker: MakerPoViewRow | null;
  makerEvents: readonly MakerPoEventRow[];
  documents: readonly DocumentView[];
  stateLabel: (key: string) => string;
  /** R24: the approval card of the paper waiting for the 代表承認 (admin only). */
  approvalCard?: ApprovalCardView | null | undefined;
  /**
   * P2 R33: the project maker's recipient addresses for the maker PO form
   * (lib/maker-master loadMakerRecipients). Absent: typed address only.
   */
  recipients?: RecipientChoices | undefined;
  /** P2 R33: the project's latest typed (non-master) address, a hint of 「直接入力する」 only. */
  previousTypedRecipient?: string | null | undefined;
  /** P4 H14: the deliveries, readiness and uploader facts of step 12 (absent: not read). */
  deliveryContext?: DeliveryContext | undefined;
  /** P4 §0: the maker paper left on the order (the cancellation review's warning). */
  makerCleanup?: MakerPaperCleanupSummary | undefined;
}

const TERMS_CHOICES = [
  { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
  { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
  { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
];

const CURRENCY_CHOICES = [
  { value: 'JPY', label: '日本円（JPY）' },
  { value: 'USD', label: '米ドル（USD）' },
  { value: 'CNY', label: '人民元（CNY）' },
  { value: 'KRW', label: '韓国ウォン（KRW）' }
];

/** The hidden fields every step form carries (the order, and where its success link goes). */
function OrderFields({ order, projectCode }: { order: FilmSupplyOrderView; projectCode: string }) {
  return (
    <>
      <input type="hidden" readOnly name="orderId" value={order.id} />
      <input type="hidden" readOnly name="orderCode" value={order.code} />
      <input type="hidden" readOnly name="projectCode" value={projectCode} />
    </>
  );
}

/**
 * P2 R32 (DESIGN §6): the paper this step is about, by its MPO number — or the
 * order-code name when the API did not answer one.
 */
function PaperLine({ maker, orderCode }: { maker: MakerPoViewRow | null; orderCode: string }) {
  if (!maker) return null;
  const number = makerPoNumberOf(maker.displayNumber);
  return (
    <p className="p1-muted-inline p2-paper-line">
      {number ? <>メーカー発注書 <span translate="no" className="p1-figure p2-mpo-number">{number}</span></> : `${orderCode} のメーカー発注書`}
    </p>
  );
}

function Waiting({ text }: { text: string }) {
  return <p className="p1-waiting"><span aria-hidden="true">… </span>{text}</p>;
}

export function StepPanelView(props: StepPanelProps) {
  const { flow, order, projectCode } = props;
  const { action, canAct, actor, blocked } = flow.panel;

  if (blocked) {
    return (
      <div className="p1-blocked" role="group" aria-labelledby="blocked-title">
        <p id="blocked-title" className="p1-blocked-title"><span aria-hidden="true">✕ </span>進められません</p>
        <p>{blocked.reason}</p>
        {blocked.fix === 'payment_terms' && canAct ? (
          <ActionForm
            action={updateFilmPaymentTermsAction}
            submitLabel="支払条件を記録する"
            hint="変更できる人: 担当者・代表 ／ 変更は履歴に残ります。記録は入金確認ではありません。"
          >
            <input type="hidden" readOnly name="orderId" value={order.id} />
            <SelectField name="paymentTerms" label="支払条件" required includeBlank blankLabel="（選ぶ）" choices={TERMS_CHOICES.filter((choice) => choice.value !== 'undetermined')} />
            <TextField name="reason" label="変更の理由（任意）" width={360} />
          </ActionForm>
        ) : (
          <Waiting text="支払条件は担当者か代表が記録します。" />
        )}
      </div>
    );
  }

  if (!canAct && actor !== null) {
    return <Waiting text={`${waitingText(actor)}${waitDetail(action)}`} />;
  }

  switch (action.kind) {
    case 'po_check':
      // P4 §0: 本登録 and 照合 are recorded here (they used to open the old 発注の一覧 table).
      if (!action.poId) return <p>{`この発注にはセブン化学発注書が紐付いていません。`}<Link href={`${projectPath(projectCode, 'new')}`}>新しい発注として登録し直す</Link></p>;
      return (
        <>
          <p>{action.registered ? 'セブン化学発注書の照合（7項目のチェック）がまだです。' : 'セブン化学発注書の本登録がまだです。'}</p>
          {action.registered
            ? <SevenPoChecklistForm poId={action.poId} poNumber={props.po?.poNumber ?? null} role={props.role} />
            : <SevenPoRegisterForm poId={action.poId} poNumber={props.po?.poNumber ?? null} role={props.role} />}
        </>
      );
    case 'advance':
      // P2 R22: 4 デザイン入稿 registers the file itself (an order without its セブン化学発注書 keeps the memo form).
      if (action.to === 'ARTWORK_RECEIVED' && order.sevenPurchaseOrderId) return <ArtworkStep {...props} />;
      return (
        <ActionForm action={transitionFilmSupplyOrderAction} submitLabel={action.label} hint={action.hint}>
          <OrderFields order={order} projectCode={projectCode} />
          <input type="hidden" readOnly name="to" value={action.to} />
          {action.evidenceNote === 'none' ? null : (
            <TextareaField
              name={EVIDENCE_NOTE_FIELD}
              label={action.to === 'ARTWORK_RECEIVED' ? '受け取ったデザインのメモ（履歴に保存）' : '証跡のメモ（履歴に保存）'}
              required={action.evidenceNote === 'required'}
              hint="例: 表面A・裏面B の入稿データを 11/20 に顧客からメールで受領（ファイル名 …）"
              rows={2}
            />
          )}
        </ActionForm>
      );
    case 'proof':
      return <ProofStep {...props} designKeys={action.designKeys} />;
    case 'approvals':
      return <ApprovalSlots {...props} designs={action.designs} />;
    case 'evidence_check':
      // P4 §0: the representative's check is recorded here (it used to open the old 承認 screen).
      return (
        <>
          <p><Bilingual ja={`PDF・画像の承認証跡が ${action.count} 件、代表の確認を待っています。発行元と識別子を確かめて記録します。`} ko={`PDF·이미지 승인 증빙 ${action.count}건이 대표 확인을 기다립니다. 발행처와 식별자를 확인해 기록합니다.`} /></p>
          <PendingVerificationSection
            pending={props.gate?.pendingManualVerifications ?? []}
            role={props.role}
            canVerify={canRoleOperate(props.role, 'artwork_approval:verify_evidence')}
            evidenceLabel={(versionId) => evidenceLabelOf(props.documents, versionId)}
            organizationText={organizationText}
          />
        </>
      );
    case 'payment_terms':
      return null;
    case 'maker_po_create':
      return (
        <ActionForm
          action={createMakerPoStepAction}
          submitLabel={`${order.code} のメーカー発注書（下書き）を作る`}
          hint="明細・校了した版・支払条件はこの発注から写されます（スナップショット）。作成のあと、代表が内容を見て承認します。"
        >
          <OrderFields order={order} projectCode={projectCode} />
          <input type="hidden" readOnly name="needsReadyTransition" value={action.needsReadyTransition ? 'true' : 'false'} />
          <RecipientChooser choices={props.recipients ?? { kind: 'not_loaded' }} previousTyped={props.previousTypedRecipient} showMakersLink={props.role === 'admin'} />
          {/* Amounts are the representative's (staff never see them): only the representative types one here. */}
          {props.role === 'admin' ? (
            <div className="p1-row">
              <SelectField name="currency" label="通貨" choices={CURRENCY_CHOICES} defaultValue="JPY" width={200} />
              <TextField name="totalAmount" label="金額（数字のみ・任意）" width={200} placeholder="480000" autoComplete="off" inputMode="decimal" />
            </div>
          ) : null}
        </ActionForm>
      );
    case 'ceo_approve':
      return props.approvalCard
        ? <ApprovalCard card={props.approvalCard} korean={props.role === 'admin'} />
        : <p>メーカー発注書を読み込めませんでした。画面を再読み込みしてください。</p>;
    case 'send':
      return (
        <>
          <PaperLine maker={props.maker} orderCode={order.code} />
          <MakerPoSendEvidenceForm
            action={recordMakerPoSendEvidenceAction}
            poId={action.poId}
            sendEvidenceChoices={[]}
            recipientAddress={props.maker?.recipientAddress ?? props.maker?.snapshot?.recipient?.address ?? null}
            ceoApprovedAt={props.maker?.ceoApprovedAt ?? null}
            orderCode={order.code}
          />
        </>
      );
    case 'send_verify':
      return (
        <>
          <PaperLine maker={props.maker} orderCode={order.code} />
          <ActionForm
            action={verifyMakerPoSendAction}
            submitLabel="送信の確認を記録する"
            submitLabelKo="송신 확인을 기록"
            hint="確認者と日時は自動で記録されます。"
            hintKo="확인자와 일시는 자동으로 기록됩니다."
          >
            <input type="hidden" readOnly name="eventId" value={action.eventId} />
            <p><Bilingual ja="送信メールを自動では確かめられませんでした。宛先・送信日時・件名を原本で確認してください。" ko="송신 메일을 자동으로 확인하지 못했습니다. 수신처·송신 일시·제목을 원본에서 확인하세요." /></p>
            <SendWaitFacts event={props.makerEvents.find((event) => event.id === action.eventId) ?? null} approvedAt={props.maker?.ceoApprovedAt ?? null} />
            <SelectField name="result" label="確認の結果" required includeBlank blankLabel="（選ぶ）" choices={[{ value: 'confirmed', label: '確認済み（送信された）' }, { value: 'rejected', label: '相違あり（送信として認めない）' }]} />
            <TextareaField name="reasonNote" label="根拠（何を確かめたか）" required rows={2} />
          </ActionForm>
        </>
      );
    case 'send_stuck':
      return (
        <>
          <PaperLine maker={props.maker} orderCode={order.code} />
          <p><Bilingual ja="送信未確認のまま止まっています（証跡なしの送信）。証跡をそろえたうえで代表が判断します。" ko="송신 미확인 상태로 멈춰 있습니다(증빙 없는 송신). 증빙을 갖춘 뒤 대표가 판단합니다." /></p>
          <p className="p1-note">この発注書は取り消せません（送信未確認）。必要なら下の「その他の操作」で保留・取消確認にします。<Link href={`${projectPath(projectCode, 'maker-po')}#maker-order-${order.id}`}>メーカー発注の一覧（閲覧）</Link></p>
        </>
      );
    case 'accept':
      return (
        <>
          <PaperLine maker={props.maker} orderCode={order.code} />
          <AcceptStep {...props} poId={action.poId} provisionalRecorded={action.provisionalRecorded} />
        </>
      );
    case 'deliver':
      return (
        <ActionForm action={recordDeliveryStepAction} submitLabel="納品を記録する" hint="明細ごとに受け取った数量を確かめます（初期値は発注数量）。">
          <OrderFields order={order} projectCode={projectCode} />
          {order.lines.map((line) => (
            <div key={line.id} className="p1-row">
              <input type="hidden" readOnly name="lineId" value={line.id} />
              <input type="hidden" readOnly name={`unit_${line.id}`} value={line.unit} />
              <TextField
                name={`quantity_${line.id}`}
                label={`明細${line.lineNumber} ${line.description}（${unitLabel(line.unit)}）の納品数量`}
                required
                width={200}
                defaultValue={formatQuantity(line.orderedQuantity).replace(/,/g, '')}
              />
            </div>
          ))}
          {/* P4 N15: the same date + time inputs as every other date of a record (no native date picker). */}
          <OffsetDateTimeField name="deliveredAt" label="納品日（任意・未入力は現在日時）" />
          {/* P4 H14: the receipt evidence may come with the delivery — then the quantity is confirmed in the same submit. */}
          <fieldset className="p4w2-fieldset">
            <legend>受領証跡（あれば・任意）</legend>
            <StepFileField label="受領証跡のファイル" required={false} hint="受領書・受領メール（.eml）など。付けると、この記録と同時に納品数量を確認します（担当者が付けた証跡は代表が確認します）。" />
            <SelectField name="receiptIssuer" label="受領証跡の発行元（ファイルを付けるとき）" includeBlank blankLabel="（選ぶ）" choices={RECEIPT_ISSUER_CHOICES} width={300} />
            <input type="hidden" readOnly name="receiptMode" value={normalizeRole(props.role) === 'admin' ? 'confirm' : 'register'} />
            {order.sevenPurchaseOrderId ? <input type="hidden" readOnly name="sevenPurchaseOrderId" value={order.sevenPurchaseOrderId} /> : null}
            <input type="hidden" readOnly name="evaluateReadiness" value={canRoleOperate(props.role, 'commission_readiness:evaluate') ? 'true' : 'false'} />
          </fieldset>
        </ActionForm>
      );
    case 'receipt':
      // P4 H14: the receipt evidence is the main path; 「証跡なしで完了」 is the fallback inside it.
      return (
        <DeliveryReceiptStep
          order={order}
          projectCode={projectCode}
          role={props.role}
          documents={props.documents}
          context={props.deliveryContext ?? EMPTY_DELIVERY_CONTEXT}
          completed={false}
        />
      );
    case 'done':
      return (
        <>
          <p className="p1-done"><span aria-hidden="true">✓ </span>この発注はすべての手順が終わりました。</p>
          {/* P4 H14: a closed order whose delivery is still unconfirmed is confirmed here (no old screen). */}
          {props.deliveryContext ? (
            <DeliveryReceiptStep order={order} projectCode={projectCode} role={props.role} documents={props.documents} context={props.deliveryContext} completed />
          ) : null}
          <p className="p1-note">手数料計算の準備は納品数量の確定で判定されます（フィルムのみの発注は充填の納品要件が対象外）。<Link href={projectPath(projectCode, 'deliveries')}>納品・手数料の一覧（閲覧）</Link></p>
        </>
      );
    case 'hold':
    case 'cancellation_review':
      return (
        <>
          <p>
            {action.kind === 'hold'
              ? <Bilingual ja="この発注は保留中です。解除は代表が理由を書いて行います。" ko="이 발주는 보류 중입니다. 해제는 대표가 사유를 적어 처리합니다." />
              : <Bilingual ja="この発注は取消確認中です。再開するか取消で終了するかを代表が決めます（取消で終了は元に戻せません）。" ko="이 발주는 취소 확인 중입니다. 재개할지 취소로 종료할지 대표가 결정합니다(취소 종료는 되돌릴 수 없음)." />}
          </p>
          {/* P4 §0: released / resolved here (approved server rules 3·4: the representative only — the API decides). */}
          {action.kind === 'hold'
            ? <HoldReleaseForm order={order} role={props.role} stateLabel={props.stateLabel} projectCode={projectCode} />
            : <CancellationReviewForm order={order} role={props.role} stateLabel={props.stateLabel} makerCleanup={props.makerCleanup} projectCode={projectCode} />}
        </>
      );
    case 'change_review':
      return (
        <>
          <p>この発注は変更確認中です（承認後のロット表記・ファイルの変更）。再開する段階を選んで戻します。</p>
          <ChangeReviewResumeForm order={order} role={props.role} stateLabel={props.stateLabel} projectCode={projectCode} />
        </>
      );
    case 'cancelled':
      return <p>この発注は取消で終了しました。これ以上の手順はありません。</p>;
    case 'unreadable':
      return <p>{action.reason}</p>;
    default:
      return null;
  }
}

function waitDetail(action: OrderFlowView['panel']['action']): string {
  switch (action.kind) {
    case 'maker_po_create':
      return '（担当者または代表がメーカー発注書を作ります）';
    case 'ceo_approve':
      return '（メーカー発注書の代表承認）';
    case 'evidence_check':
      return '（PDF・画像の承認証跡の確認）';
    case 'send_verify':
      return '（送信メールの確認）';
    case 'accept':
      return '（メーカー受注の最終確認）';
    case 'hold':
      return '（保留の解除は代表）';
    case 'cancellation_review':
      return '（取消確認の処理は代表）';
    default:
      return '';
  }
}

/**
 * P2 R22 (DESIGN §9): 4 デザイン入稿 — the customer's design data, registered as
 * 「デザイン入稿データ」 bound to this order, then デザイン受領, in one submit.
 * Without a file, 「ファイルがなく、受領だけを記録する」 records the receipt with
 * the memo (the P1 way). The file field is not required in the browser for that
 * reason; the server action asks for the file or the memo.
 */
function ArtworkStep({ order, projectCode }: StepPanelProps) {
  return (
    <ActionForm
      action={submitArtworkStepAction}
      submitLabel="デザイン入稿データを登録して、受領済みにする"
      hint="入稿ファイルはこの発注に紐付けて保存され、セブン化学発注書はこの発注のものが自動で紐付きます。ファイルがないときは、下のチェックを入れてメモだけで受領を記録します。"
      successHint="次の手順: 校正の登録"
    >
      <OrderFields order={order} projectCode={projectCode} />
      <StepFileField
        label="デザイン入稿データ"
        required={false}
        hint="顧客から受け取った入稿ファイル（PDF・画像など、5MBまで）。この発注に紐付けて保存されます。"
      />
      <TextField
        name="designKey"
        label="デザイン名（任意）"
        width={220}
        hint="版を分けて管理するときだけ。例 表面A"
        autoComplete="off"
      />
      <TextareaField
        name={EVIDENCE_NOTE_FIELD}
        label="メモ（任意・履歴に保存）"
        rows={2}
        hint="例: 11/20 に顧客からメールで受領。ファイルがないときは必須です。"
      />
      <CheckboxField name="noFile" label="ファイルがなく、受領だけを記録する" />
    </ActionForm>
  );
}

/** 5 校正: one design's proof file → 版 → 校了確認待ち, in one submit. */
function ProofStep({ order, projectCode, po, designKeys }: StepPanelProps & { designKeys: string[] }) {
  if (!po) return <p>セブン化学発注書が紐付いていないため、校正を登録できません。発注一覧で確認してください。</p>;
  return (
    <ActionForm
      action={submitProofStepAction}
      submitLabel="校正を登録して校了の確認へ"
      hint="メーカーの校正ゲラ（PDF・画像）を選びます。版の登録と、校了の確認待ちへの切り替えまでこの1回で行います。"
    >
      <OrderFields order={order} projectCode={projectCode} />
      <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po.id} />
      <input type="hidden" readOnly name="currentStatus" value={order.status} />
      <TextField
        name="designKey"
        label="デザイン名"
        required
        width={240}
        defaultValue={designKeys[0] ?? '表面A'}
        hint="この発注の中でデザインを区別する名前です（例: 表面A・裏面B）。"
      />
      <StepFileField label="校正ゲラのファイル" hint="5MBまで。形式はファイルから判別します。" />
      <TextField name="lotMarking" label="ロット表記（任意）" width={240} />
    </ActionForm>
  );
}

const SLOT_TEXT: Record<ApprovalSlotState, string> = {
  approved: '承認',
  pending_check: '代表の確認待ち',
  open: '未承認'
};

/** 6 校了: the 押印 slots — each organization's own approval, on its own evidence (B2). */
function ApprovalSlots({ order, projectCode, po, designs, role }: StepPanelProps & { designs: ApprovalSlotDesign[] }) {
  if (designs.length === 0) return <p>承認する版がまだありません（校正の登録が先です）。</p>;
  if (!po) return <p>セブン化学発注書が紐付いていません。発注一覧で確認してください。</p>;
  return (
    <div className="p1-approvals">
      {designs.map((design) => (
        <div key={design.revisionId} className="p1-approval-design">
          <p className="p1-approval-head">デザイン <span translate="no">{design.designKey}</span>・第{design.revisionNo}版</p>
          <div className="p1-seal-row">
            {(['customer', 'seven'] as const).map((organization) => {
              const state = design[organization];
              const name = organization === 'customer' ? '顧客' : 'セブン化学';
              return (
                <div key={organization} className={`p1-seal-slot p1-seal-slot--${state}`}>
                  <p className="p1-seal-name">{name}の承認</p>
                  {state === 'approved' ? (
                    <p className="p1-seal"><span className="p1-seal-mark" aria-hidden="true">承認</span><span className="visually-hidden">{name}の承認済み</span></p>
                  ) : state === 'pending_check' ? (
                    <Waiting text={role === 'admin' ? '証跡の確認が必要です（上の「証跡を確認する」）' : '代表の確認を待っています'} />
                  ) : (
                    <ActionForm action={recordApprovalStepAction} submitLabel={`${name}の承認を記録する`} submitContext={`${order.code}・デザイン ${design.designKey}・${name}`}>
                      <OrderFields order={order} projectCode={projectCode} />
                      <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po.id} />
                      <input type="hidden" readOnly name="revisionId" value={design.revisionId} />
                      <input type="hidden" readOnly name="designKey" value={design.designKey} />
                      <input type="hidden" readOnly name="organization" value={organization} />
                      <StepFileField
                        label={`${name}が送った承認メール`}
                        hint={`.eml 推奨（識別子と日時を自動で読み取ります）。PDF・画像は代表の確認が必要です。選べるのは${name}が発行した証跡だけです。`}
                      />
                      <TextField name="evidenceIdentifier" label="PDF・画像のとき: 承認証跡の識別子（8文字以上）" width={320} autoComplete="off" spellCheck={false} />
                    </ActionForm>
                  )}
                  <p className="p1-seal-state">{SLOT_TEXT[state]}</p>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {/* P4 N9: a second design can still get its proof while the first waits for its approvals. */}
      <AnotherDesignForm order={order} projectCode={projectCode} po={po} existing={designs.map((design) => design.designKey)} />
    </div>
  );
}

/**
 * P4 N9: 「別のデザインを追加する」 at 校了 — the proof of a NEW design (its 版 is
 * registered; the order stays 校了確認待ち). A design already approved is changed only
 * through 変更確認 (approved server rule: the change review), so its name is refused here.
 */
function AnotherDesignForm({ order, projectCode, po, existing }: { order: FilmSupplyOrderView; projectCode: string; po: SevenPurchaseOrderView; existing: string[] }) {
  return (
    <div className="p4w2-another-design">
      <h3 className="p4w2-subtitle">別のデザインを追加する</h3>
      <ActionForm
        action={submitProofStepAction}
        submitLabel="このデザインの校正を登録する"
        submitContext={order.code}
        quiet
        hint={`登録済みのデザイン（${existing.join('・')}）とは別の名前にします。登録済みデザインの差し替えは「その他の操作」の変更確認から行います。`}
      >
        <OrderFields order={order} projectCode={projectCode} />
        <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po.id} />
        <input type="hidden" readOnly name="currentStatus" value={order.status} />
        <input type="hidden" readOnly name="existingDesignKeys" value={JSON.stringify(existing)} />
        <TextField name="designKey" label="新しいデザイン名" required width={240} hint="例: 裏面B" autoComplete="off" />
        <StepFileField label="校正ゲラのファイル" hint="5MBまで。形式はファイルから判別します。" />
      </ActionForm>
    </div>
  );
}

/** 10 メーカー受注確認: staff 仮 with the maker's reply; the representative confirms (最終). */
function AcceptStep({ order, projectCode, po, role, documents, poId, provisionalRecorded }: StepPanelProps & { poId: string; provisionalRecorded: boolean }) {
  const final = role === 'admin';
  const evidence = documents
    .filter((document) => document.documentType === 'acceptance_evidence' && document.filmSupplyOrderId === order.id)
    .at(-1);
  const version = evidence?.versions.at(-1) ?? null;
  return (
    <ActionForm
      action={recordAcceptanceStepAction}
      submitLabel={final ? 'メーカーの受注を確定する（最終受入）' : '受入記録（仮）を残す'}
      submitContext={order.code}
      submitLabelKo={final ? '제조사 수주를 확정(최종 수령)' : '수령 기록(임시)을 남김'}
      hint={final
        ? '受領証跡を確認済みにして最終受入を記録します。確認者と日時は自動で記録されます。'
        : 'メーカーからの受注確認（メール・書面）を登録し、仮の受入として記録します。確定は代表です。'}
      hintKo={final
        ? '수령 증빙을 확인 완료로 하고 최종 수령을 기록합니다. 확인자와 일시는 자동으로 기록됩니다.'
        : '제조사의 수주 확인(메일·서면)을 등록하고 임시 수령으로 기록합니다. 확정은 대표가 합니다.'}
    >
      <OrderFields order={order} projectCode={projectCode} />
      <input type="hidden" readOnly name="poId" value={poId} />
      <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po?.id ?? ''} />
      <input type="hidden" readOnly name="mode" value={final ? 'final' : 'provisional'} />
      {final && version ? (
        <>
          <input type="hidden" readOnly name="evidenceDocumentVersionId" value={version.id} />
          <input type="hidden" readOnly name="evidenceDocumentId" value={evidence!.id} />
          <input type="hidden" readOnly name="evidenceVerified" value={evidence!.verificationStatus === 'verified' ? 'true' : 'false'} />
          <p>受領証跡: {version.originalFilename}（{evidence!.verificationStatus === 'verified' ? '確認済み' : '未確認'}）{provisionalRecorded ? '・受入記録（仮）あり' : ''}</p>
        </>
      ) : (
        <StepFileField label="メーカーの受注確認（受領証跡）" hint="メーカーからの返信メール（.eml）や書面。5MBまで。" />
      )}
    </ActionForm>
  );
}

const EMPTY_DELIVERY_CONTEXT: DeliveryContext = { deliveries: [], userId: null, filmOnly: false, readiness: null, readinessLabel: (key) => key };

const ORGANIZATION_TEXT: Readonly<Record<string, string>> = { customer: '顧客', seven: 'セブン化学' };

function organizationText(key: string): string {
  return ORGANIZATION_TEXT[key] ?? key;
}

/** The stored document a pending verification points at (its name, never a bare id). */
function evidenceLabelOf(documents: readonly DocumentView[], versionId: string | null): string {
  if (!versionId) return '（証跡バージョン未記録）';
  for (const document of documents) {
    const version = document.versions.find((candidate) => candidate.id === versionId);
    if (version) return `${document.filename}（版${version.versionNumber}／${VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus}）`;
  }
  return '（証跡の書類を読み込めませんでした）';
}

/**
 * P4 M10①: why the send waits — the send time and the 代表承認 time to the second, the
 * gap between them, and the automatic check's reason (the comparison is strict).
 */
export function SendWaitFacts({ event, approvedAt }: { event: MakerPoEventRow | null; approvedAt: string | null }) {
  if (!event) return null;
  const gap = sendApprovalGapText(event.sentAt ?? null, approvedAt);
  return (
    <dl className="p4w2-send-facts">
      <div><dt>送信日時</dt><dd>{formatTimestampSeconds(event.sentAt ?? null)}</dd></div>
      <div><dt>代表承認</dt><dd>{formatTimestampSeconds(approvedAt)}{gap ? `（${gap}）` : ''}</dd></div>
      <div><dt>待っている理由</dt><dd>{event.verificationNote ?? '（理由の記録なし）'}</dd></div>
    </dl>
  );
}
