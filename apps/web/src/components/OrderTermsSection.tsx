import type { ReactNode } from 'react';
import { ActionForm } from './ActionForm';
import { Bilingual } from './Bilingual';
import { DateTextField, SelectField, TextField } from './fields';
import { updateFilmPaymentTermsAction } from '../app/actions';
import { saveOrderAmountAction, saveOrderQuantityAction, updateDeliveryDatesAction } from '../app/order-terms-actions';
import { makerPoNumberOf, PAYMENT_TERMS_LABELS } from '../lib/maker-po-data';
import {
  beforeFieldOf,
  deliveryDateDisplay,
  editsOrderTerms,
  ORDER_FACT_CURRENCY_CHOICES,
  orderAmountDisplay,
  orderFactUnitChoices,
  plainNumberText
} from '../lib/order-terms';
import { deliveryDateText } from '../lib/delivery-dates';
import type { DeliveryTermsLock, OrderFactsRead } from '../lib/order-terms';
import type { FilmSupplyOrderView } from '../lib/project-data';
import { projectPath } from '../lib/project-route';

/**
 * One cell of the 条件ブロック: a value, or why there is none. `unknown` is the
 * web fallback card that has no such data (shown as 「—」, never invented).
 */
export type TermCell =
  | { text: string }
  | { missing: 'unrecorded' | 'unlinked' | 'hidden' | 'failed' | 'unknown' };

function Cell({ cell, figure, emptyHint }: { cell: TermCell; figure?: boolean; emptyHint?: ReactNode }) {
  if ('text' in cell) return <dd className={figure ? 'p1-figure' : undefined}>{cell.text}</dd>;
  switch (cell.missing) {
    case 'unrecorded':
      return <dd>未記録{emptyHint ?? null}</dd>;
    case 'unlinked':
      return <dd>セブン化学発注書が紐付いていません</dd>;
    case 'hidden':
      return <dd><span className="p1-muted-inline">閲覧権限では表示されません</span></dd>;
    case 'failed':
      return <dd><span className="p1-blocked-inline">読み込めませんでした。再読み込みしてください。</span></dd>;
    default:
      return <dd>—</dd>;
  }
}

export function dateCell(value: string | null | undefined, read: boolean): TermCell {
  if (!read) return { missing: 'failed' };
  const shown = deliveryDateDisplay(value);
  return shown ? { text: shown } : { missing: 'unrecorded' };
}

/**
 * DESIGN §0-2: the 条件ブロック — 希望納期・納品予定日・セブン化学発注書の数量
 * (and, for the representative, the amount) in the same order and words on the
 * order screen and on the approval card. Rows for a `dl.p1-facts`. `amount`
 * undefined renders no amount row at all (staff / viewer / auditor).
 */
export function DeliveryTermsRows({
  requested,
  planned,
  quantity,
  amount,
  emptyHint
}: {
  requested: TermCell;
  planned: TermCell;
  quantity: TermCell;
  amount?: TermCell | undefined;
  emptyHint?: ReactNode;
}) {
  return (
    <>
      <dt><Bilingual ja="希望納期" ko="희망 납기" /></dt>
      <Cell cell={requested} emptyHint={emptyHint} />
      <dt><Bilingual ja="納品予定日" ko="납품 예정일" /></dt>
      <Cell cell={planned} emptyHint={emptyHint} />
      <dt><Bilingual ja="セブン化学発注書の数量" ko="세븐화학 발주서 수량" /></dt>
      <Cell cell={quantity} figure emptyHint={emptyHint} />
      {amount ? (
        <>
          <dt><Bilingual ja="セブン化学発注書の金額" ko="세븐화학 발주서 금액" /></dt>
          <Cell cell={amount} figure emptyHint={emptyHint} />
        </>
      ) : null}
    </>
  );
}

function quantityCell(facts: OrderFactsRead): TermCell {
  if (facts.state === 'unlinked') return { missing: 'unlinked' };
  if (facts.state === 'hidden') return { missing: 'hidden' };
  if (facts.state === 'failed') return { missing: 'failed' };
  return facts.facts.quantityDisplay ? { text: facts.facts.quantityDisplay } : { missing: 'unrecorded' };
}

function amountCell(facts: OrderFactsRead): TermCell {
  if (facts.state === 'unlinked') return { missing: 'unlinked' };
  if (facts.state !== 'read') return { missing: 'failed' };
  const shown = orderAmountDisplay(facts.facts.amount);
  return shown ? { text: shown } : { missing: 'unrecorded' };
}

const PAYMENT_TERMS_CHOICES = [
  { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
  { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
  { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
];

/**
 * P4 B1②: 「支払条件を変更する」 on the order screen. The API already allows the change
 * before the 代表承認 (PATCH …/payment-terms, one history row per change); opened while
 * the term is still 「未定」, because that is the one value that will stop the approval.
 * `paymentTermsEditable === false` (the API's own answer: approved, frozen, closed) hides it.
 */
export function PaymentTermsChange({ order, role, cancelled }: { order: FilmSupplyOrderView; role: string | null | undefined; cancelled: boolean }) {
  if (!editsOrderTerms(role) || cancelled || order.paymentTermsEditable === false) return null;
  const current = order.paymentTerms ?? null;
  const undecided = current === 'undetermined' || order.paymentTermsUndetermined === true;
  return (
    <details className="p4-terms-change" open={undecided || undefined}>
      <summary className="p4-terms-change-summary">
        <Bilingual ja="支払条件を変更する" ko="결제 조건 변경" />
        {current && PAYMENT_TERMS_LABELS[current] ? `（いま: ${PAYMENT_TERMS_LABELS[current]}）` : ''}
      </summary>
      {undecided ? (
        <p className="field-warning" role="status">
          <span aria-hidden="true">⚠</span> 支払条件が「未定」です。このままでは代表承認できません。決まったらここで選んでください。
        </p>
      ) : null}
      <ActionForm
        action={updateFilmPaymentTermsAction}
        submitLabel="支払条件を変更する"
        hint="代表承認の前なら変更できます（変更は履歴に残ります）。記録は入金確認ではありません。"
        confirm={{
          title: `発注 ${order.code} の支払条件を変更しますか？`,
          body: '選んだ支払条件をこの発注に記録します。代表承認の前なら記録し直せます。記録は入金確認ではありません。',
          tone: 'primary',
          summaryFields: ['paymentTerms', 'reason']
        }}
      >
        <input type="hidden" readOnly name="orderId" value={order.id} />
        <SelectField
          name="paymentTerms"
          label="支払条件"
          required
          width={280}
          choices={PAYMENT_TERMS_CHOICES}
          {...(current && current in PAYMENT_TERMS_LABELS ? { defaultValue: current } : {})}
        />
        <TextField name="reason" label="変更の理由（任意）" width={280} />
      </ActionForm>
    </details>
  );
}

/** 1 行の要約 (現在の手順が メーカー発注書の作成 / 代表承認 のとき、手順パネルの下に出す). */
export function deliveryTermsSummary(order: FilmSupplyOrderView, facts: OrderFactsRead): string {
  const read = order.deliveryDatesRead !== false;
  const say = (cell: TermCell) => ('text' in cell ? cell.text : cell.missing === 'unrecorded' ? '未記録' : cell.missing === 'unlinked' ? '紐付けなし' : '—');
  return `希望納期 ${say(dateCell(order.requestedDeliveryDate, read))} ・ 納品予定日 ${say(dateCell(order.plannedDeliveryDate, read))} ・ 数量 ${say(quantityCell(facts))}`;
}

/**
 * P2 R30 / P-8 (DESIGN §1): 「発注の条件」 on /p/{案件}/o/{発注}. Every role reads
 * the dates; the quantity is read by admin, staff and auditor; the amount by the
 * representative only (no amount label, field or text for anyone else). The
 * edit forms are drawn for admin and staff only and are three separate forms,
 * so the staff submit can never carry an amount key. A maker paper the
 * representative approved fixes the dates and the quantity (the API's 409
 * DELIVERY_TERMS_LOCKED is the final word); the amount stays editable.
 */
export function OrderTermsSection({
  order,
  role,
  facts,
  lock,
  projectCode,
  cancelled
}: {
  order: FilmSupplyOrderView;
  /** The session's raw role (auditor is told apart from viewer). */
  role: string | null | undefined;
  facts: OrderFactsRead;
  lock: DeliveryTermsLock;
  projectCode: string;
  cancelled: boolean;
}) {
  const isAdmin = role === 'admin';
  const datesRead = order.deliveryDatesRead !== false;
  const requested = datesRead ? order.requestedDeliveryDate ?? null : null;
  const planned = datesRead ? order.plannedDeliveryDate ?? null : null;
  const editable = editsOrderTerms(role) && !cancelled;
  const locked = lock.state === 'locked';
  const poId = order.sevenPurchaseOrderId;
  const readFacts = facts.state === 'read' ? facts.facts : null;
  const paperNumber = lock.state === 'open' ? null : makerPoNumberOf(lock.paper.displayNumber);

  return (
    <section id="order-terms" className="p1-panel p2-terms" aria-labelledby="terms-title">
      <h2 id="terms-title" className="p1-section-title"><Bilingual ja="発注の条件" ko="발주 조건" /></h2>
      <dl className="p1-facts">
        <DeliveryTermsRows
          requested={dateCell(order.requestedDeliveryDate, datesRead)}
          planned={dateCell(order.plannedDeliveryDate, datesRead)}
          quantity={quantityCell(facts)}
          amount={isAdmin ? amountCell(facts) : undefined}
        />
      </dl>
      {requested && planned && planned > requested ? (
        <p className="field-warning"><span aria-hidden="true">⚠</span> 納品予定日が希望納期より後です。</p>
      ) : null}

      {cancelled ? (
        <p className="p1-note">取消で終了した発注のため、条件は変更できません。</p>
      ) : locked ? (
        <div className="p2-terms-lock">
          <p className="p1-banner p1-banner--exception" role="status">
            <Bilingual
              ja={`納期と数量は固定されています（${paperNumber ?? 'メーカー発注書'} が代表承認済み）`}
              ko="납기와 수량은 고정되어 있습니다(대표 승인 완료)"
            />
          </p>
          <p className="p1-note">変えるには、メーカー発注書を取り消して作り直し、もう一度代表が承認します。</p>
          {isAdmin ? (
            <p className="p1-note">
              <a className="p1-button p1-button--quiet" href={`${projectPath(projectCode, 'maker-po')}#maker-order-${order.id}`}>メーカー発注の画面で取り消す</a>
            </p>
          ) : editable ? (
            <p className="p1-note">取り消しは代表が行います。</p>
          ) : null}
        </div>
      ) : (
        <>
          <p className="p1-note">
            <Bilingual
              ja="メーカー発注書を代表が承認すると、この納期・数量で固定されます。直すなら承認の前に。"
              ko="대표가 제조사 발주서를 승인하면 이 납기·수량으로 고정됩니다."
            />
          </p>
          {lock.state === 'draft' ? (
            <p className="field-warning">
              <span aria-hidden="true">⚠</span> 下書きのメーカー発注書があります。ここを変えると承認カードの内容も変わります。変えたあと、カードを開き直してから承認します。
            </p>
          ) : null}
        </>
      )}

      {editable && !locked ? (
        <div className="p2-terms-forms">
          {datesRead ? (
            // Keyed by the stored values: after a save the inputs start from what is recorded now.
            <div key={`dates-${requested ?? ''}-${planned ?? ''}`} className="p2-terms-form">
              <ActionForm action={updateDeliveryDatesAction} submitLabel="納期を保存する" successHint="納期を記録しました。">
                <input type="hidden" readOnly name="orderId" value={order.id} />
                <input type="hidden" readOnly name={beforeFieldOf('requestedDeliveryDate')} value={requested ?? ''} />
                <input type="hidden" readOnly name={beforeFieldOf('plannedDeliveryDate')} value={planned ?? ''} />
                <div className="p1-check-grid">
                  <DateTextField
                    name="requestedDeliveryDate"
                    label="希望納期"
                    defaultValue={deliveryDateText(requested) ?? undefined}
                    hint="お客様が希望する納品日。空のまま保存すると記録を消します。例 2026/12/01"
                  />
                  <DateTextField
                    name="plannedDeliveryDate"
                    label="納品予定日"
                    defaultValue={deliveryDateText(planned) ?? undefined}
                    hint="メーカーが約束した納品日。空のまま保存すると記録を消します。"
                  />
                </div>
              </ActionForm>
            </div>
          ) : (
            <p className="p1-note">納期を読み込めなかったため、いまは変更できません。再読み込みしてください。</p>
          )}
          {!poId ? (
            <p className="p1-note">セブン化学発注書が紐付いていないため、数量は記録できません。</p>
          ) : readFacts ? (
            <div key={`quantity-${readFacts.orderedQuantity ?? ''}-${readFacts.orderedUnit ?? ''}`} className="p2-terms-form">
              <ActionForm action={saveOrderQuantityAction} submitLabel="数量を保存する" successHint="数量を記録しました。">
                <input type="hidden" readOnly name="poId" value={poId} />
                <div className="p1-row">
                  <TextField
                    name="orderedQuantity"
                    label="数量（数字のみ）"
                    width={160}
                    autoComplete="off"
                    defaultValue={plainNumberText(readFacts.orderedQuantity)}
                    hint="小数は3桁まで。例 1000 / 12.5。数量と単位を空にして保存すると記録を消します。"
                  />
                  <SelectField
                    name="orderedUnit"
                    label="単位"
                    choices={orderFactUnitChoices()}
                    includeBlank
                    blankLabel="（選ぶ）"
                    defaultValue={readFacts.orderedUnit ?? ''}
                    width={180}
                  />
                </div>
              </ActionForm>
            </div>
          ) : (
            <p className="p1-note">数量を読み込めなかったため、いまは変更できません。再読み込みしてください。</p>
          )}
        </div>
      ) : null}

      {/* An approved maker paper fixes the 支払条件 too (the API: paymentTermsEditable false). */}
      {locked ? null : <PaymentTermsChange order={order} role={role} cancelled={cancelled} />}

      {editable && isAdmin && poId && readFacts ? (
        <div key={`amount-${readFacts.amount?.totalAmount ?? ''}-${readFacts.amount?.currency ?? ''}`} className="p2-terms-form p2-terms-forms">
          {locked ? <p className="p1-note">セブン化学発注書の金額は、承認で固定される対象に入りません。</p> : null}
          <ActionForm action={saveOrderAmountAction} submitLabel="金額を保存する" successHint="金額を記録しました。">
            <input type="hidden" readOnly name="poId" value={poId} />
            <div className="p1-row">
              <SelectField
                name="currency"
                label="通貨"
                choices={ORDER_FACT_CURRENCY_CHOICES}
                defaultValue={readFacts.amount?.currency ?? 'JPY'}
                width={200}
              />
              <TextField
                name="totalAmount"
                label="セブン化学発注書の金額（数字のみ）"
                width={220}
                autoComplete="off"
                inputMode="decimal"
                defaultValue={plainNumberText(readFacts.amount?.totalAmount)}
                hint="例 312000 / 312000.50。空のまま保存すると記録を消します。"
              />
            </div>
          </ActionForm>
        </div>
      ) : null}
    </section>
  );
}
