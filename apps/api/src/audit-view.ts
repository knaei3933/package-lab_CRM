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
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  requestMetadata?: Record<string, unknown> | null;
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
  'verificationStatus',
  'deliveryKind',
  'confirmationState'
];

/** Staff sees which operation produced the event, and nothing else it carried. */
const STAFF_REQUEST_METADATA_KEYS: readonly string[] = ['operation'];

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

    if (role === 'viewer') return summary;

    if (role === 'staff') {
      return {
        ...summary,
        beforeState: allowlistObject(row.beforeState, STAFF_STATE_KEYS),
        afterState: allowlistObject(row.afterState, STAFF_STATE_KEYS),
        requestMetadata: allowlistObject(row.requestMetadata, STAFF_REQUEST_METADATA_KEYS)
      };
    }

    return {
      ...summary,
      beforeState: (row.beforeState ?? null) as Record<string, unknown> | null,
      afterState: (row.afterState ?? null) as Record<string, unknown> | null,
      requestMetadata: (row.requestMetadata ?? null) as Record<string, unknown> | null
    };
  });
}
