import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';

/**
 * UI batch A follow-up (review of 938abf6: M1, M2, M4, L1, L3, L5).
 *
 * The audit rows below carry the payload shapes the API records
 * (apps/api/src/app.ts: SEVEN_PO_CREATED / SEVEN_PO_OFFICIALLY_REGISTERED,
 * FILM_DELIVERY_RECORDED / FILM_DELIVERY_CONFIRMED, DOCUMENT_VERSION_UPLOADED,
 * ARTWORK_REVISION_REGISTERED, ARTWORK_APPROVAL_RECORDED,
 * COMMISSION_READINESS_EVALUATED). They are shaped for each role by the API's
 * own buildAuditViewForRole and JSON round-tripped, exactly as the web reads
 * them over HTTP. Every record time (occurredAt) is distinct from the business
 * dates, so a record time standing in for a hidden date is caught.
 */
const callApi = vi.hoisted(() => vi.fn());
const sessionRole = vi.hoisted(() => ({ current: 'admin' as 'admin' | 'staff' | 'viewer' }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: (...args: unknown[]) => callApi(...args),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => PROJECT_ID,
  loadSessionUser: async () => ({ id: USER_ID, role: sessionRole.current, displayName: '合成' })
}));

const { loadWorkspace, officialRegistrationText, revisionNumberText, sevenPurchaseOrderChoiceLabel } = await import(
  '../apps/web/src/lib/project-data.js'
);
const { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } = await import('../apps/web/src/lib/redaction.js');
const { formatTimestamp } = await import('../apps/web/src/lib/vocabulary.js');
const { default: OrdersPage } = await import('../apps/web/src/app/orders/page.js');
const { default: DeliveriesPage } = await import('../apps/web/src/app/deliveries/page.js');
const { default: ApprovalsPage } = await import('../apps/web/src/app/approvals/page.js');
const { default: DocumentsPage } = await import('../apps/web/src/app/documents/page.js');
const { default: MakerPoPage } = await import('../apps/web/src/app/maker-po/page.js');

type Role = 'admin' | 'staff' | 'viewer';
const ROLES: Role[] = ['admin', 'staff', 'viewer'];

const PROJECT_ID = '01a1ec52-a795-7bdb-bc42-fd346d93d333';
const USER_ID = '01a1ec52-a730-7596-aff1-4072d76c1cf8';
const PO_REGISTERED = '01a1ec53-af67-75da-a932-e03a902de940';
const PO_UNREGISTERED = '01a1ec53-af67-75da-a932-e03a902de941';
const FILM_ID = '01a1ec53-c317-71c1-9432-30370abae8f0';
const LINE_ID = '01a1ec53-c317-71c1-9432-30370abae8f1';
const DOC_ID = '01a1ec53-d000-7000-8000-000000000001';
const VERSION_ID = '01a1ec53-d000-7000-8000-000000000002';
const REVISION_ID = '01a1ec53-e000-7000-8000-000000000001';
const APPROVAL_ID = '01a1ec53-e000-7000-8000-000000000002';
const DELIVERY_ID = '01a1ec53-f000-7000-8000-000000000001';
const CONFIRMATION_ID = '01a1ec53-f000-7000-8000-000000000002';

/** Business dates — none of them equals any record time below. */
const REGISTERED_AT = '2026-11-16T00:00:00.000Z'; // 2026/11/16 09:00 JST
const DELIVERED_AT = '2026-11-17T23:00:00.000Z'; // 2026/11/18 08:00 JST
const APPROVED_AT = '2026-11-17T09:00:00.000Z'; // 2026/11/17 18:00 JST

let sequence = 0;
function auditRow(
  entityType: string,
  action: string,
  entityId: string,
  afterState: Record<string, unknown>,
  requestMetadata: Record<string, unknown> = { operation: action.toLowerCase() },
  beforeState: Record<string, unknown> | null = null
): AuditHistoryRow {
  sequence += 1;
  return {
    id: `01a1ec54-0000-7000-8000-0000000000${String(sequence).padStart(2, '0')}`,
    action,
    entityType,
    entityId,
    beforeState,
    afterState,
    // Record times: 2026-11-18 03:MM UTC (12:MM JST), distinct from the dates above.
    occurredAt: new Date(`2026-11-18T03:${String(10 + sequence).padStart(2, '0')}:00Z`),
    requestMetadata,
    actor: { id: USER_ID, displayName: '合成代表者', role: 'admin' }
  };
}

function poRow(id: string, poNumber: string, officialRegisteredAt: string | null) {
  return {
    id, projectId: PROJECT_ID, poNumber, preOrderReferenceId: null, originalReceivedAt: null,
    officialRegisteredAt, promotedAt: null, promotedByUserId: null, verificationStatus: 'unverified',
    createdByUserId: USER_ID, createdAt: '2026-11-18T03:00:00.000Z', updatedAt: '2026-11-18T03:00:00.000Z'
  };
}

const ROWS: AuditHistoryRow[] = [
  auditRow('seven_purchase_order', 'SEVEN_PO_CREATED', PO_REGISTERED, poRow(PO_REGISTERED, 'SC-REG-1', null)),
  auditRow('seven_purchase_order', 'SEVEN_PO_CREATED', PO_UNREGISTERED, poRow(PO_UNREGISTERED, 'SC-NEW-2', null)),
  auditRow(
    'seven_purchase_order',
    'SEVEN_PO_OFFICIALLY_REGISTERED',
    PO_REGISTERED,
    { ...poRow(PO_REGISTERED, 'SC-REG-1', null), officialRegisteredAt: REGISTERED_AT },
    { operation: 'seven_po:register' },
    poRow(PO_REGISTERED, 'SC-REG-1', null)
  ),
  auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', FILM_ID, {
    id: FILM_ID, code: 'FSO-2026-009', status: 'DRAFT', lineCount: 1, projectId: PROJECT_ID,
    paymentTerms: 'undetermined', sevenPurchaseOrderId: PO_REGISTERED, createdByUserId: USER_ID
  }),
  auditRow('document', 'DOCUMENT_CREATED', DOC_ID, {
    id: DOC_ID, projectId: PROJECT_ID, documentType: 'acceptance_evidence', issuerEntity: 'maker',
    originalFilename: 'accept.pdf', note: null, verificationStatus: 'verified', verificationNote: null,
    sevenPurchaseOrderId: null, filmSupplyOrderId: FILM_ID, designKey: null
  }),
  auditRow('document_version', 'DOCUMENT_VERSION_UPLOADED', VERSION_ID, {
    id: VERSION_ID, documentId: DOC_ID, versionNumber: 1, sha256: 'ab'.repeat(32), byteSize: 10,
    storagePath: 'x/y', originalFilename: 'accept.pdf', declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf', sizeCheckPassed: true, typeCheckPassed: true,
    createdByUserId: USER_ID, createdAt: '2026-11-18T03:00:00.000Z'
  }, { operation: 'document:create', documentId: DOC_ID }),
  auditRow('artwork_revision', 'ARTWORK_REVISION_REGISTERED', REVISION_ID, {
    id: REVISION_ID, filmSupplyOrderId: FILM_ID, designKey: 'label-front', revisionNo: 1,
    fileDocumentVersionId: VERSION_ID, fileSha256: 'ab'.repeat(32), note: null, invalidatedApprovals: false
  }, { operation: 'artwork_revision:register', filmSupplyOrderId: FILM_ID }),
  auditRow('artwork_approval_event', 'ARTWORK_APPROVAL_RECORDED', APPROVAL_ID, {
    id: APPROVAL_ID, artworkRevisionId: REVISION_ID, organization: 'customer', decision: 'APPROVE',
    externalApproverName: '顧客担当', externalApproverOrg: null, recordedByUserId: USER_ID,
    evidenceDocumentVersionId: VERSION_ID, evidenceIdentifier: '<a@example.test>',
    evidenceIdentifierStatus: 'verified', evidenceSource: 'email', approvedFileSha256: 'ab'.repeat(32),
    eventTime: APPROVED_AT, recordedAt: '2026-11-18T03:00:00.000Z', supersedesEventId: null,
    designKey: 'label-front', revisionNo: 1
  }, { operation: 'artwork_approval:record', filmSupplyOrderId: FILM_ID }),
  auditRow('film_delivery', 'FILM_DELIVERY_RECORDED', DELIVERY_ID, {
    id: DELIVERY_ID, filmSupplyOrderId: FILM_ID, filmSupplyOrderLineId: LINE_ID, unit: 'rolls',
    deliveredQuantity: '10.000', deliverySequence: 1, deliveredAt: DELIVERED_AT, carrierReference: null,
    note: null, createdAt: '2026-11-18T03:00:00.000Z'
  }, { operation: 'film_delivery:create', filmSupplyOrderId: FILM_ID }),
  auditRow('delivery_confirmation', 'FILM_DELIVERY_CONFIRMED', CONFIRMATION_ID, {
    id: CONFIRMATION_ID, deliveryKind: 'film', filmDeliveryId: DELIVERY_ID, fillingDeliveryId: null,
    evidenceDocumentVersionId: VERSION_ID, confirmedByUserId: USER_ID, confirmedAt: '2026-11-18T03:00:00.000Z',
    note: null, projectId: PROJECT_ID, deliveryId: DELIVERY_ID
  }, { operation: 'delivery_confirmation:record', deliveryKind: 'film', deliveryId: DELIVERY_ID }),
  auditRow('commission_readiness', 'COMMISSION_READINESS_EVALUATED', PROJECT_ID, {
    projectId: PROJECT_ID, filmDeliveryRecorded: true, fillingDeliveryRecorded: false,
    sevenPoOfficiallyRegistered: true, filmDeliveryConfirmed: true, fillingDeliveryConfirmed: false,
    readinessState: 'PENDING_VERIFICATION', isReady: false, readyAt: null,
    evaluatedAt: '2026-11-18T03:00:00.000Z', evaluatedByUserId: USER_ID, updatedAt: '2026-11-18T03:00:00.000Z',
    blocking: ['FILLING_DELIVERY_MISSING']
  }, { operation: 'commission_readiness:evaluate' })
];

/** Every record time as an ISO string and as the screen would print it. */
const RECORD_TIMES = ROWS.map((row) => row.occurredAt.toISOString());

function paymentGateCalls(): string[] {
  return callApi.mock.calls.map((call) => String(call[0])).filter((p) => p.includes('/payment-gate'));
}

function serveAs(role: Role) {
  sessionRole.current = role;
  callApi.mockImplementation(async (apiPath: string) => {
    if (apiPath === `/api/projects/${PROJECT_ID}`) {
      return { ok: true, status: 200, error: null, data: { id: PROJECT_ID, code: 'CMP-F1-0009', name: '合成', route: 'F1', status: 'ACTIVE' } };
    }
    if (apiPath === '/api/status-labels') {
      return { ok: true, status: 200, error: null, data: { filmSupplyOrderStates: [], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] } };
    }
    if (apiPath.includes('/audit-history')) {
      const entityType = new URL(apiPath, 'http://x').searchParams.get('entityType');
      const rows = ROWS.filter((row) => row.entityType === entityType);
      const events = JSON.parse(JSON.stringify(buildAuditViewForRole(role, rows)));
      return { ok: true, status: 200, error: null, data: { events } };
    }
    // Gates, maker POs and the rest: an empty refusal keeps the screens on their fallbacks.
    return { ok: false, status: 404, error: 'not served in this test', data: null };
  });
}

async function renderPage(page: () => Promise<unknown>): Promise<string> {
  return renderToString((await page()) as Parameters<typeof renderToString>[0]);
}

beforeEach(() => {
  callApi.mockReset();
});

describe('M2 + M1: セブン発注書 registration is told apart from hidden, per role', () => {
  it('admin: the recorded date and the true 未登録', async () => {
    serveAs('admin');
    const workspace = await loadWorkspace(PROJECT_ID);
    const registered = workspace.sevenPurchaseOrders.find((po) => po.id === PO_REGISTERED)!;
    const unregistered = workspace.sevenPurchaseOrders.find((po) => po.id === PO_UNREGISTERED)!;
    expect(registered).toMatchObject({
      officialRegisteredAt: REGISTERED_AT, officiallyRegistered: true, officialRegistrationHidden: false, poNumberHidden: false
    });
    // UI batch E (F-15, T4): a date-only registration reads as the date alone (no 09:00 nobody entered).
    expect(officialRegistrationText(registered)).toBe('2026/11/16');
    expect(sevenPurchaseOrderChoiceLabel(registered)).toBe('SC-REG-1（公式登録済み）');
    expect(unregistered).toMatchObject({ officialRegisteredAt: null, officiallyRegistered: false, officialRegistrationHidden: false });
    expect(officialRegistrationText(unregistered)).toBe('未登録');
    expect(sevenPurchaseOrderChoiceLabel(unregistered)).toBe('SC-NEW-2（未登録）');
  });

  for (const role of ['staff', 'viewer'] as const) {
    it(`${role}: a hidden date stays hidden (never the record time), registration known from the action`, async () => {
      serveAs(role);
      const workspace = await loadWorkspace(PROJECT_ID);
      const registered = workspace.sevenPurchaseOrders.find((po) => po.id === PO_REGISTERED)!;
      const unregistered = workspace.sevenPurchaseOrders.find((po) => po.id === PO_UNREGISTERED)!;
      expect(registered).toMatchObject({
        officialRegisteredAt: null, officiallyRegistered: true, officialRegistrationHidden: true, poNumberHidden: true
      });
      expect(officialRegistrationText(registered)).toBe('公式登録済み（登録日は閲覧権限なし）');
      expect(sevenPurchaseOrderChoiceLabel(registered)).toBe('発注番号 閲覧権限なし・ID …902de940（公式登録済み）');
      expect(unregistered).toMatchObject({ officialRegisteredAt: null, officiallyRegistered: false, officialRegistrationHidden: true });
      expect(officialRegistrationText(unregistered)).toBe(HIDDEN_BY_ROLE_LABEL);
      expect(sevenPurchaseOrderChoiceLabel(unregistered)).toBe('発注番号 閲覧権限なし・ID …902de941（登録状況 閲覧権限なし）');
      for (const po of workspace.sevenPurchaseOrders) {
        expect(RECORD_TIMES).not.toContain(po.officialRegisteredAt);
        expect(sevenPurchaseOrderChoiceLabel(po)).not.toContain('未登録');
      }
    });
  }
});

describe('M4: deliveries, approvals, document versions and readiness use the same rule', () => {
  it('admin: every recorded value, nothing marked hidden', async () => {
    serveAs('admin');
    const workspace = await loadWorkspace(PROJECT_ID);
    expect(workspace.deliveries[0]).toMatchObject({
      orderId: FILM_ID, deliveredAt: DELIVERED_AT, deliverySequence: 1, deliveredQuantity: '10.000',
      confirmed: true, evidenceDocumentVersionId: VERSION_ID, detailsHidden: false, confirmationHidden: false
    });
    expect(workspace.approvalEvents[0]).toMatchObject({
      organization: 'customer', decision: 'APPROVE', revisionNo: 1, eventTime: APPROVED_AT, detailsHidden: false
    });
    expect(workspace.documents[0]?.versions).toHaveLength(1);
    expect(workspace.documentVersionsWithheld).toBe(false);
    expect(workspace.revisions).toHaveLength(1);
    expect(workspace.revisionsWithheld).toBe(0);
    expect(workspace.readiness).toMatchObject({ readinessState: 'PENDING_VERIFICATION', hidden: false });
  });

  it('staff: the bindings 62d9305 allows are shown; every withheld value is flagged hidden, never a default or record time', async () => {
    serveAs('staff');
    const workspace = await loadWorkspace(PROJECT_ID);
    const [delivery] = workspace.deliveries;
    // filmSupplyOrderId is on the staff allowlist since 62d9305: the order is known, the rest is not.
    expect(delivery).toMatchObject({
      orderId: FILM_ID, deliveredAt: null, deliverySequence: null, confirmed: false,
      detailsHidden: true, confirmationHidden: true
    });
    const [approval] = workspace.approvalEvents;
    expect(approval).toMatchObject({ eventTime: null, revisionNo: null, detailsHidden: true });
    // documentId/versionNumber are visible: the version is listed, its digest is not.
    expect(workspace.documentVersionsWithheld).toBe(false);
    expect(workspace.documents[0]?.versions).toEqual([
      expect.objectContaining({ id: VERSION_ID, versionNumber: 1, sha256: null, sha256Hidden: true })
    ]);
    expect(RECORD_TIMES).not.toContain(workspace.documents[0]?.versions[0]?.sha256);
    // filmSupplyOrderId/designKey are visible: the revision is bound; its number is withheld — never 版1 by default.
    expect(workspace.revisionsWithheld).toBe(0);
    expect(workspace.revisions).toEqual([
      expect.objectContaining({ id: REVISION_ID, filmSupplyOrderId: FILM_ID, designKey: 'label-front', revisionNo: null, revisionNoHidden: true })
    ]);
    expect(revisionNumberText(workspace.revisions[0]!)).toBe('版（閲覧権限なし）');
    expect(workspace.readiness?.hidden).toBe(true);
  });

  it('viewer: withheld values are flagged hidden and never replaced by defaults or record times', async () => {
    serveAs('viewer');
    const workspace = await loadWorkspace(PROJECT_ID);
    const [delivery] = workspace.deliveries;
    expect(delivery).toMatchObject({
      orderId: null, deliveredAt: null, deliverySequence: null, confirmed: false,
      detailsHidden: true, confirmationHidden: true
    });
    const [approval] = workspace.approvalEvents;
    expect(approval).toMatchObject({ eventTime: null, revisionNo: null, detailsHidden: true });
    expect(workspace.documents[0]?.versions).toHaveLength(0);
    expect(workspace.documentVersionsWithheld).toBe(true);
    expect(workspace.revisions).toHaveLength(0);
    expect(workspace.revisionsWithheld).toBe(1);
    expect(workspace.readiness?.hidden).toBe(true);
  });

  it('admin: a recorded revision number and digest are shown as they are', async () => {
    serveAs('admin');
    const workspace = await loadWorkspace(PROJECT_ID);
    expect(revisionNumberText(workspace.revisions[0]!)).toBe('版1');
    expect(workspace.documents[0]?.versions[0]).toMatchObject({ sha256: 'ab'.repeat(32), sha256Hidden: false });
    expect(revisionNumberText({ revisionNo: null, revisionNoHidden: false })).toBe('版未記録');
  });
});

describe('rendered screens per role (display only — the forms and permissions are unchanged)', () => {
  it.each(ROLES)('orders (%s): PO choices never read 「（閲覧権限なし）（未登録）」, the 公式登録 form follows the known registration', async (role) => {
    serveAs(role);
    const html = await renderPage(OrdersPage);
    expect(html).not.toContain('（閲覧権限なし）（未登録）');
    // The form is offered only for the PO not known to be registered (unchanged
    // rule: hidden registration state does not hide the form — see M3). UI batch
    // B: a viewer is offered no write form at all (the API refuses it anyway).
    expect(html.match(/>公式登録日を記録する<\/summary>/g) ?? []).toHaveLength(role === 'viewer' ? 0 : 1);
    if (role === 'admin') {
      expect(html).toContain('SC-NEW-2（未登録）');
      // UI batch E (F-15, T4): the date-only registration shows no invented time.
      expect(html).toContain('>2026/11/16</td>');
      expect(html).not.toContain('2026/11/16 09:00 JST');
    } else {
      expect(html).toContain('公式登録済み（登録日は閲覧権限なし）');
      // UI batch B: the viewer gets no create form, so no PO select to label.
      if (role === 'viewer') {
        expect(html).not.toContain('（登録状況 閲覧権限なし）');
        expect(html).toContain('フィルム発注の作成は、閲覧権限のため操作できません。');
      } else {
        expect(html).toContain('（登録状況 閲覧権限なし）');
      }
      expect(html).not.toContain('SC-REG-1');
    }
  });

  it.each(ROLES)('orders (%s): payment-gate is read only for drafts the role can see (L3)', async (role) => {
    serveAs(role);
    await renderPage(OrdersPage);
    expect(paymentGateCalls()).toEqual(role === 'viewer' ? [] : [`/api/film-supply-orders/${FILM_ID}/payment-gate`]);
  });

  it.each(ROLES)('deliveries (%s): no stand-in date, sequence or 未確認 for hidden values', async (role) => {
    serveAs(role);
    const html = await renderPage(DeliveriesPage);
    if (role === 'admin') {
      expect(html).toContain('2026/11/18 08:00 JST');
      expect(html).toContain('CONFIRMED');
      expect(html).toContain('PENDING_VERIFICATION');
      expect(html).not.toContain(HIDDEN_BY_ROLE_LABEL);
    } else {
      expect(html).toContain(HIDDEN_BY_ROLE_LABEL);
      expect(html).not.toContain('2026/11/18 08:00 JST');
      expect(html).not.toContain('PENDING_CONFIRMATION');
      expect(html).not.toContain('MISSING_DATA');
      // The delivery row's own record time is not printed as its 納品日.
      const deliveryRow = ROWS.find((row) => row.action === 'FILM_DELIVERY_RECORDED')!;
      expect(html).not.toContain(formatTimestamp(deliveryRow.occurredAt.toISOString()));
    }
  });

  it.each(ROLES)('approvals (%s): history rows and the revision notice say 閲覧権限なし instead of 「—」/版0', async (role) => {
    serveAs(role);
    const html = await renderPage(ApprovalsPage);
    expect(html).not.toContain('版0');
    if (role === 'admin') {
      expect(html).toContain('2026/11/17 18:00 JST');
      expect(html).not.toContain('校正ゲラの版は1件記録されていますが');
    } else if (role === 'staff') {
      // 62d9305: the revision's binding is visible to staff, its number is not.
      expect(html.replaceAll('<!-- -->', '')).toContain('デザイン label-front ／ 版（閲覧権限なし）');
      expect(html).not.toContain('校正ゲラの版は1件記録されていますが');
      expect(html).not.toContain('校了対象の版がまだありません');
      expect(html).not.toContain('2026/11/17 18:00 JST');
      expect(html).toContain(HIDDEN_BY_ROLE_LABEL);
      const approvalRow = ROWS.find((row) => row.action === 'ARTWORK_APPROVAL_RECORDED')!;
      expect(html.split(formatTimestamp(approvalRow.occurredAt.toISOString()))).toHaveLength(2);
    } else {
      expect(html).toContain('校正ゲラの版は1件記録されていますが、紐付け先の発注とデザインが閲覧権限なしのため');
      expect(html).not.toContain('校了対象の版がまだありません');
      expect(html).not.toContain('2026/11/17 18:00 JST');
      expect(html).toContain(HIDDEN_BY_ROLE_LABEL);
      // The approval's record time stays in the 記録 column only (once), never as 承認日時.
      const approvalRow = ROWS.find((row) => row.action === 'ARTWORK_APPROVAL_RECORDED')!;
      expect(html.split(formatTimestamp(approvalRow.occurredAt.toISOString()))).toHaveLength(2);
    }
  });

  it.each(ROLES)('documents (%s): version count is never claimed as 0件 when withheld', async (role) => {
    serveAs(role);
    const html = await renderPage(DocumentsPage);
    if (role === 'admin') {
      expect(html).toContain('版（1件）');
    } else if (role === 'staff') {
      // 62d9305: staff sees the version and its number; the digest stays withheld.
      expect(html).toContain('版（1件）');
      expect(html.replaceAll('<!-- -->', '')).toContain('版1／ハッシュ 閲覧権限なし');
      expect(html).not.toContain('—…');
      // The issuer is still withheld — never its real-looking 「不明」 value.
      expect(html).not.toContain('>不明</td>');
    } else {
      expect(html).toContain('版（閲覧権限なし）');
      expect(html).not.toContain('版（0件）');
    }
  });

  it.each(ROLES)('maker-po (%s): the PO select never reads 「（閲覧権限なし）（未登録）」', async (role) => {
    serveAs(role);
    const html = await renderPage(MakerPoPage);
    expect(html).not.toContain('（閲覧権限なし）（未登録）');
    if (role === 'viewer') {
      // UI batch B: the viewer is not offered the create form that holds this select.
      expect(html).not.toContain('…902de940');
      expect(html).toContain('フィルム発注の作成は、閲覧権限のため操作できません。');
    } else {
      expect(html).toContain(role === 'admin' ? 'SC-REG-1（公式登録済み）' : '発注番号 閲覧権限なし・ID …902de940（公式登録済み）');
    }
  });
});

describe('auth route handlers (L1, L5)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function logout(fetchImpl: typeof fetch) {
    globalThis.fetch = fetchImpl;
    const { POST } = await import('../apps/web/src/app/api/auth/logout/route.js');
    return POST(new Request('http://web/api/auth/logout', { method: 'POST', headers: { cookie: 'kanei_mvp_session=abc' } }));
  }

  it('logout: an unreachable API still answers 502 and clears both cookies', async () => {
    const response = await logout((async () => { throw new TypeError('connect ECONNREFUSED'); }) as typeof fetch);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('に接続できません');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toContain('kanei_mvp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect(cookies.some((cookie) => /^kanei_web_display_name=; .*Max-Age=0/.test(cookie))).toBe(true);
  });

  it('logout: an API error clears the session cookie; success relays the API cookie and clears the name', async () => {
    const failed = await logout((async () => new Response('{"error":"x"}', { status: 500 })) as typeof fetch);
    expect(failed.status).toBe(500);
    expect(failed.headers.getSetCookie()).toContain('kanei_mvp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

    const ok = await logout((async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'set-cookie': 'kanei_mvp_session=; Path=/; Max-Age=0' }
    })) as typeof fetch);
    expect(ok.status).toBe(200);
    const cookies = ok.headers.getSetCookie();
    expect(cookies).toContain('kanei_mvp_session=; Path=/; Max-Age=0');
    expect(cookies.filter((cookie) => cookie.startsWith('kanei_mvp_session='))).toHaveLength(1);
    expect(cookies.some((cookie) => /^kanei_web_display_name=; .*Max-Age=0/.test(cookie))).toBe(true);
  });

  async function login(fetchImpl: typeof fetch) {
    globalThis.fetch = fetchImpl;
    const { POST } = await import('../apps/web/src/app/api/auth/login/route.js');
    return POST(new Request('http://web/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'staff_composite', password: 'not-a-real-secret' })
    }));
  }

  it('login: success relays the session cookie and remembers the name; refusal and 502 set no name cookie', async () => {
    const ok = await login((async () => new Response(JSON.stringify({ id: USER_ID, role: 'staff' }), {
      status: 200,
      headers: { 'set-cookie': 'kanei_mvp_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600' }
    })) as typeof fetch);
    expect(ok.status).toBe(200);
    const cookies = ok.headers.getSetCookie();
    expect(cookies[0]).toBe('kanei_mvp_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600');
    expect(cookies).toHaveLength(2);
    expect(cookies[1]).toMatch(/^kanei_web_display_name=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600$/);

    const refused = await login((async () => new Response('{"error":"認証に失敗しました"}', { status: 401 })) as typeof fetch);
    expect(refused.status).toBe(401);
    expect(refused.headers.getSetCookie()).toEqual([]);

    const unreachable = await login((async () => { throw new TypeError('connect ECONNREFUSED'); }) as typeof fetch);
    expect(unreachable.status).toBe(502);
    expect(unreachable.headers.getSetCookie()).toEqual([]);
  });
});

describe('review of f81a5e5: distinct PO labels and the surviving mutants', () => {
  it('two hidden POs made in the same ~65 s (same uuidv7 time prefix) get different labels', () => {
    // Same first 13 characters (the 48-bit millisecond time and version nibble),
    // as uuidv7 ids made a few seconds apart have; only the random tail differs.
    const base = {
      poNumber: '', poNumberHidden: true, officialRegisteredAt: null, officiallyRegistered: false,
      verificationStatus: null, reviewPending: false, officialRegistrationHidden: true, verificationHidden: true
    };
    const first = { ...base, id: '01a1ec53-af67-75da-a932-e03a11111111' };
    const second = { ...base, id: '01a1ec53-af67-7f00-8c11-5b9d22222222' };
    expect(first.id.slice(0, 8)).toBe(second.id.slice(0, 8));
    const firstLabel = sevenPurchaseOrderChoiceLabel(first);
    const secondLabel = sevenPurchaseOrderChoiceLabel(second);
    expect(firstLabel).not.toBe(secondLabel);
    expect(firstLabel).toBe('発注番号 閲覧権限なし・ID …11111111（登録状況 閲覧権限なし）');
    expect(secondLabel).toBe('発注番号 閲覧権限なし・ID …22222222（登録状況 閲覧権限なし）');
  });

  it.each(ROLES)('deliveries (%s): the 数量・回次・納品日 cells read 閲覧権限なし when withheld, never 未記録 or 「—」', async (role) => {
    serveAs(role);
    const html = await renderPage(DeliveriesPage);
    const rowStart = html.lastIndexOf('<tr', html.indexOf(DELIVERY_ID));
    const row = html.slice(rowStart, html.indexOf('</tr>', rowStart));
    const cells = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((match) => match[1]);
    // Columns: 種別, 発注, 数量, 回次, 納品日, …
    const [quantity, sequenceCell, deliveredAt] = cells.slice(2, 5);
    if (role === 'admin') {
      expect([quantity, sequenceCell, deliveredAt]).toEqual(['10.000 rolls', '1', '2026/11/18 08:00 JST']);
    } else {
      expect([quantity, sequenceCell, deliveredAt]).toEqual([HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_LABEL]);
      expect(row).not.toContain('未記録');
    }
  });

  it.each(ROLES)('orders (%s): the filling note says 準備状態: 閲覧権限なし when readiness is withheld, never a default state', async (role) => {
    serveAs(role);
    const html = await renderPage(OrdersPage);
    const note = /（準備状態: (.*?)）/.exec(html.replaceAll('<!-- -->', ''))?.[1];
    expect(note).toBe(role === 'admin' ? 'PENDING_VERIFICATION' : HIDDEN_BY_ROLE_SHORT);
    expect(note).not.toBe('MISSING_DATA');
  });
});

describe('source guard kept from batch A', () => {
  it('the 公式登録 form gate reads the known registration, not the hidden flag', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const orders = readFileSync(path.join(repoRoot, 'apps/web/src/app/orders/page.tsx'), 'utf8');
    // Behaviour is pinned by the rendered tests above; this only guards against
    // re-introducing the hidden flag as a form gate (it would drop the staff form).
    expect(orders).not.toMatch(/officialRegistrationHidden\s*\?\s*null/);
  });
});
