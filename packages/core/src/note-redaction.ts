/**
 * P5 R1 / R3: a reason the representative wrote by hand (the 却下 / 確認 basis of
 * a manual check) is shown to the people who act on it or audit it — staff
 * re-record the approval, the auditor reads 監査履歴. Those roles never read an
 * amount (staff · viewer · auditor: 0), and a free text could carry one, so
 * every figure that reads like money is replaced before such a role gets the
 * text: a number next to a currency sign or word (¥ ￥ $ 円 万円 JPY USD …),
 * and any number of four digits or more (with or without thousands
 * separators). Short numbers (版2, 3件, 11/20) stay readable. The representative
 * reads the stored text unchanged.
 */
export const NOTE_AMOUNT_MASK = '（金額は非表示）';

const CURRENCY_BEFORE = /(?:[¥￥$＄€£]|\b(?:JPY|USD|EUR|円)\s*)\s*[0-9０-９][0-9０-９,，.．]*/giu;
const CURRENCY_AFTER = /[0-9０-９][0-9０-９,，.．]*\s*(?:万|千|億)?\s*(?:円|JPY|USD|EUR|ドル|yen)/giu;
// A date (2026-11-20, 2026/11/20, 2026年) is not an amount: a four-digit run joined to - / 年 stays.
const LONG_NUMBER = /(?<![-/0-9０-９])[0-9０-９](?:[0-9０-９]|[,，.．](?=[0-9０-９])){3,}(?![-/年0-9０-９])/gu;

export function maskAmountsInNote(text: string | null | undefined, maxLength = 500): string | null {
  if (typeof text !== 'string') return null;
  const masked = text
    .replace(CURRENCY_BEFORE, NOTE_AMOUNT_MASK)
    .replace(CURRENCY_AFTER, NOTE_AMOUNT_MASK)
    .replace(LONG_NUMBER, NOTE_AMOUNT_MASK);
  return masked.length > maxLength ? `${masked.slice(0, maxLength)}…` : masked;
}
