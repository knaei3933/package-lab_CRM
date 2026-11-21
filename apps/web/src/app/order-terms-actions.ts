'use server';

import { revalidatePath } from 'next/cache';
import { callApi, loadSessionUser } from '../lib/api';
import { recordIdOf, refreshesListOn, refusalState } from '../lib/action-result';
import { webErrorText } from '../lib/error-dictionary';
import { deliveryDatesChange, orderAmountChange, orderQuantityChange } from '../lib/order-terms';
import { idempotencyKeyOf } from '../lib/project-context';
import { refuseIfProjectSwitched, writeProjectOf } from '../lib/project-guard';
import type { ActionState } from '../lib/types';

/**
 * P2 R30 / P-8 (contract v1.2 §3): the three 「発注の条件」 forms of the order
 * screen. Thin adapters like app/maker-po/actions.ts: the rendered project and
 * the per-submit key go with every write, and the API decides each request.
 * The amount is a separate action that sends nothing unless the session is the
 * representative's (the API refuses a staff amount too — 403
 * SEVEN_PO_AMOUNT_ADMIN_ONLY); the quantity action never builds an amount key.
 */

const TERMS_LOCKED = 'DELIVERY_TERMS_LOCKED';

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function refresh(): void {
  revalidatePath('/', 'layout');
}

async function send(formData: FormData, method: 'PATCH' | 'PUT', path: string, body: unknown): Promise<ActionState> {
  const result = await callApi(path, { method, body, idempotencyKey: idempotencyKeyOf(formData), expectedProjectId: writeProjectOf(formData) });
  if (result.ok) {
    refresh();
    return { ok: true, message: '記録しました。', changedId: recordIdOf(result.data) };
  }
  // DELIVERY_TERMS_LOCKED: the paper was approved meanwhile — the screen is read again and shows the lock.
  if (refreshesListOn(result.code) || result.code === TERMS_LOCKED) refresh();
  return refusalState(result);
}

/** 希望納期・納品予定日: PATCH …/delivery-dates with the changed fields only (an emptied field = null). */
export async function updateDeliveryDatesAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  const orderId = field(formData, 'orderId');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が選択されていません。' };
  const change = deliveryDatesChange(formData);
  if ('error' in change) return { ok: false, message: change.error };
  return send(formData, 'PATCH', `/api/film-supply-orders/${encodeURIComponent(orderId)}/delivery-dates`, change.body);
}

/** セブン化学発注書の数量: PUT …/order-facts with the quantity pair only (never an amount key). */
export async function saveOrderQuantityAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  const poId = field(formData, 'poId');
  if (poId.length === 0) return { ok: false, message: 'セブン化学発注書が紐付いていないため、数量は記録できません。' };
  const change = orderQuantityChange(formData);
  if ('error' in change) return { ok: false, message: change.error };
  return send(formData, 'PUT', `/api/seven-purchase-orders/${encodeURIComponent(poId)}/order-facts`, {
    orderedQuantity: change.body.orderedQuantity,
    orderedUnit: change.body.orderedUnit
  });
}

/** セブン化学発注書の金額 (admin only): PUT …/order-facts with the amount pair only. */
export async function saveOrderAmountAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  // Defense in depth: no amount key leaves the web for a session that is not the representative's.
  const user = await loadSessionUser();
  if (user?.role !== 'admin') {
    const text = webErrorText('SEVEN_PO_AMOUNT_ADMIN_ONLY');
    return { ok: false, message: text.message, messageKo: text.messageKo, code: 'SEVEN_PO_AMOUNT_ADMIN_ONLY' };
  }
  const poId = field(formData, 'poId');
  if (poId.length === 0) return { ok: false, message: 'セブン化学発注書が紐付いていないため、金額は記録できません。' };
  const change = orderAmountChange(formData);
  if ('error' in change) return { ok: false, message: change.error };
  return send(formData, 'PUT', `/api/seven-purchase-orders/${encodeURIComponent(poId)}/order-facts`, {
    totalAmount: change.body.totalAmount,
    currency: change.body.currency
  });
}
