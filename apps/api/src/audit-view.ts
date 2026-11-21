import type { UserRole } from '@kanei/core';

/**
 * M7 security fix S3: role-based filtering of the audit history response.
 *
 * audit_events is append-only and is never rewritten here: every reader gets
 * the same rows in the same order, only the *answer* is shaped by the caller's
 * role. The policy lives in this one function so the admin, staff and viewer
 * answers can never drift apart, and the sensitive-key rules are explicit
 * allowlists rather than denylists — a field that appears tomorrow is hidden
 * by default until it is added here on purpose.
 */

/** One audit_events row as the audit-history endpoint selects it. */
export interface AuditHistoryRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState: unknown;
  afterState: unknown;
  occurredAt: Date;
  requestMetadata: unknown;
  actor: { id: string; displayName: string; role: string | null } | null;
}

export interface AuditEventView {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  actor: { id: string; displayName: string; role: string | null } | null;
  beforeState?: Record<string, unknown> | null | undefined;
  afterState?: Record<string, unknown> | null | undefined;
  requestMetadata?: Record<string, unknown> | null | undefined;
}

/**
 * Staff sees the shape of what happened, not the numbers in it: identifiers and
 * status-like keys only. Amounts, prices, costs, purchase amounts, whole
 * snapshots, attachment payloads and mail sender/recipient lists are absent
 * because they are not on this list.
 */
const STAFF_STATE_KEYS: readonly string[] = [
  'id',
  'status',
  'state',
  'code',
  'name',
  // Seventh-persona visibility decision: staff can identify the business work
  // (orders, POs, lines and approval evidence), but monetary amounts, unit
  // prices and commission amounts stay off this allowlist. The 2026-11-19
  // representative decision classifies paymentTerms as a transaction term
  // (not an amount), so staff and viewer may see it.
  'paymentTerms',
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
  // A staff recorder needs to know that an uploaded version is approval
  // evidence and where it is bound; bytes, amounts and storage paths stay out.
  'documentType',
  'documentId',
  'originalFilename',
  'issuerEntity',
  'filmSupplyOrderId',
  'designKey',
  'versionNumber',
  'verificationStatus',
  'deliveryKind',
  'confirmationState',
  'deliveryId',
  'filmDeliveryId',
  'fillingDeliveryId',
];

/** Staff sees which operation produced the event, and nothing else it carried. */
const STAFF_REQUEST_METADATA_KEYS: readonly string[] = ['operation'];

/**
 * Viewer is read-only and sees lifecycle/readiness state plus the approved
 * public payment term. Business identifiers, evidence details, and fields
 * needed to submit a write remain absent.
 */
const VIEWER_STATE_KEYS: readonly string[] = [
  'status',
  'readinessState',
  'isReady',
  'paymentTerms'
];

/**
 * P2 policy P-2: the auditor sees who did what and when, on what, and on what
 * evidence — codes, statuses, the approval facts and the evidence metadata
 * (file name, hash, issuer, who verified it and when). Amounts, unit prices,
 * costs, snapshot bodies and their digests (a digest of a body that holds an
 * amount can be guessed back), mail sender/recipient lists, evidence
 * identifiers and storage paths are absent because they are not on this list.
 */
const AUDITOR_STATE_KEYS: readonly string[] = [
  'id',
  'status',
  'state',
  'code',
  'name',
  'poNumber',
  'orderCode',
  'displayNumber',
  'paymentTerms',
  'officialRegisteredAt',
  'sevenPurchaseOrderId',
  'filmSupplyOrderId',
  'makerPurchaseOrderId',
  'artworkRevisionId',
  'approvalEventId',
  'organization',
  'decision',
  'revisionNo',
  'designKey',
  'eventTime',
  'evidenceSource',
  'evidenceDocumentVersionId',
  'evidenceIdentifierStatus',
  'documentType',
  'documentId',
  'originalFilename',
  'issuerEntity',
  'sha256',
  'fileSha256',
  'approvedFileSha256',
  'byteSize',
  'detectedMimeType',
  'versionNumber',
  'verificationStatus',
  'verifiedAt',
  'verifiedByUserId',
  'result',
  'ceoApprovedAt',
  'ceoApprovedByUserId',
  'selfVerification',
  'readinessState',
  'isReady',
  'requestedDeliveryDate',
  'plannedDeliveryDate'
];

/** The auditor sees which operation produced the event and whether it was automatic. */
const AUDITOR_REQUEST_METADATA_KEYS: readonly string[] = ['operation', 'automatic', 'rule', 'trigger'];

/** Quote file names may carry their price; the auditor does not read them (security review L3). */
const AUDITOR_HIDDEN_FILENAME_TYPES: readonly string[] = ['film_quote_kanei', 'filling_quote_seven'];

function withoutQuoteFilename(state: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!state || !AUDITOR_HIDDEN_FILENAME_TYPES.includes(String(state.documentType))) return state;
  const { originalFilename: _hidden, ...rest } = state;
  return rest;
}

function allowlistObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) picked[key] = source[key];
  }
  return picked;
}

function allowlistState(value: unknown, keys: readonly string[]): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  const picked = allowlistObject(value, keys);
  if (!picked || Object.keys(picked).length === 0) return undefined;
  return picked;
}

export function buildAuditViewForRole(role: UserRole, rows: readonly AuditHistoryRow[]): AuditEventView[] {
  return rows.map((row) => {
    const summary: AuditEventView = {
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      occurredAt: row.occurredAt,
      actor: row.actor
    };

    if (role === 'admin') {
      return {
        ...summary,
        beforeState: (row.beforeState ?? null) as Record<string, unknown> | null,
        afterState: (row.afterState ?? null) as Record<string, unknown> | null,
        requestMetadata: (row.requestMetadata ?? null) as Record<string, unknown> | null
      };
    }

    if (role === 'staff') {
      return {
        ...summary,
        beforeState: allowlistObject(row.beforeState, STAFF_STATE_KEYS),
        afterState: allowlistObject(row.afterState, STAFF_STATE_KEYS),
        requestMetadata: allowlistObject(row.requestMetadata, STAFF_REQUEST_METADATA_KEYS)
      };
    }

    if (role === 'auditor') {
      return {
        ...summary,
        beforeState: withoutQuoteFilename(allowlistObject(row.beforeState, AUDITOR_STATE_KEYS)),
        afterState: withoutQuoteFilename(allowlistObject(row.afterState, AUDITOR_STATE_KEYS)),
        requestMetadata: allowlistObject(row.requestMetadata, AUDITOR_REQUEST_METADATA_KEYS)
      };
    }

    // viewer — and, fail closed, any role this function does not know (P2: the
    // full answer is admin's only, never a fall-through default).
    return {
      ...summary,
      beforeState: allowlistState(row.beforeState, VIEWER_STATE_KEYS),
      afterState: allowlistState(row.afterState, VIEWER_STATE_KEYS)
    };
  });
}
