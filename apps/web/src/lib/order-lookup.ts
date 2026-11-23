import { HIDDEN_BY_ROLE_LABEL } from './redaction';

/**
 * P4 H10① (N10): the order screen could not find the order of the address.
 * For a viewer the order codes are withheld by the API (「（閲覧権限なし）」), so
 * 「この発注は見つかりません」 was a false statement — the order exists, this
 * role may not open its screen. Pure.
 *
 * - 'forbidden': the role is read-only (viewer, or an unknown role read as one)
 *   and the list carries withheld codes: say it is a permission.
 * - 'missing': the code is not in this project (or the list could not be read).
 * The auditor has its own screens and is not told this (it reads the history).
 */
export type OrderLookupFailure = 'forbidden' | 'missing';

export function orderLookupFailure(
  orders: ReadonlyArray<{ code: string }>,
  role: string | null | undefined
): OrderLookupFailure {
  const readOnly = role !== 'admin' && role !== 'staff' && role !== 'auditor';
  return readOnly && orders.some((order) => order.code === HIDDEN_BY_ROLE_LABEL) ? 'forbidden' : 'missing';
}

export const ORDER_FORBIDDEN_TITLE = '閲覧権限では発注の画面を開けません';
export const ORDER_FORBIDDEN_BODY = '発注の画面を開けるのは、担当者と代表者です。履歴は「履歴」画面で見られます。';
