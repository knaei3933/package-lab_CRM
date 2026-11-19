import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';
import {
  codeWithStatus,
  displayText,
  HIDDEN_BY_ROLE_LABEL,
  isFieldHiddenByRole,
  isStateWithheld,
  STAFF_VISIBLE_STATE_KEYS,
  VIEWER_VISIBLE_STATE_KEYS
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
  it('mirrors the API staff allowlist in both directions (a key added on either side fails)', () => {
    // Read the API's own literal: a key the API starts allowing tomorrow is not
    // in any input this test could invent, so the behavioural check alone would
    // miss it (review L2).
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(path.join(repoRoot, 'apps/api/src/audit-view.ts'), 'utf8');
    const literal = /const STAFF_STATE_KEYS: readonly string\[\] = \[([^\]]*)\]/.exec(source);
    expect(literal, 'STAFF_STATE_KEYS literal in apps/api/src/audit-view.ts').not.toBeNull();
    // A key listed twice on the API side (filmSupplyOrderId, 9972e99) is one key.
    const apiKeys = [...new Set([...literal![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!))];
    expect(apiKeys.length).toBeGreaterThan(0);
    expect([...apiKeys].sort()).toEqual([...STAFF_VISIBLE_STATE_KEYS].sort());
    // And the parsed list is what the filter really applies.
    const everyKey = Object.fromEntries([...apiKeys, 'poNumber', 'amount'].map((key) => [key, 'x']));
    expect(Object.keys(viewAs('staff', everyKey).afterState as object).sort()).toEqual([...apiKeys].sort());
  });

  it('mirrors the API viewer allowlist (server batch E) in both directions', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(path.join(repoRoot, 'apps/api/src/audit-view.ts'), 'utf8');
    const literal = /const VIEWER_STATE_KEYS: readonly string\[\] = \[([^\]]*)\]/.exec(source);
    expect(literal, 'VIEWER_STATE_KEYS literal in apps/api/src/audit-view.ts').not.toBeNull();
    const apiKeys = [...new Set([...literal![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!))];
    expect([...apiKeys].sort()).toEqual([...VIEWER_VISIBLE_STATE_KEYS].sort());
    const everyKey = Object.fromEntries([...apiKeys, 'poNumber', 'code', 'amount'].map((key) => [key, 'x']));
    expect(Object.keys(viewAs('viewer', everyKey).afterState as object).sort()).toEqual([...apiKeys].sort());
  });

  it('emptyMeansTrimmed: an empty staff answer reads hidden only when the caller opts in; admin stays truthful', () => {
    // UI batch E: readiness keys are on the staff and viewer lists since server batch E,
    // so an event whose keys are all off the staff list is used here.
    const offList = { projectId: 'p-1', commissionAmount: '1200', unitPrice: '3' };
    const staff = viewAs('staff', offList);
    expect(staff.afterState).toEqual({});
    expect(isFieldHiddenByRole(staff, 'commissionAmount')).toBe(false);
    expect(isFieldHiddenByRole(staff, 'commissionAmount', { emptyMeansTrimmed: true })).toBe(true);
    expect(isFieldHiddenByRole(viewAs('viewer', offList), 'commissionAmount', { emptyMeansTrimmed: true })).toBe(true);
    expect(isFieldHiddenByRole(viewAs('admin', offList), 'commissionAmount', { emptyMeansTrimmed: true })).toBe(false);
  });

  it('readiness (server batch E): staff and viewer read the state, the amounts stay withheld', () => {
    const readiness = { projectId: 'p-1', readinessState: 'READY', isReady: true, blocking: [], commissionAmount: '1200' };
    for (const role of ['staff', 'viewer'] as const) {
      const answer = viewAs(role, readiness);
      expect(displayText(answer, 'readinessState', '未記録')).toBe('READY');
      expect(isFieldHiddenByRole(answer, 'commissionAmount')).toBe(true);
    }
  });

  it('mirrors the API staff allowlist exactly', () => {
    const everyKey = Object.fromEntries(
      [...STAFF_VISIBLE_STATE_KEYS, 'poNumber', 'amount', 'sha256', 'storagePath'].map((key) => [key, 'x'])
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
    // UI batch E: the PO number and registration date are staff-readable since server batch E.
    const staff = viewAs('staff', { ...PO_CREATED, totalAmount: '480000' });
    expect(isStateWithheld(staff)).toBe(false);
    expect(displayText(staff, 'poNumber', '（発注番号未記録）')).toBe('SC-2026-1118');
    expect(isFieldHiddenByRole(staff, 'officialRegisteredAt')).toBe(false);
    expect(isFieldHiddenByRole(staff, 'totalAmount')).toBe(true);
    expect(isFieldHiddenByRole(staff, 'status')).toBe(false);
    const staffOrder = viewAs('staff', { id: 'o-1', code: 'FSO-1', status: 'DRAFT', lineCount: 1 });
    expect(displayText(staffOrder, 'code', '（コード未記録）')).toBe('FSO-1');
  });

  it('staff: an allowlisted key that is truly missing stays 未記録', () => {
    const staff = viewAs('staff', { id: 'o-1', status: 'DRAFT' });
    expect(displayText(staff, 'code', '（コード未記録）')).toBe('（コード未記録）');
  });

  it('viewer (server batch E): the status is readable; every other value reads 閲覧権限なし, never 未記録', () => {
    const viewer = viewAs('viewer', PO_CREATED);
    expect(isStateWithheld(viewer)).toBe(false);
    expect(displayText(viewer, 'status', '未記録')).toBe('RECEIVED');
    expect(displayText(viewer, 'poNumber', '（発注番号未記録）')).toBe(HIDDEN_BY_ROLE_LABEL);
    expect(displayText(viewer, 'code', '（コード未記録）')).toBe(HIDDEN_BY_ROLE_LABEL);
    expect(isFieldHiddenByRole(viewer, 'officialRegisteredAt')).toBe(true);
    // An event without any viewer key is still sent without its state.
    const noStatus = viewAs('viewer', { id: 'po-1', poNumber: 'SC-1' });
    expect(isStateWithheld(noStatus)).toBe(true);
    expect(displayText(noStatus, 'poNumber', '（発注番号未記録）')).toBe(HIDDEN_BY_ROLE_LABEL);
  });

  it('order details (line count, PO link): admin and staff read them (server batch E), viewer does not', () => {
    const created = { id: 'o-1', code: 'FSO-1', status: 'DRAFT', lineCount: 1, sevenPurchaseOrderId: null };
    expect(isFieldHiddenByRole(viewAs('admin', created), 'lineCount')).toBe(false);
    expect(isFieldHiddenByRole(viewAs('admin', created), 'sevenPurchaseOrderId')).toBe(false);
    expect(isFieldHiddenByRole(viewAs('staff', created), 'lineCount')).toBe(false);
    expect(isFieldHiddenByRole(viewAs('staff', created), 'sevenPurchaseOrderId')).toBe(false);
    expect(isFieldHiddenByRole(viewAs('viewer', created), 'lineCount')).toBe(true);
    expect(isFieldHiddenByRole(viewAs('viewer', created), 'sevenPurchaseOrderId')).toBe(true);
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
