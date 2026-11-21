import { parseDateText } from './date-input';

/**
 * P2 R30 (contract §3-1): 希望納期 (requestedDeliveryDate) and 納品予定日
 * (plannedDeliveryDate) are calendar dates — `YYYY-MM-DD` strings without a
 * time zone, or null when not recorded. Client-safe and pure.
 */
export const DELIVERY_DATE_FIELDS = ['requestedDeliveryDate', 'plannedDeliveryDate'] as const;
export type DeliveryDateField = (typeof DELIVERY_DATE_FIELDS)[number];

export const DELIVERY_DATE_LABELS: Readonly<Record<DeliveryDateField, string>> = {
  requestedDeliveryDate: '希望納期',
  plannedDeliveryDate: '納品予定日'
};

export const DELIVERY_DATE_KO: Readonly<Record<DeliveryDateField, string>> = {
  requestedDeliveryDate: '희망 납기',
  plannedDeliveryDate: '납품 예정일'
};

/** The field's form value: undefined = empty (not sent), a date, or an error sentence. */
export function readDeliveryDate(raw: unknown, field: DeliveryDateField): { value: string | undefined } | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return { value: undefined };
  const parsed = parseDateText(text);
  return parsed
    ? { value: parsed }
    : { error: `${DELIVERY_DATE_LABELS[field]}は 2026/12/01 の形で、実在する日付を入力してください。` };
}

/** A stored value as the screen shows it (2026/12/01), or null when it is not a calendar date. */
export function deliveryDateText(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value.replace(/-/g, '/');
}

/**
 * The optional dates of a create form (both, or the ones typed): the body part,
 * or the first error. Nothing is sent for an empty field (the API stores null).
 */
export function deliveryDatesFromForm(formData: FormData): { body: Partial<Record<DeliveryDateField, string>> } | { error: string } {
  const body: Partial<Record<DeliveryDateField, string>> = {};
  for (const field of DELIVERY_DATE_FIELDS) {
    const read = readDeliveryDate(formData.get(field), field);
    if ('error' in read) return { error: read.error };
    if (read.value) body[field] = read.value;
  }
  return { body };
}
