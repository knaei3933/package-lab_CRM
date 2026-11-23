import { ActionForm } from './ActionForm';
import { RevealDetails } from './RevealDetails';
import { Bilingual } from './Bilingual';
import { StepFileField } from './StepFileField';
import { CheckboxField, SelectField, TextField } from './fields';
import { assumeFilmReceiptAction, evaluateCommissionReadinessAction } from '../app/actions';
import { confirmDeliveryReceiptStepAction } from '../app/step-actions';
import { canRoleOperate, normalizeRole } from '../lib/permissions';
import type { DeliveryView, DocumentView, FilmSupplyOrderView, ReadinessView } from '../lib/project-data';
import { isOwnDocumentOfStaff } from '../lib/self-verification';
import { formatQuantityWithUnit } from '../lib/number-format';
import { formatTimestamp, READINESS_BLOCKING_LABELS, VERIFICATION_STATUS_LABELS } from '../lib/vocabulary';
import { CLOSURE_BASIS_LABELS, EVIDENCE_KIND_TEXT, EVIDENCE_KIND_TEXT_KO } from '../lib/receipt-closure';
import type { DeliveryEvidenceKind, ReceiptClosureView } from '../lib/receipt-closure';
import { ALTERNATIVE_RECEIPT_ANCHOR } from '../lib/step-messages';
import { receiptNoticeText } from '../lib/receipt-notice';
import type { ReceiptNotice } from '../lib/receipt-notice';

/**
 * P4 H14 (R36 on the order screen): 12 納品 — the delivered quantity is confirmed
 * on the receipt evidence (受領証跡), the main path; 「証跡なしで完了」 stays the
 * fallback below it. Who may confirm follows P-4: the uploader of the evidence
 * never confirms on it (SELF_VERIFICATION_FORBIDDEN) — for staff the confirmation
 * then waits in the representative's queue (server kind delivery_confirmation).
 * Display only; the API decides every write. Quantities only (no amount).
 */

export interface DeliveryContext {
  /** The film deliveries of THIS order (the workspace's delivery list). */
  deliveries: readonly DeliveryView[];
  userId: string | null;
  /** The project has no filling order: its commission readiness is film only (P-3). */
  filmOnly: boolean;
  readiness: ReadinessView | null;
  readinessLabel: (key: string) => string;
  /** p4/web3 (e): what the completion rests on, from the server (null: not read / older API). */
  closure?: ReceiptClosureView | null | undefined;
  /** p4/web4 (server2 §11/§12): what each confirmation rests on, by delivery id (empty: not read / older API). */
  evidenceKinds?: Readonly<Record<string, DeliveryEvidenceKind>> | undefined;
  /** p4/web4: why the last confirmation of THIS order stopped, kept across the redraw (null: none). */
  notice?: ReceiptNotice | null | undefined;
}

/** P4 H14 ②: a film delivery's confirmation in its own words (never 「充填製品の…」). */
export const FILM_DELIVERY_CONFIRMATION_LABELS = {
  PENDING_CONFIRMATION: { ja: 'フィルムの納品確認待ち', ko: '필름 납품 확인 대기' },
  CONFIRMED: { ja: 'フィルムの納品確認済み', ko: '필름 납품 확인 완료' }
} as const;

export const RECEIPT_ISSUER_CHOICES = [
  { value: 'customer_generated', label: '顧客（受領書・受領メール）' },
  { value: 'maker', label: 'メーカー（納品書）' },
  { value: 'seven', label: 'セブン化学' },
  { value: 'kanei', label: 'カネイ' }
];

function Hidden({ order, projectCode }: { order: FilmSupplyOrderView; projectCode: string }) {
  return (
    <>
      <input type="hidden" readOnly name="orderId" value={order.id} />
      <input type="hidden" readOnly name="orderCode" value={order.code} />
      <input type="hidden" readOnly name="projectCode" value={projectCode} />
      {order.sevenPurchaseOrderId ? <input type="hidden" readOnly name="sevenPurchaseOrderId" value={order.sevenPurchaseOrderId} /> : null}
    </>
  );
}

/**
 * The receipt evidence of the delivery: acceptance_evidence of this order that is not step 10's
 * maker acceptance — not bound to a maker paper, and registered once the delivery was recorded.
 * (The API answers the maker-paper link to the representative only, so for staff the time is
 * what tells the two apart — live check w02: staff were offered the maker's acceptance.)
 */
export function deliveryReceiptDocuments(
  documents: readonly DocumentView[],
  orderId: string,
  deliveries: ReadonlyArray<Pick<DeliveryView, 'recordedAt'>> = []
): DocumentView[] {
  const firstDelivery = deliveries.map((delivery) => delivery.recordedAt).filter(Boolean).sort()[0] ?? null;
  return documents.filter((document) => document.documentType === 'acceptance_evidence'
    && document.filmSupplyOrderId === orderId
    && document.makerPurchaseOrderId === null
    && document.versions.length > 0
    && (firstDelivery === null || document.createdAt >= firstDelivery));
}

export type ReceiptPlan =
  /** Confirm the deliveries on an evidence already registered (by someone else, or the representative). */
  | { kind: 'confirm_existing'; document: DocumentView }
  /** Register the evidence and confirm on it in the same submit (the representative: P-4 lets them). */
  | { kind: 'upload_confirm' }
  /** Register the evidence only: its uploader may not confirm on it (staff, P-4). */
  | { kind: 'upload_only' }
  /** The evidence is this staff member's own: the representative confirms (queue). */
  | { kind: 'wait_representative'; document: DocumentView };

/** Pure: what the signed-in role does with the receipt evidence of this order. */
export function receiptPlan(role: string | null | undefined, userId: string | null, receipts: readonly DocumentView[]): ReceiptPlan {
  const latest = receipts.at(-1) ?? null;
  const admin = normalizeRole(role) === 'admin';
  if (admin) return latest ? { kind: 'confirm_existing', document: latest } : { kind: 'upload_confirm' };
  if (latest && isOwnDocumentOfStaff(role, userId, latest)) return { kind: 'wait_representative', document: latest };
  if (latest && latest.verificationStatus === 'verified') return { kind: 'confirm_existing', document: latest };
  return { kind: 'upload_only' };
}

function ReceiptFields({ customer = false }: { customer?: boolean }) {
  return (
    <>
      <StepFileField label="受領証跡のファイル" hint="受領書・受領メール（.eml）・納品書の写しなど。5MBまで。この発注に紐付けて保存されます。" />
      <SelectField name="receiptIssuer" label="受領証跡の発行元" required includeBlank blankLabel="（選ぶ）" choices={RECEIPT_ISSUER_CHOICES} width={300} {...(customer ? { defaultValue: 'customer_generated' } : {})} />
    </>
  );
}

/** 12 (納品済み): confirm the delivered quantity on the receipt evidence, then the fallback. */
export function DeliveryReceiptStep({
  order,
  projectCode,
  role,
  documents,
  context,
  completed
}: {
  order: FilmSupplyOrderView;
  projectCode: string;
  role: string;
  documents: readonly DocumentView[];
  context: DeliveryContext;
  /** The order is closed (受領確認): only the evidence confirmation and the readiness are left. */
  completed: boolean;
}) {
  const unconfirmed = context.deliveries.filter((delivery) => !delivery.confirmed && !delivery.confirmationHidden);
  const receipts = deliveryReceiptDocuments(documents, order.id, context.deliveries);
  const plan = receiptPlan(role, context.userId, receipts);
  const evaluate = canRoleOperate(role, 'commission_readiness:evaluate');
  const canConfirm = canRoleOperate(role, 'delivery_confirmation:record');
  return (
    <div className="p4w2-receipt">
      {context.notice && unconfirmed.length > 0 ? <ReceiptStopNotice notice={context.notice} /> : null}
      <DeliveryLines deliveries={context.deliveries} evidenceKinds={context.evidenceKinds ?? {}} />
      {unconfirmed.length === 0 ? (
        <p className="p1-done"><span aria-hidden="true">✓ </span>{FILM_DELIVERY_CONFIRMATION_LABELS.CONFIRMED.ja}（受領証跡で数量を確認済み）</p>
      ) : !canConfirm ? (
        <p className="p1-waiting"><span aria-hidden="true">… </span>担当者か代表が受領証跡で納品を確認します。</p>
      ) : plan.kind === 'wait_representative' ? (
        <p className="p1-waiting">
          <span aria-hidden="true">… </span>
          <Bilingual
            ja={`受領証跡「${plan.document.filename}」はあなたが登録したため、代表が確認します（代表の確認待ち）。`}
            ko="수령 증빙을 직접 등록했기 때문에 대표가 확인합니다(대표 확인 대기)."
          />
        </p>
      ) : (
        // WIG: a delivery confirmation is recorded once and cannot be undone — it asks first (as the old list did).
        <ActionForm
          action={confirmDeliveryReceiptStepAction}
          submitLabel={plan.kind === 'upload_only' ? '受領証跡を登録する（確認は代表）' : '受領証跡で納品を確認する'}
          submitLabelKo={plan.kind === 'upload_only' ? undefined : '수령 증빙으로 납품 확인'}
          submitContext={order.code}
          hint={plan.kind === 'upload_only'
            ? '登録した人は自分の証跡で確認できないため、確認は代表が行います（代表の承認箱に出ます）。'
            : `証跡を確認済みにし、納品${unconfirmed.length}件の数量を確認して、手数料準備の状態を評価し直します（確認者と日時は自動で記録）。`}
          hintKo={plan.kind === 'upload_only' ? undefined : '증빙을 확인 완료로 하고 납품 수량을 확인한 뒤 수수료 준비 상태를 다시 평가합니다.'}
          confirm={plan.kind === 'upload_only' ? undefined : {
            title: '納品を確認済みにしますか？',
            body: `${order.code} の納品${unconfirmed.length}件を、受領証跡を引用して確認済みにします。確認は1回だけ記録でき、取り消せません。`,
            tone: 'primary'
          }}
        >
          <Hidden order={order} projectCode={projectCode} />
          <input type="hidden" readOnly name="receiptMode" value={plan.kind === 'upload_only' ? 'register' : 'confirm'} />
          <input type="hidden" readOnly name="evaluateReadiness" value={evaluate ? 'true' : 'false'} />
          {unconfirmed.map((delivery) => <input key={delivery.id} type="hidden" readOnly name="deliveryId" value={delivery.id} />)}
          {plan.kind === 'confirm_existing' ? (
            <>
              <input type="hidden" readOnly name="evidenceDocumentId" value={plan.document.id} />
              <input type="hidden" readOnly name="evidenceDocumentVersionId" value={plan.document.versions.at(-1)!.id} />
              <input type="hidden" readOnly name="evidenceVerified" value={plan.document.verificationStatus === 'verified' ? 'true' : 'false'} />
              <p>
                受領証跡: <span translate="no">{plan.document.filename}</span>
                （{VERIFICATION_STATUS_LABELS[plan.document.verificationStatus] ?? plan.document.verificationStatus}・登録 {formatTimestamp(plan.document.createdAt)}）
              </p>
            </>
          ) : (
            <ReceiptFields />
          )}
        </ActionForm>
      )}
      {canConfirm && unconfirmed.length > 0 && plan.kind === 'confirm_existing' ? (
        <AlternativeReceiptForm order={order} projectCode={projectCode} unconfirmed={unconfirmed} evaluate={evaluate} admin={normalizeRole(role) === 'admin'} stopped={Boolean(context.notice)} />
      ) : null}

      <ReadinessLine context={context} />
      {evaluate ? (
        <ActionForm action={evaluateCommissionReadinessAction} submitLabel="手数料準備の状態を評価し直す" quiet hint="評価はサーバーが記録にもとづいて行います。">
          <input type="hidden" readOnly name="projectCode" value={projectCode} />
        </ActionForm>
      ) : null}

      {completed ? <ClosureLine closure={context.closure ?? null} /> : <CompletionForm order={order} projectCode={projectCode} unconfirmed={unconfirmed.length} closure={context.closure ?? null} />}
    </div>
  );
}

/** p4/web4: why the last confirmation stopped (kept across the redraw), with the way forward. */
function ReceiptStopNotice({ notice }: { notice: ReceiptNotice }) {
  const text = receiptNoticeText(notice.reason);
  return (
    <p className="p1-banner p4w3-notice" role="alert" data-notice={notice.reason}>
      <span aria-hidden="true">⚠ </span>
      {formatTimestamp(notice.at)} の納品の確認は止まりました。<Bilingual ja={text.ja} ko={text.ko} />{' '}
      <a href={`#${ALTERNATIVE_RECEIPT_ANCHOR}`}>お客様の受領証跡を登録する</a>
    </p>
  );
}

/**
 * p4/web4 (server2 §11-2 / §12): the way out of 422 DELIVERY_EVIDENCE_MAKER_PO_BOUND — the customer's own receipt is
 * registered (and, for the representative, cited in the same submit) instead of the evidence the form above cites.
 * The refusal's link opens this block. Same action and same API rules as the form above: staff register only (P-4:
 * the uploader never confirms on their own evidence), the representative confirms.
 */
function AlternativeReceiptForm({ order, projectCode, unconfirmed, evaluate, admin, stopped }: {
  order: FilmSupplyOrderView;
  projectCode: string;
  unconfirmed: readonly DeliveryView[];
  evaluate: boolean;
  admin: boolean;
  /** A confirmation of this order was stopped (the notice): the form is waiting, so it starts opened. */
  stopped: boolean;
}) {
  return (
    <RevealDetails
      id={ALTERNATIVE_RECEIPT_ANCHOR}
      className="p4w4-alt"
      open={stopped}
      summary={<>お客様の受領証跡を登録して確認する<span className="p1-muted-inline">（上の証跡が使えないとき）</span></>}
    >
      <ActionForm
        action={confirmDeliveryReceiptStepAction}
        submitLabel={admin ? 'お客様の受領証跡を登録して納品を確認する' : 'お客様の受領証跡を登録する（確認は代表）'}
        submitContext={order.code}
        hint={admin
          ? 'お客様から受け取った納品受領の証跡（受領書・受領メール）を登録し、その証跡で納品の数量を確認します（確認者と日時は自動で記録）。'
          : '登録した人は自分の証跡で確認できないため、確認は代表が行います（代表の承認箱に出ます）。'}
        confirm={admin ? {
          title: '納品を確認済みにしますか？',
          body: `${order.code} の納品${unconfirmed.length}件を、新しく登録するお客様の受領証跡を引用して確認済みにします。確認は1回だけ記録でき、取り消せません。`,
          tone: 'primary'
        } : undefined}
      >
        <Hidden order={order} projectCode={projectCode} />
        <input type="hidden" readOnly name="receiptMode" value={admin ? 'confirm' : 'register'} />
        <input type="hidden" readOnly name="evaluateReadiness" value={evaluate ? 'true' : 'false'} />
        {unconfirmed.map((delivery) => <input key={delivery.id} type="hidden" readOnly name="deliveryId" value={delivery.id} />)}
        <ReceiptFields customer />
      </ActionForm>
    </RevealDetails>
  );
}

/** p4/web3 (e): a completed order says what its completion rests on (server receiptAssumption.closureBasis). */
function ClosureLine({ closure }: { closure: ReceiptClosureView | null }) {
  const recorded = closure?.recorded ?? null;
  if (!recorded) return null;
  return (
    <p className="p1-note" data-closure-basis={recorded.basis}>
      完了の根拠: {CLOSURE_BASIS_LABELS[recorded.basis]}
      {recorded.at ? `（${formatTimestamp(recorded.at)}${recorded.by ? `・${recorded.by}` : ''}）` : ''}
    </p>
  );
}

/**
 * 「完了する」. p4/web3 (e, server2 §10): when the server says every delivery is confirmed on its receipt
 * evidence (receiptClosure.basis = delivery_confirmations), the completion rests on them — no 「証跡なし」
 * acknowledgment is asked or sent. Otherwise (or on an API that does not say) the acknowledgment stays.
 */
function CompletionForm({ order, projectCode, unconfirmed, closure }: { order: FilmSupplyOrderView; projectCode: string; unconfirmed: number; closure: ReceiptClosureView | null }) {
  const pending = closure?.pending ?? null;
  if (pending && !pending.acknowledgeNoEvidenceRequired) {
    return (
      <div className="p4w2-fallback" data-closure="delivery_confirmations">
        <h3 className="p4w2-subtitle">確認済みの納品で完了する</h3>
        <ActionForm
          action={assumeFilmReceiptAction}
          submitLabel="確認済みの納品で完了する"
          hint="すべての納品が受領証跡で確認済みです。完了の根拠は「確認済みの納品」として記録されます。メモは必須で、記録は取り消せません。"
          confirm={{
            title: '発注を完了しますか？',
            body: `発注 ${order.code} を、確認済みの納品にもとづいて完了します。記録は取り消せません。`,
            summaryFields: ['note']
          }}
        >
          <Hidden order={order} projectCode={projectCode} />
          <input type="hidden" readOnly name="closureBasis" value="delivery_confirmations" />
          <TextField name="note" label="確認メモ" required width={360} />
        </ActionForm>
      </div>
    );
  }
  // The server says the completion would rest on no confirmed delivery: say it as such, whatever the local count.
  const evidenceFree = pending !== null;
  return (
    <div className="p4w2-fallback" data-closure={evidenceFree ? 'evidence_free_acknowledgment' : undefined}>
      <h3 className="p4w2-subtitle">{!evidenceFree && unconfirmed === 0 ? '受領確認を記録して完了する' : '受領の証跡がない場合'}</h3>
      <ActionForm
        action={assumeFilmReceiptAction}
        submitLabel={!evidenceFree && unconfirmed === 0 ? '受領確認（問題なし）を記録して完了する' : '証跡なしで問題なしとして完了する'}
        quiet={evidenceFree || unconfirmed > 0}
        hint={evidenceFree
          ? '確認されていない納品があります。完了の根拠は「証跡なしで問題なし（同意）」として記録されます。メモは必須で、記録は取り消せません。'
          : '発注を「受領確認（問題なし）」で終えます。メモは必須で、記録は取り消せません。'}
        confirm={{
          title: '発注を完了しますか？',
          body: `発注 ${order.code} を受領確認（問題なし）として完了します。記録は取り消せません。`,
          summaryFields: ['note']
        }}
      >
        <Hidden order={order} projectCode={projectCode} />
        <TextField name="note" label="確認メモ" required width={360} />
        <CheckboxField name="acknowledgeNoEvidence" label="問題なしとして受領確認を記録することに同意します" required />
      </ActionForm>
    </div>
  );
}

function DeliveryLines({ deliveries, evidenceKinds }: { deliveries: readonly DeliveryView[]; evidenceKinds: Readonly<Record<string, DeliveryEvidenceKind>> }) {
  if (deliveries.length === 0) return null;
  return (
    <ul className="p4w2-delivery-list" aria-label="この発注の納品">
      {deliveries.map((delivery) => {
        // p4/web4: the evidence kind of a confirmed delivery (a withheld confirmation says nothing).
        const kind = delivery.confirmed && !delivery.confirmationHidden ? evidenceKinds[delivery.id] ?? null : null;
        return (
          <li key={delivery.id} data-delivery-id={delivery.id}>
            <span>{delivery.detailsHidden ? '（閲覧権限なし）' : formatQuantityWithUnit(delivery.deliveredQuantity, delivery.unit)}</span>
            <span className="p1-muted-inline">{delivery.deliveredAt ? ` ${formatTimestamp(delivery.deliveredAt)}` : ''}</span>
            <span className={delivery.confirmed ? 'p4w2-ok' : 'p4w2-wait'}>
              {' '}{delivery.confirmationHidden ? '（確認状態は閲覧権限なし）' : FILM_DELIVERY_CONFIRMATION_LABELS[delivery.confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION'].ja}
            </span>
            {kind ? (
              <span className={`p4w4-kind${kind === 'maker_po_acceptance' ? ' p4w4-kind--legacy' : ''}`} data-evidence-kind={kind}>
                {kind === 'maker_po_acceptance' ? <span aria-hidden="true">⚠ </span> : null}
                <Bilingual ja={EVIDENCE_KIND_TEXT[kind]} ko={EVIDENCE_KIND_TEXT_KO[kind]} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ReadinessLine({ context }: { context: DeliveryContext }) {
  const readiness = context.readiness;
  const scope = context.filmOnly ? 'フィルムのみの案件（充填の納品は対象外）' : 'フィルムと充填の案件';
  if (!readiness) return <p className="p1-note">手数料準備: まだ評価されていません（{scope}）。</p>;
  if (readiness.hidden) return <p className="p1-note">手数料準備: 閲覧権限なし</p>;
  return (
    <p className="p1-note">
      手数料準備: {context.readinessLabel(readiness.readinessState)}（{scope}・評価 {formatTimestamp(readiness.evaluatedAt)}）
      {readiness.blocking.length > 0 ? ` 未達: ${readiness.blocking.map((code) => READINESS_BLOCKING_LABELS[code] ?? code).join('・')}` : ''}
    </p>
  );
}
