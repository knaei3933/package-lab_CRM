/**
 * P4 N13: a file that is already filed under another order or design is refused with a body that
 * names where (p4-server REPORT §2-6: `existing { orderCode, designKey, … }`). The refusal line says
 * 「どの発注・どのデザインか」, so the operator does not have to search for it.
 *
 * Pure and client-safe. The names come from the API and are shown as text only (never as markup).
 */
export const BINDING_CONFLICT_CODES: readonly string[] = [
  'DOCUMENT_BINDING_CONFLICT',
  'FILE_DOCUMENT_ORDER_MISMATCH',
  'FILE_DOCUMENT_DESIGN_MISMATCH'
];

export interface ExistingBinding {
  orderCode: string | null;
  designKey: string | null;
}

function shortText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 64) : null;
}

/** The existing order code / design of a binding refusal, or null when the answer names none. */
export function existingBindingOf(code: string | null | undefined, data: unknown): ExistingBinding | null {
  if (!code || !BINDING_CONFLICT_CODES.includes(code)) return null;
  if (typeof data !== 'object' || data === null) return null;
  const existing = (data as { existing?: unknown }).existing;
  if (typeof existing !== 'object' || existing === null) return null;
  const orderCode = shortText((existing as { orderCode?: unknown }).orderCode);
  const designKey = shortText((existing as { designKey?: unknown }).designKey);
  return orderCode || designKey ? { orderCode, designKey } : null;
}

/** 「登録済み: 発注 FSO-1・デザイン 表面A」 — the part the refusal line adds. */
export function existingBindingText(binding: ExistingBinding): string {
  const parts = [
    binding.orderCode ? `発注 ${binding.orderCode}` : null,
    binding.designKey ? `デザイン ${binding.designKey}` : null
  ].filter(Boolean);
  return `すでに登録されている先: ${parts.join('・')}。`;
}

/** The refusal's text with the existing binding named (unchanged when the answer names none). */
export function withExistingBinding(message: string, code: string | null | undefined, data: unknown): string {
  const binding = existingBindingOf(code, data);
  return binding ? `${message} ${existingBindingText(binding)}` : message;
}
