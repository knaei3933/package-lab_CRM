import { MEASURE_UNITS, UNIT_LABELS_JA } from './units.js';
import type { MeasureUnit } from './units.js';

/**
 * P1 R31: numbers and units as a person reads them. Quantities are stored as
 * numeric(14,3) text ("300.000"); a screen shows "300 m", never "300.000 meters".
 * Formatting works on the decimal text itself (no float), so a large quantity
 * never picks up a binary rounding digit.
 */
export const UNIT_SYMBOLS_JA: Readonly<Record<MeasureUnit, string>> = {
  rolls: 'ロール',
  meters: 'm',
  sheets: '枚',
  pods: 'ポッド',
  pieces: '個'
};

export interface UnitDisplay {
  symbol: string;
  label: string;
}

/** The unit vocabulary served with the status labels (GET /api/status-labels). */
export function unitDisplayVocabulary(): Record<MeasureUnit, UnitDisplay> {
  const out = {} as Record<MeasureUnit, UnitDisplay>;
  for (const unit of MEASURE_UNITS) out[unit] = { symbol: UNIT_SYMBOLS_JA[unit], label: UNIT_LABELS_JA[unit] };
  return out;
}

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Groups the integer digits by three (ja-JP) and drops trailing fraction zeros. */
export function formatDecimalText(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return null;
  const match = DECIMAL_TEXT.exec(text.trim());
  if (!match) return null;
  const [, sign, integerDigits, fractionDigits] = match;
  const integer = integerDigits!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (fractionDigits ?? '').replace(/0+$/, '');
  const isZero = /^0$/.test(integer) && fraction.length === 0;
  return `${isZero ? '' : sign}${integer}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

/** "300.000" + meters → "300 m"; an unknown unit keeps the number and no symbol. */
export function formatQuantityDisplay(quantity: unknown, unit: unknown): string | null {
  const number = formatDecimalText(quantity);
  if (number === null) return null;
  const symbol = typeof unit === 'string' && (MEASURE_UNITS as readonly string[]).includes(unit)
    ? UNIT_SYMBOLS_JA[unit as MeasureUnit]
    : null;
  return symbol ? `${number} ${symbol}` : number;
}

/** JPY "312000.00" → "¥312,000"; another currency keeps its code as a suffix. */
export function formatAmountDisplay(currency: unknown, totalAmount: unknown): string | null {
  const number = formatDecimalText(totalAmount);
  if (number === null) return null;
  if (currency === 'JPY') return `¥${number}`;
  return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? `${number} ${currency}` : number;
}

/**
 * P1 R32: the number a person says aloud for a maker purchase order,
 * MPO-{year}-{sequence in that year}. It is computed from the row's creation
 * order (no stored column; see the REPORT for the persistent variant).
 */
export function makerPoDisplayNumber(year: number, sequence: number): string {
  return `MPO-${year}-${String(sequence).padStart(4, '0')}`;
}

/** The Asia/Tokyo calendar year of an instant (JST has no daylight saving). */
export function jstYear(at: Date): number {
  return new Date(at.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
}
