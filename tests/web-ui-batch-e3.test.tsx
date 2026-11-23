import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';

/**
 * UI batch E3 (demo-eml/ui-batch-e3/REPORT.md): the representative decided the
 * 支払条件 (paymentTerms) is public — staff and viewer read it — while amounts
 * stay hidden. The redaction mirror itself is pinned against the API's own
 * lists by tests/web-redaction-labels.test.ts; the real-API answer and the
 * /orders column by tests/web-ui-batch-e3-parity.test.tsx.
 */
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({ callApi: (...args: unknown[]) => callApi(...args) }));

const { loadWorkspace } = await import('../apps/web/src/lib/project-data.js');
const { STAFF_VISIBLE_STATE_KEYS, VIEWER_VISIBLE_STATE_KEYS, HIDDEN_BY_ROLE_LABEL, isFieldHiddenByRole } =
  await import('../apps/web/src/lib/redaction.js');
const { paymentTermsText } = await import('../apps/web/src/lib/decision-facts.js');

const PROJECT_ID = '01a1ec52-a795-7bdb-bc42-fd346d93d333';
const FILM_ID = '01a1ec53-c317-71c1-9432-30370abae8f0';
const USER_ID = '01a1ec52-a730-7596-aff1-4072d76c1cf8';

function auditRow(index: number, action: string, afterState: Record<string, unknown>, beforeState: Record<string, unknown> | null = null): AuditHistoryRow {
  return {
    id: `01a1ec53-0000-7000-8000-00000000000${index}`,
    action,
    entityType: 'film_supply_order',
    entityId: FILM_ID,
    beforeState,
    afterState,
    occurredAt: new Date(`2026-11-19T01:4${index}:00Z`),
    requestMetadata: { operation: action.toLowerCase() },
    actor: { id: USER_ID, displayName: '合成担当者', role: 'staff' }
  };
}

const CREATED = auditRow(1, 'FILM_SUPPLY_ORDER_CREATED', {
  id: FILM_ID, code: 'FSO-E3-001', status: 'DRAFT', lineCount: 1, projectId: PROJECT_ID, holdReason: null,
  paymentTerms: 'undetermined', exceptionNote: null, createdByUserId: USER_ID, sevenPurchaseOrderId: null
});
const RECORDED = auditRow(2, 'FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED', { paymentTerms: 'prepaid' }, { paymentTerms: 'undetermined' });

/** The answer the API gave before the decision: paymentTerms on neither list. */
function preDecisionView(role: 'staff' | 'viewer', rows: AuditHistoryRow[]) {
  const strip = (state: unknown) => {
    if (!state || typeof state !== 'object') return state;
    const { paymentTerms: _ignored, ...rest } = state as Record<string, unknown>;
    return rest;
  };
  return buildAuditViewForRole(role, rows.map((row) => ({ ...row, beforeState: strip(row.beforeState), afterState: strip(row.afterState) })));
}

function serve(view: (rows: AuditHistoryRow[]) => unknown[], rows: AuditHistoryRow[]) {
  callApi.mockImplementation(async (path: string) => {
    if (path === `/api/projects/${PROJECT_ID}`) {
      return { ok: true, status: 200, error: null, data: { id: PROJECT_ID, code: 'CMP-F1-0001', name: '合成', route: 'F1', status: 'ACTIVE' } };
    }
    if (path === '/api/status-labels') {
      return { ok: true, status: 200, error: null, data: { filmSupplyOrderStates: [], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] } };
    }
    const entityType = new URL(path, 'http://x').searchParams.get('entityType');
    const events = entityType === 'film_supply_order' ? JSON.parse(JSON.stringify(view(rows))) : [];
    return { ok: true, status: 200, error: null, data: { events } };
  });
}

beforeEach(() => {
  callApi.mockReset();
});

describe('E3: the redaction mirror carries the 支払条件, not the amounts', () => {
  it('staff and viewer lists both carry paymentTerms; no amount key is on either', () => {
    expect(STAFF_VISIBLE_STATE_KEYS).toContain('paymentTerms');
    expect(VIEWER_VISIBLE_STATE_KEYS).toContain('paymentTerms');
    for (const key of ['amount', 'totalAmount', 'unitPrice', 'price', 'commissionAmount', 'amounts']) {
      expect(STAFF_VISIBLE_STATE_KEYS).not.toContain(key);
      expect(VIEWER_VISIBLE_STATE_KEYS).not.toContain(key);
    }
  });

  it('a viewer answer of status + term is still read as a viewer answer (the code stays 閲覧権限なし)', () => {
    const viewer = { afterState: { status: 'DRAFT', paymentTerms: 'prepaid' } };
    expect(isFieldHiddenByRole(viewer, 'paymentTerms')).toBe(false);
    expect(isFieldHiddenByRole(viewer, 'code')).toBe(true);
    expect(isFieldHiddenByRole(viewer, 'lineCount')).toBe(true);
  });
});

describe('E3: paymentTermsText — the cell of the 支払条件 column', () => {
  it('Japanese label, the withheld label, or 未記録 — never the stored code', () => {
    expect(paymentTermsText({ paymentTerms: 'prepaid', paymentTermsHidden: false })).toBe('前払い');
    expect(paymentTermsText({ paymentTerms: 'on_delivery', paymentTermsHidden: false })).toBe('納品後払い');
    expect(paymentTermsText({ paymentTerms: 'undetermined', paymentTermsHidden: false })).toBe('未定');
    expect(paymentTermsText({ paymentTerms: null, paymentTermsHidden: true })).toBe(HIDDEN_BY_ROLE_LABEL);
    expect(paymentTermsText({ paymentTerms: null, paymentTermsHidden: false })).toBe('（未記録）');
    expect(paymentTermsText({})).toBe('（未記録）');
  });
});

describe('E3: loadWorkspace replays the 支払条件 for every role', () => {
  for (const role of ['admin', 'staff', 'viewer'] as const) {
    it(`${role}: the later 支払条件の記録 replaces the creation value`, async () => {
      serve((rows) => buildAuditViewForRole(role, rows), [CREATED, RECORDED]);
      const [order] = (await loadWorkspace(PROJECT_ID)).filmOrders;
      expect(order).toMatchObject({ paymentTerms: 'prepaid', paymentTermsHidden: false });
      expect(paymentTermsText(order!)).toBe('前払い');
    });
  }

  it('the creation value alone stands when nothing was recorded later', async () => {
    serve((rows) => buildAuditViewForRole('viewer', rows), [CREATED]);
    const [order] = (await loadWorkspace(PROJECT_ID)).filmOrders;
    // p6 H10: the viewer now reads the order code too.
    expect(order).toMatchObject({ paymentTerms: 'undetermined', paymentTermsHidden: false, code: 'FSO-E3-001', detailsHidden: true });
  });

  for (const role of ['staff', 'viewer'] as const) {
    it(`${role}, answer shaped without paymentTerms (before the decision): 閲覧権限なし, never 未記録`, async () => {
      serve((rows) => preDecisionView(role, rows), [CREATED, RECORDED]);
      const [order] = (await loadWorkspace(PROJECT_ID)).filmOrders;
      expect(order).toMatchObject({ paymentTerms: null, paymentTermsHidden: true });
      expect(paymentTermsText(order!)).toBe(HIDDEN_BY_ROLE_LABEL);
    });
  }
});
