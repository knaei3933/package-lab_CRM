/**
 * UI batch A (P1-4): tell "not recorded" apart from "hidden from this role".
 *
 * The audit-history endpoint answers every role with the same rows but shapes
 * the payload by role (apps/api/src/audit-view.ts, buildAuditViewForRole):
 * - viewer: only status / readinessState / isReady (server batch E) and
 *   paymentTerms (UI batch E3), or no
 *   state at all when the event carries none of them;
 * - staff: afterState trimmed to an allowlist of identifier/status keys;
 * - admin: the full state.
 * Before this module the screens replayed a missing key as 「未記録」, which
 * told a viewer that a recorded PO number or order code did not exist. This is
 * display only: the API keeps deciding what each role may read.
 */

/** Shown where the API withheld a value from the signed-in role. */
export const HIDDEN_BY_ROLE_LABEL = '（閲覧権限なし）';

/** The same, for use inside an existing pair of brackets, e.g. 「FSO-1（閲覧権限なし）」. */
export const HIDDEN_BY_ROLE_SHORT = '閲覧権限なし';

/**
 * Mirror of STAFF_STATE_KEYS in apps/api/src/audit-view.ts. The contract test
 * tests/web-redaction-labels.test.ts runs the API's own filter against this
 * list, so a drift between the two fails the suite instead of mislabelling.
 * UI batch E: server batch E (9972e99) widened it to the business identifiers
 * staff need (PO number, lines, approval evidence, delivery and readiness
 * keys); amounts, payment terms, hashes and snapshots stay off it.
 * UI batch E2: server follow-up (db4bd88) adds the document's file name and
 * issuing entity, so staff can tell evidence files apart; bytes, sha256,
 * storage paths and sizes stay off it.
 * UI batch E3: the representative decided to show the 決済条件 (paymentTerms)
 * to staff and viewer; amounts, unit prices and commissions stay off both lists.
 */
export const STAFF_VISIBLE_STATE_KEYS: readonly string[] = [
  'id',
  'status',
  'state',
  'code',
  'name',
  'poNumber',
  'officialRegisteredAt',
  'sevenPurchaseOrderId',
  'promotedFromPreOrderId',
  'lineCount',
  'filmSupplyOrderId',
  'lineNumber',
  'description',
  'orderedQuantity',
  'unit',
  'deliveredQuantity',
  'deliverySequence',
  'deliveredAt',
  'filmSupplyOrderLineId',
  'fillingOrderId',
  'fillingOrderLineId',
  'artworkRevisionId',
  'organization',
  'decision',
  'revisionNo',
  'evidenceDocumentVersionId',
  'evidenceIdentifier',
  'evidenceIdentifierStatus',
  'evidenceSource',
  'eventTime',
  'readinessState',
  'isReady',
  'blocking',
  // 62d9305: staff may see where an uploaded version is bound (approval
  // evidence selection); bytes, amounts and storage paths stay out.
  'documentType',
  'documentId',
  // db4bd88: staff can identify the evidence file and who issued it.
  'originalFilename',
  'issuerEntity',
  // Representative decision (UI batch E3): the 決済条件 is shown, amounts are not.
  'paymentTerms',
  'designKey',
  'versionNumber',
  'verificationStatus',
  'deliveryKind',
  'confirmationState',
  'deliveryId',
  'filmDeliveryId',
  'fillingDeliveryId'
];

/**
 * UI batch E: mirror of VIEWER_STATE_KEYS in apps/api/src/audit-view.ts (server
 * batch E). A viewer answer carries only these keys, or no state at all when
 * the event has none of them (pinned by tests/web-redaction-labels.test.ts).
 * UI batch E3: the 決済条件 joins them by the representative's decision.
 */
export const VIEWER_VISIBLE_STATE_KEYS: readonly string[] = ['status', 'readinessState', 'isReady', 'paymentTerms'];

interface StateCarrier {
  afterState?: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the API sent this event without its state (the viewer answer). */
export function isStateWithheld(event: StateCarrier): boolean {
  return !('afterState' in event) || event.afterState === undefined;
}

/**
 * True when `key` is absent from the event because the caller's role may not
 * read it — not because nothing was recorded.
 *
 * A staff answer is recognised by its shape: every key it carries is on the
 * staff allowlist. An admin answer for the same event carries the full state
 * (the keys this helper is asked about are always present in it), so a key
 * that is missing there is genuinely unrecorded and stays 「未記録」.
 * Pass `emptyMeansTrimmed` only for events whose full state is never empty
 * (e.g. COMMISSION_READINESS_EVALUATED, whose keys are all off the allowlist).
 */
export function isFieldHiddenByRole(
  event: StateCarrier,
  key: string,
  options: { emptyMeansTrimmed?: boolean } = {}
): boolean {
  if (isStateWithheld(event)) return true;
  const after = event.afterState;
  if (!isPlainRecord(after)) return false;
  if (key in after) return false;
  const present = Object.keys(after);
  // An empty state carries no evidence of trimming: treat it as unrecorded —
  // unless the caller knows the full state of this event is never empty (the
  // staff allowlist can then only have trimmed every key away).
  if (present.length === 0) return options.emptyMeansTrimmed === true;
  // UI batch E: a viewer answer (server batch E) carries only status-like keys;
  // every other key is withheld from it, never 「未記録」. A staff or admin
  // answer always carries an identifier (id, code, …) beside its status, so it
  // is not mistaken for one.
  if (present.every((name) => VIEWER_VISIBLE_STATE_KEYS.includes(name))) {
    return !VIEWER_VISIBLE_STATE_KEYS.includes(key);
  }
  if (STAFF_VISIBLE_STATE_KEYS.includes(key)) return false;
  return present.every((name) => STAFF_VISIBLE_STATE_KEYS.includes(name));
}

/**
 * The text value of `key`, or the role-hidden label, or the caller's
 * 「未記録」-style fallback — in that order of truth.
 */
export function displayText(event: StateCarrier, key: string, unrecordedLabel: string): string {
  const after = event.afterState;
  if (isPlainRecord(after)) {
    const value = after[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return isFieldHiddenByRole(event, key) ? HIDDEN_BY_ROLE_LABEL : unrecordedLabel;
}

/**
 * 「code（status）」 for selects and headings. A withheld status (null) reads
 * 「code（閲覧権限なし）」, and when the code is withheld too the label is just
 * 「（閲覧権限なし）」 — never doubled brackets.
 */
export function codeWithStatus(code: string, status: string | null): string {
  if (status !== null) return `${code}（${status}）`;
  return code === HIDDEN_BY_ROLE_LABEL ? code : `${code}（${HIDDEN_BY_ROLE_SHORT}）`;
}
