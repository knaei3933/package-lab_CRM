/**
 * UI batch E (F-15, review L8): the amount the representative types for a maker
 * paper. Only the spelling is normalised — the yen sign, full-width digits,
 * spaces and thousands commas in their proper places — so 「¥480,000」 and
 * 「４８０，０００」 become 480000. Anything else (「1,2,3」, 「480000円」, a
 * negative sign) is left as typed for isPlainAmount to refuse.
 */
export function normalizeAmountText(raw: string): string {
  const halfWidth = raw
    .replace(/[０-９．，]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[¥￥]/g, '')
    .trim();
  return /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(halfWidth) ? halfWidth.replaceAll(',', '') : halfWidth;
}

/** A non-negative decimal without grouping: what the API stores as totalAmount. */
export function isPlainAmount(text: string): boolean {
  return /^\d+(\.\d+)?$/.test(text);
}
