import { ActionForm } from './ActionForm';
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
    </>
  );
}

/** The receipt evidence of the delivery: acceptance_evidence of this order NOT bound to a maker paper (that one is step 10's). */
export function deliveryReceiptDocuments(documents: readonly DocumentView[], orderId: string): DocumentView[] {
  return documents.filter((document) => document.documentType === 'acceptance_evidence'
    && document.filmSupplyOrderId === orderId
    && document.makerPurchaseOrderId === null
    && document.versions.length > 0);
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

function ReceiptFields() {
  return (
    <>
      <StepFileField label="受領証跡のファイル" hint="受領書・受領メール（.eml）・納品書の写しなど。5MBまで。この発注に紐付けて保存されます。" />
      <SelectField name="receiptIssuer" label="受領証跡の発行元" required includeBlank blankLabel="（選ぶ）" choices={RECEIPT_ISSUER_CHOICES} width={300} />
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
  const receipts = deliveryReceiptDocuments(documents, order.id);
  const plan = receiptPlan(role, context.userId, receipts);
  const evaluate = canRoleOperate(role, 'commission_readiness:evaluate');
  const canConfirm = canRoleOperate(role, 'delivery_confirmation:record');
  return (
    <div className="p4w2-receipt">
      <DeliveryLines deliveries={context.deliveries} />
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
        <ActionForm
          action={confirmDeliveryReceiptStepAction}
          submitLabel={plan.kind === 'upload_only' ? '受領証跡を登録する（確認は代表）' : '受領証跡で納品を確認する'}
          submitLabelKo={plan.kind === 'upload_only' ? undefined : '수령 증빙으로 납품 확인'}
          submitContext={order.code}
          hint={plan.kind === 'upload_only'
            ? '登録した人は自分の証跡で確認できないため、確認は代表が行います（代表の承認箱に出ます）。'
            : `証跡を確認済みにし、納品${unconfirmed.length}件の数量を確認して、手数料準備の状態を評価し直します（確認者と日時は自動で記録）。`}
          hintKo={plan.kind === 'upload_only' ? undefined : '증빙을 확인 완료로 하고 납품 수량을 확인한 뒤 수수료 준비 상태를 다시 평가합니다.'}
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

      <ReadinessLine context={context} />
      {evaluate ? (
        <ActionForm action={evaluateCommissionReadinessAction} submitLabel="手数料準備の状態を評価し直す" quiet hint="評価はサーバーが記録にもとづいて行います。">
          <input type="hidden" readOnly name="projectCode" value={projectCode} />
        </ActionForm>
      ) : null}

      {completed ? null : (
        <div className="p4w2-fallback">
          <h3 className="p4w2-subtitle">{unconfirmed.length === 0 ? '受領確認を記録して完了する' : '受領の証跡がない場合'}</h3>
          <ActionForm
            action={assumeFilmReceiptAction}
            submitLabel={unconfirmed.length === 0 ? '受領確認（問題なし）を記録して完了する' : '証跡なしで問題なしとして完了する'}
            quiet={unconfirmed.length > 0}
            hint="発注を「受領確認（問題なし）」で終えます。メモは必須で、記録は取り消せません。"
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
      )}
    </div>
  );
}

function DeliveryLines({ deliveries }: { deliveries: readonly DeliveryView[] }) {
  if (deliveries.length === 0) return null;
  return (
    <ul className="p4w2-delivery-list" aria-label="この発注の納品">
      {deliveries.map((delivery) => (
        <li key={delivery.id}>
          <span>{delivery.detailsHidden ? '（閲覧権限なし）' : formatQuantityWithUnit(delivery.deliveredQuantity, delivery.unit)}</span>
          <span className="p1-muted-inline">{delivery.deliveredAt ? ` ${formatTimestamp(delivery.deliveredAt)}` : ''}</span>
          <span className={delivery.confirmed ? 'p4w2-ok' : 'p4w2-wait'}>
            {' '}{delivery.confirmationHidden ? '（確認状態は閲覧権限なし）' : FILM_DELIVERY_CONFIRMATION_LABELS[delivery.confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION'].ja}
          </span>
        </li>
      ))}
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
