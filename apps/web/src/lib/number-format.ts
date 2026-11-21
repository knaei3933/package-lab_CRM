/**
 * P1 R31: numbers and units as people read them — 「300.000 meters」 becomes
 * 「300 m」, 「1200000」 becomes 「1,200,000」. Intl.NumberFormat('ja-JP'),
 * at most 3 decimals and no trailing zeros; a value that is not a number is
 * shown as it is (never NaN). Pure and client-safe.
 */
const QUANTITY = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });

function numeric(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatQuantity(value: string | number | null | undefined): string {
  const parsed = numeric(value);
  // A number that is not finite (NaN, Infinity) is never shown as text.
  if (parsed === null) return value === null || value === undefined || typeof value === 'number' ? '' : String(value);
  return QUANTITY.format(parsed);
}

/** Short unit symbols for figures (the full Japanese label stays in forms and lists). */
export const UNIT_SYMBOLS: Readonly<Record<string, string>> = {
  meters: 'm',
  rolls: 'ロール',
  sheets: '枚',
  pods: 'ポッド',
  pieces: '個'
};

/** 「300 m」「2 ロール」. An unknown unit code is never shown raw: only the number. */
export function formatQuantityWithUnit(value: string | number | null | undefined, unit: string | null | undefined): string {
  const quantity = formatQuantity(value);
  const symbol = unit ? UNIT_SYMBOLS[unit] : undefined;
  return symbol ? `${quantity} ${symbol}` : quantity;
}

const YEN = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', currencyDisplay: 'symbol' });

/** A money amount: ¥312,000 for JPY, 「1,200.50 USD」 for others; the raw text when it is not a number. */
export function formatAmount(currency: string | null | undefined, amount: string | number | null | undefined): string {
  const parsed = numeric(amount);
  if (parsed === null) return amount === null || amount === undefined || typeof amount === 'number' ? '' : String(amount);
  if (!currency || currency === 'JPY') return YEN.format(parsed);
  return `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(parsed)} ${currency}`;
}
