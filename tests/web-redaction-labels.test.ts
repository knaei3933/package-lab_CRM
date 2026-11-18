import { describe, expect, it } from 'vitest';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';
import {
  codeWithStatus,
  displayText,
  HIDDEN_BY_ROLE_LABEL,
  isFieldHiddenByRole,
  isStateWithheld,
  STAFF_VISIBLE_STATE_KEYS
} from '../apps/web/src/lib/redaction.js';

/**
 * UI batch A (P1-4): a value the API withholds from the role reads
 * 「（閲覧権限なし）」, never 「未記録」. The rows are shaped by the API's own
 * role filter, so the web helper is checked against the real contract.
 */
function row(afterState: Record<string, unknown> | null): AuditHistoryRow {
  return {
    id: 'evt-1',
    action: 'SEVEN_PO_CREATED',
    entityType: 'seven_purchase_order',
    entityId: 'po-1',
    beforeState: null,
    afterState,
    occurredAt: new Date('2026-11-18T01:05:00Z'),
    requestMetadata: { operation: 'create' },
    actor: null
  };
}

const PO_CREATED = { id: 'po-1', poNumber: 'SC-2026-1118', officialRegisteredAt: '2026-11-18T01:05:00Z', status: 'RECEIVED' };

function viewAs(role: 'admin' | 'staff' | 'viewer', state: Record<string, unknown> | null) {
  // JSON round-trip: the web reads the HTTP answer, where absent keys stay absent.
  return JSON.parse(JSON.stringify(buildAuditViewForRole(role, [row(state)])[0])) as Record<string, unknown>;
}

describe('role redaction labels (UI batch A, P1-4)', () => {
  it('mirrors the API staff allowlist exactly', () => {
    const everyKey = Object.fromEntries(
      [...STAFF_VISIBLE_STATE_KEYS, 'poNumber', 'amount', 'originalFilename'].map((key) => [key, 'x'])
    );
    const staff = viewAs('staff', everyKey);
    expect(Object.keys(staff.afterState as object).sort()).toEqual([...STAFF_VISIBLE_STATE_KEYS].sort());
  });

  it('admin: recorded values are shown and a genuinely missing value stays 未記録', () => {
    const admin = viewAs('admin', PO_CREATED);
    expect(displayText(admin, 'poNumber', '（発注番号未記録）')).toBe('SC-2026-1118');
    const withoutDate = viewAs('admin', { id: 'po-1', poNumber: 'SC-1', status: 'RECEIVED' });
    expect(isFieldHiddenByRole(withoutDate, 'officialRegisteredAt')).toBe(false);
    const withoutNumber = viewAs('admin', { id: 'po-1', status: 'RECEIVED', officialRegisteredAt: 'x' });
    expect(displayText(withoutNumber, 'poNumber', '（発注番号未記録）')).toBe('（発注番号未記録）');
  });

  it('staff: keys outside the allowlist read 閲覧権限なし, allowlisted keys stay readable', () => {
    const staff = viewAs('staff', PO_CREATED);
    expect(isStateWithheld(staff)).toBe(false);
    expect(displayText(staff, 'poNumber', '（発注番号未記録）')).toBe(HIDDEN_BY_ROLE_LABEL);
    expect(isFieldHiddenByRole(staff, 'officialRegisteredAt')).toBe(true);
    expect(isFieldHiddenByRole(staff, 'status')).toBe(false);
    const staffOrder = viewAs('staff', { id: 'o-1', code: 'FSO-1', status: 'DRAFT', lineCount: 1 });
    expect(displayText(staffOrder, 'code', '（コード未記録）')).toBe('FSO-1');
  });

  it('staff: an allowlisted key that is truly missing stays 未記録', () => {
    const staff = viewAs('staff', { id: 'o-1', status: 'DRAFT' });
    expect(displayText(staff, 'code', '（コード未記録）')).toBe('（コード未記録）');
  });

  it('viewer: the whole state is withheld, so every value reads 閲覧権限なし', () => {
    const viewer = viewAs('viewer', PO_CREATED);
    expect(isStateWithheld(viewer)).toBe(true);
    expect(displayText(viewer, 'poNumber', '（発注番号未記録）')).toBe(HIDDEN_BY_ROLE_LABEL);
    expect(displayText(viewer, 'code', '（コード未記録）')).toBe(HIDDEN_BY_ROLE_LABEL);
    expect(isFieldHiddenByRole(viewer, 'status')).toBe(true);
  });

  it('order details (line count, PO link) read as hidden for staff and viewer, but not for admin', () => {
    const created = { id: 'o-1', code: 'FSO-1', status: 'DRAFT', lineCount: 1, sevenPurchaseOrderId: null };
    expect(isFieldHiddenByRole(viewAs('admin', created), 'lineCount')).toBe(false);
    expect(isFieldHiddenByRole(viewAs('admin', created), 'sevenPurchaseOrderId')).toBe(false);
    expect(isFieldHiddenByRole(viewAs('staff', created), 'lineCount')).toBe(true);
    expect(isFieldHiddenByRole(viewAs('staff', created), 'sevenPurchaseOrderId')).toBe(true);
    expect(isFieldHiddenByRole(viewAs('viewer', created), 'lineCount')).toBe(true);
  });

  it('an empty state is treated as unrecorded, not as a staff-trimmed one', () => {
    expect(isFieldHiddenByRole({ afterState: {} }, 'poNumber')).toBe(false);
  });

  it('labels code and status without doubled brackets', () => {
    expect(codeWithStatus('FSO-1', '下書き')).toBe('FSO-1（下書き）');
    expect(codeWithStatus('FSO-1', null)).toBe('FSO-1（閲覧権限なし）');
    expect(codeWithStatus(HIDDEN_BY_ROLE_LABEL, null)).toBe('（閲覧権限なし）');
  });

  it('a null state (nothing recorded) is not mistaken for a withheld one', () => {
    const admin = viewAs('admin', null);
    expect(isStateWithheld(admin)).toBe(false);
    expect(displayText(admin, 'code', '（コード未記録）')).toBe('（コード未記録）');
  });
});
