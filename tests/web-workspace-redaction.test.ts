import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';

/**
 * UI batch A (P1-4), end to end through the web data layer: loadWorkspace()
 * replays audit rows that the API's own role filter shaped (admin / staff /
 * viewer), and the resulting view must say 「閲覧権限なし」 exactly where the
 * role cannot see a recorded value — and stay truthful for admin.
 * The row payloads are the real shapes recorded by the API (taken from a
 * throwaway DB run of the current code: SEVEN_PO_CREATED, film/filling order
 * creation, the checklist, and a document row).
 */
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({ callApi: (...args: unknown[]) => callApi(...args) }));

const { loadWorkspace } = await import('../apps/web/src/lib/project-data.js');
const { HIDDEN_BY_ROLE_LABEL } = await import('../apps/web/src/lib/redaction.js');

const PROJECT_ID = '01a1ec52-a795-7bdb-bc42-fd346d93d333';
const PO_ID = '01a1ec53-af67-75da-a932-e03a902de940';
const FILM_ID = '01a1ec53-c317-71c1-9432-30370abae8f0';
const FILLING_ID = '01a1ec53-c327-73e9-a614-b069df82b0ae';
const DOC_ID = '01a1ec53-d000-7000-8000-000000000001';
const USER_ID = '01a1ec52-a730-7596-aff1-4072d76c1cf8';

function auditRow(index: number, entityType: string, action: string, entityId: string, afterState: Record<string, unknown>): AuditHistoryRow {
  return {
    id: `01a1ec53-0000-7000-8000-00000000000${index}`,
    action,
    entityType,
    entityId,
    beforeState: null,
    afterState,
    occurredAt: new Date(`2026-11-18T01:4${index}:00Z`),
    requestMetadata: { operation: action.toLowerCase() },
    actor: { id: USER_ID, displayName: '合成代表者', role: 'admin' }
  };
}

const ROWS: AuditHistoryRow[] = [
  auditRow(1, 'seven_purchase_order', 'SEVEN_PO_CREATED', PO_ID, {
    id: PO_ID, poNumber: 'SC-2026-1118', createdAt: '2026-11-18T01:44:29.799Z', projectId: PROJECT_ID,
    updatedAt: '2026-11-18T01:44:29.799Z', promotedAt: null, createdByUserId: USER_ID, promotedByUserId: null,
    originalReceivedAt: null, preOrderReferenceId: null, officialRegisteredAt: '2026-11-18T01:05:00.000Z'
  }),
  auditRow(2, 'film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', FILM_ID, {
    id: FILM_ID, code: 'FSO-2026-001', status: 'DRAFT', createdAt: '2026-11-18T01:44:34.839Z', deletedAt: null,
    lineCount: 1, projectId: PROJECT_ID, updatedAt: '2026-11-18T01:44:34.839Z', holdReason: null,
    paymentTerms: 'undetermined', exceptionNote: null, createdByUserId: USER_ID, sevenPurchaseOrderId: PO_ID
  }),
  auditRow(3, 'filling_order', 'FILLING_ORDER_CREATED', FILLING_ID, {
    id: FILLING_ID, code: 'FIL-2026-001', createdAt: '2026-11-18T01:44:34.855Z', deletedAt: null, lineCount: 1,
    projectId: PROJECT_ID, updatedAt: '2026-11-18T01:44:34.855Z', createdByUserId: USER_ID
  }),
  auditRow(4, 'seven_purchase_order', 'SEVEN_PO_VERIFICATION_RECORDED', PO_ID, {
    id: PO_ID, poNumber: 'SC-2026-1118', verificationStatus: 'verified', reviewPending: false,
    officialRegisteredAt: '2026-11-18T01:05:00.000Z', verifiedAt: '2026-11-18T01:44:41.892Z'
  }),
  auditRow(5, 'document', 'DOCUMENT_CREATED', DOC_ID, {
    id: DOC_ID, projectId: PROJECT_ID, documentType: 'seven_po', issuerEntity: 'seven',
    originalFilename: 'SC-2026-1118.pdf', note: null, verificationStatus: 'verified', verificationNote: null,
    sevenPurchaseOrderId: PO_ID, filmSupplyOrderId: null, designKey: null
  })
];

function serveAs(role: 'admin' | 'staff' | 'viewer') {
  callApi.mockImplementation(async (path: string) => {
    if (path === `/api/projects/${PROJECT_ID}`) {
      return { ok: true, status: 200, error: null, data: { id: PROJECT_ID, code: 'CMP-F1-0001', name: '合成', route: 'F1', status: 'ACTIVE' } };
    }
    if (path === '/api/status-labels') {
      return { ok: true, status: 200, error: null, data: { filmSupplyOrderStates: [], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] } };
    }
    const entityType = new URL(path, 'http://x').searchParams.get('entityType');
    const rows = ROWS.filter((row) => row.entityType === entityType);
    // JSON round trip: absent keys stay absent, exactly as over HTTP.
    const events = JSON.parse(JSON.stringify(buildAuditViewForRole(role, rows)));
    return { ok: true, status: 200, error: null, data: { events } };
  });
}

beforeEach(() => {
  callApi.mockReset();
});

describe('loadWorkspace role labels (UI batch A, P1-4)', () => {
  it('admin sees every recorded value and no hidden flags', async () => {
    serveAs('admin');
    const workspace = await loadWorkspace(PROJECT_ID);
    const [po] = workspace.sevenPurchaseOrders;
    expect(po).toMatchObject({ poNumber: 'SC-2026-1118', verificationStatus: 'verified', officialRegistrationHidden: false, verificationHidden: false });
    expect(po?.officialRegisteredAt).toBe('2026-11-18T01:05:00.000Z');
    expect(workspace.filmOrders[0]).toMatchObject({ code: 'FSO-2026-001', status: 'DRAFT', sevenPurchaseOrderId: PO_ID, lineCount: 1, detailsHidden: false, statusHidden: false });
    expect(workspace.fillingOrders[0]).toMatchObject({ code: 'FIL-2026-001', detailsHidden: false });
    expect(workspace.documents[0]).toMatchObject({ documentType: 'seven_po', filename: 'SC-2026-1118.pdf', detailsHidden: false, typeHidden: false, verificationHidden: false });
  });

  it('staff (server batch E): PO number, registration date, lines and links read; issuer and file name stay hidden', async () => {
    serveAs('staff');
    const workspace = await loadWorkspace(PROJECT_ID);
    const [po] = workspace.sevenPurchaseOrders;
    expect(po?.poNumber).toBe('SC-2026-1118');
    expect(po?.poNumberHidden).toBe(false);
    expect(po?.officialRegisteredAt).toBe('2026-11-18T01:05:00.000Z');
    expect(po?.officialRegistrationHidden).toBe(false);
    expect(po?.verificationStatus).toBe('verified');
    expect(po?.verificationHidden).toBe(false);
    expect(workspace.filmOrders[0]).toMatchObject({
      code: 'FSO-2026-001', status: 'DRAFT', statusHidden: false, detailsHidden: false, sevenPurchaseOrderId: PO_ID, lineCount: 1
    });
    expect(workspace.fillingOrders[0]).toMatchObject({ code: 'FIL-2026-001', detailsHidden: false });
    // The issuer and the file name are still off the staff list (probe: issuerEntity).
    expect(workspace.documents[0]).toMatchObject({
      documentType: 'seven_po', typeHidden: false, filename: HIDDEN_BY_ROLE_LABEL, detailsHidden: true,
      verificationStatus: 'verified', verificationHidden: false
    });
  });

  it('viewer: the order status reads (server batch E); every other recorded value reads hidden — never 未記録 or 未登録', async () => {
    serveAs('viewer');
    const workspace = await loadWorkspace(PROJECT_ID);
    const [po] = workspace.sevenPurchaseOrders;
    expect(po).toMatchObject({ poNumber: HIDDEN_BY_ROLE_LABEL, officialRegistrationHidden: true, verificationHidden: true });
    expect(po?.officialRegisteredAt).toBeNull();
    expect(workspace.filmOrders[0]).toMatchObject({ code: HIDDEN_BY_ROLE_LABEL, status: 'DRAFT', statusHidden: false, detailsHidden: true });
    expect(workspace.fillingOrders[0]).toMatchObject({ code: HIDDEN_BY_ROLE_LABEL, detailsHidden: true });
    expect(workspace.documents[0]).toMatchObject({ filename: HIDDEN_BY_ROLE_LABEL, detailsHidden: true, typeHidden: true, verificationHidden: true });
  });
});
