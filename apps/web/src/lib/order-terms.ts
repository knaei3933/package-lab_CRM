import { callApi } from './api';
import { normalizeAmountText } from './amount';
import { DELIVERY_DATE_FIELDS, readDeliveryDate } from './delivery-dates';
import type { DeliveryDateField } from './delivery-dates';
import { normalizeQuantityText } from './form-validation';
import type { MakerPoViewRow } from './maker-po-data';
import { formatQuantity } from './number-format';
import { liveMakerPo } from './order-flow';
import { normalizeRole } from './permissions';
import { formatMoney, unitLabel } from './vocabulary';

/**
 * P2 R30 / P-8 (contract v1.2 §3): the order's 「発注の条件」 — 希望納期・納品予定日
 * (the film order) and the セブン化学発注書 quantity / amount (order-facts). Pure
 * helpers for the screens and the server actions, plus the one order-facts read.
 * The amount belongs to the representative only: nothing here hands it to
 * another role, whatever the API answered.
 */

/** The units the order-facts accept (contract §3-2), with the screen's Japanese labels. */
export const ORDER_FACT_UNITS = ['meters', 'rolls', 'sheets', 'pods', 'pieces'] as const;

export const ORDER_FACT_CURRENCIES = ['JPY', 'USD', 'CNY', 'KRW'] as const;

export const ORDER_FACT_CURRENCY_CHOICES = [
  { value: 'JPY', label: '日本円（JPY）' },
  { value: 'USD', label: '米ドル（USD）' },
  { value: 'CNY', label: '人民元（CNY）' },
  { value: 'KRW', label: '韓国ウォン（KRW）' }
];

export function orderFactUnitChoices(): Array<{ value: string; label: string }> {
  return ORDER_FACT_UNITS.map((unit) => ({ value: unit, label: unitLabel(unit) }));
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * A stored calendar date as the screen shows it: 2026/12/01（火）. The weekday is
 * read from the date itself in UTC (no time zone can move it); null when the
 * value is not a real YYYY-MM-DD date.
 */
export function deliveryDateDisplay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${value.replace(/-/g, '/')}（${WEEKDAYS[date.getUTCDay()]}）`;
}

/** 「1,000 メートル」: the quantity with the unit's Japanese label (an unknown unit: the number only). */
export function orderQuantityDisplay(quantity: unknown, unit: unknown, fallback?: unknown): string | null {
  if (typeof quantity !== 'string' || quantity.length === 0) return null;
  if (typeof unit === 'string' && (ORDER_FACT_UNITS as readonly string[]).includes(unit)) {
    return `${formatQuantity(quantity)} ${unitLabel(unit)}`;
  }
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : formatQuantity(quantity);
}

/** The order-facts as the screen keeps them. `amount` exists for the representative only. */
export interface OrderFactsView {
  orderedQuantity: string | null;
  orderedUnit: string | null;
  quantityDisplay: string | null;
  updatedAt: string | null;
  /** Admin only: the recorded amount (null = not recorded). Absent for every other role. */
  amount?: { totalAmount: string; currency: string } | null;
}

export type OrderFactsRead =
  | { state: 'unlinked' }
  | { state: 'hidden' }
  | { state: 'failed' }
  | { state: 'read'; facts: OrderFactsView };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pure: an order-facts answer for a role. The amount is copied only for admin (defense in depth). */
export function orderFactsFromApi(data: unknown, role: string | null | undefined): OrderFactsView | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const orderedQuantity = text(record.orderedQuantity);
  const orderedUnit = text(record.orderedUnit);
  const view: OrderFactsView = {
    orderedQuantity,
    orderedUnit,
    quantityDisplay: orderQuantityDisplay(orderedQuantity, orderedUnit, record.orderedQuantityDisplay),
    updatedAt: text(record.updatedAt)
  };
  if (role === 'admin') {
    const totalAmount = text(record.totalAmount);
    const currency = text(record.currency);
    view.amount = totalAmount && currency ? { totalAmount, currency } : null;
  }
  return view;
}

/** The roles the API lets read the order-facts (contract §3-2): admin, assigned staff, assigned auditor. */
export function readsOrderFacts(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'staff' || role === 'auditor';
}

/** GET /api/seven-purchase-orders/:poId/order-facts — a viewer is never asked (it would be 403). */
export async function loadOrderFacts(poId: string | null, role: string | null | undefined): Promise<OrderFactsRead> {
  if (!poId) return { state: 'unlinked' };
  if (!readsOrderFacts(role)) return { state: 'hidden' };
  const result = await callApi<unknown>(`/api/seven-purchase-orders/${encodeURIComponent(poId)}/order-facts`);
  if (!result.ok) return result.status === 403 ? { state: 'hidden' } : { state: 'failed' };
  const facts = orderFactsFromApi(result.data, role);
  return facts ? { state: 'read', facts } : { state: 'failed' };
}

/** 「¥312,000」 / 「1,200.50 USD」. */
export function orderAmountDisplay(amount: { totalAmount: string; currency: string } | null | undefined): string | null {
  return amount ? formatMoney(amount.currency, amount.totalAmount) : null;
}

/**
 * The display-side lock (contract §3: the API's 409 DELIVERY_TERMS_LOCKED is the
 * final word). A live maker paper the representative approved freezes the
 * dates and the quantity; a draft paper means the card changes with them.
 */
export type DeliveryTermsLock =
  | { state: 'open' }
  | { state: 'draft'; paper: MakerPoViewRow }
  | { state: 'locked'; paper: MakerPoViewRow };

export function deliveryTermsLock(makerPos: readonly MakerPoViewRow[]): DeliveryTermsLock {
  const paper = liveMakerPo(makerPos);
  if (!paper) return { state: 'open' };
  if (paper.ceoApprovedAt || paper.status !== 'DRAFT') return { state: 'locked', paper };
  return { state: 'draft', paper };
}

/** Whether the role is shown the edit forms (admin and the assigned staff; auditor reads as viewer). */
export function editsOrderTerms(role: string | null | undefined): boolean {
  const normalized = normalizeRole(role);
  return role !== null && role !== undefined && (normalized === 'admin' || normalized === 'staff');
}

// ---- form reading (the server actions; pure) ------------------------------

export const NO_CHANGE_MESSAGE = '変更がありません。';
export const QUANTITY_PAIR_MESSAGE = '数量と単位は一緒に入力してください。';
export const QUANTITY_INVALID_MESSAGE = '数量は 0 より大きい数字で、小数は3桁まで入力してください（例 1000 / 12.5）。';
export const UNIT_INVALID_MESSAGE = '単位を選んでください。';
export const AMOUNT_INVALID_MESSAGE = '金額は数字で、小数は2桁まで入力してください（例 312000 / 312000.50）。';
export const CURRENCY_INVALID_MESSAGE = '通貨を選んでください（JPY・USD・CNY・KRW）。';

/** The hidden field that carries the value the form was drawn with. */
/**
 * P2 live check: a stored decimal as the input shows it (1000.000 → 1000, 12.500 → 12.5,
 * 312000.00 → 312000). Anything that is not a plain decimal is returned as it is.
 */
export function plainNumberText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value)) return value;
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export function beforeFieldOf(field: DeliveryDateField): string {
  return `${field}Before`;
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The PATCH body of the dates form: only the fields that changed from the value
 * the form was drawn with; a field emptied is sent as null (cleared), an empty
 * field that was already empty is not sent.
 */
export function deliveryDatesChange(formData: FormData): { body: Partial<Record<DeliveryDateField, string | null>> } | { error: string } {
  const body: Partial<Record<DeliveryDateField, string | null>> = {};
  for (const field of DELIVERY_DATE_FIELDS) {
    const read = readDeliveryDate(formData.get(field), field);
    if ('error' in read) return { error: read.error };
    const before = formText(formData, beforeFieldOf(field)) || undefined;
    if (read.value === before) continue;
    body[field] = read.value ?? null;
  }
  if (Object.keys(body).length === 0) return { error: NO_CHANGE_MESSAGE };
  return { body };
}

const QUANTITY = /^\d+(\.\d{1,3})?$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

/** The quantity pair of the PUT body: both set, or both null (cleared). */
export function orderQuantityChange(formData: FormData): { body: { orderedQuantity: string | null; orderedUnit: string | null } } | { error: string } {
  const typed = normalizeQuantityText(formText(formData, 'orderedQuantity'));
  // Thousands commas in their proper places only (「1,000」); anything else is left for the check to refuse.
  const quantity = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(typed) ? typed.replaceAll(',', '') : typed;
  const unit = formText(formData, 'orderedUnit');
  if (quantity.length === 0 && unit.length === 0) return { body: { orderedQuantity: null, orderedUnit: null } };
  if (quantity.length === 0 || unit.length === 0) return { error: QUANTITY_PAIR_MESSAGE };
  if (!QUANTITY.test(quantity) || Number(quantity) <= 0) return { error: QUANTITY_INVALID_MESSAGE };
  if (!(ORDER_FACT_UNITS as readonly string[]).includes(unit)) return { error: UNIT_INVALID_MESSAGE };
  return { body: { orderedQuantity: quantity, orderedUnit: unit } };
}

/** The amount pair of the PUT body (admin only): an empty amount clears both. */
export function orderAmountChange(formData: FormData): { body: { totalAmount: string | null; currency: string | null } } | { error: string } {
  const amount = normalizeAmountText(formText(formData, 'totalAmount'));
  const currency = formText(formData, 'currency');
  if (amount.length === 0) return { body: { totalAmount: null, currency: null } };
  if (!AMOUNT.test(amount)) return { error: AMOUNT_INVALID_MESSAGE };
  if (!(ORDER_FACT_CURRENCIES as readonly string[]).includes(currency)) return { error: CURRENCY_INVALID_MESSAGE };
  return { body: { totalAmount: amount, currency } };
}
