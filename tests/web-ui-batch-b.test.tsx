import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canPerform,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  FILM_SUPPLY_ORDER_STATUS_LABELS,
  filmSupplyOrderTransitions,
  japaneseStatusSurface,
  makerChainTransitionRefusal,
  transitionFilmSupplyOrder
} from '@kanei/core';
import type { FilmSupplyOrderState, Operation } from '@kanei/core';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';
import { buildMakerPoViewForRole } from '../apps/api/src/maker-po-view.js';
import type { MakerPoRecord } from '../apps/api/src/maker-po-view.js';
import { projectScreen } from './helpers/project-screen.js';

/**
 * UI batch B (flow visibility): the progress stepper and 「次にやること」, the
 * narrowed transition choices, role-gated forms, ids folded under 「詳細」 and
 * the short id. Pure helpers are checked against the core rules they mirror;
 * the five screens are rendered per role from audit rows the API's own
 * buildAuditViewForRole shaped (the same pattern as web-ui-batch-a-followup).
 * Everything here is display: the API keeps deciding every request.
 */
const callApi = vi.hoisted(() => vi.fn());
/** null: GET /api/me did not answer (loadSessionUser → null). */
const sessionRole = vi.hoisted(() => ({ current: 'admin' as 'admin' | 'staff' | 'viewer' | null }));
const selectedProject = vi.hoisted(() => ({ current: '01a1ec52-a795-7bdb-bc42-fd346d93d333' as string | null }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: (...args: unknown[]) => callApi(...args),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => selectedProject.current,
  loadSessionUser: async () => (sessionRole.current === null
    ? null
    : { id: USER_ID, role: sessionRole.current, displayName: '合成' }),
  // P0 R04/R08: the project selection reads the session told apart. The "role unreadable" case
  // (loadSessionUser → null, the screen still drawn) keeps a user session here so the screen is
  // drawn as before; the real layout draws the notice instead for a session that is not a user
  // (covered in web-p0-session-outage.test.tsx).
  loadSession: async () => ({ kind: 'user', user: { id: USER_ID, role: sessionRole.current ?? 'staff', displayName: '合成' } })
}));

const {
  groupOrdersForProgress,
  knownStatus,
  loadWorkspace,
  nextActionForOrder,
  nextActionWithoutOrders,
  NO_PROJECT_SELECTED_MESSAGE,
  orderProgress,
  PROGRESS_STEPS,
  RELOGIN_HINT,
  RESELECT_PROJECT_HINT,
  STATUS_HIDDEN_NOTICE,
  sevenPurchaseOrderChoiceLabel,
  STATUS_PROGRESS_STEP
} = await import('../apps/web/src/lib/project-data.js');
const {
  transitionChoicesFor,
  CANCELLATION_REVIEW_NOTICE,
  EXCEPTION_GROUP_LABEL,
  HOLD_RELEASE_NOTICE,
  RESUME_GROUP_LABEL,
  SKIP_AHEAD_GROUP_LABEL
} = await import('../apps/web/src/lib/transitions.js');
const { canRoleOperate, operationRefusal, ROLE_UNKNOWN_PAGE_NOTICE, VIEWER_PAGE_NOTICE } = await import(
  '../apps/web/src/lib/permissions.js'
);
const { ProjectPicker } = await import('../apps/web/src/components/ProjectPicker.js');
const { createProjectPickerIntent, MAIN_REGION_ID, POINTER_PICK_WINDOW_MS } = await import(
  '../apps/web/src/lib/project-picker-intent.js'
);
const { shortId } = await import('../apps/web/src/lib/short-id.js');
const { STANDARD_LABELS } = await import('../apps/web/src/lib/terms.js');
const { toMakerPoChoices } = await import('../apps/web/src/lib/document-maker-po.js');
const OrdersPage = projectScreen((await import('../apps/web/src/screens/OrdersScreen.js')).OrdersScreen);
const DocumentsPage = projectScreen((await import('../apps/web/src/screens/DocumentsScreen.js')).DocumentsScreen);
const ApprovalsPage = projectScreen((await import('../apps/web/src/screens/ApprovalsScreen.js')).ApprovalsScreen);
const MakerPoPage = projectScreen((await import('../apps/web/src/screens/MakerPoScreen.js')).MakerPoScreen);
const DeliveriesPage = projectScreen((await import('../apps/web/src/screens/DeliveriesScreen.js')).DeliveriesScreen);

type Role = 'admin' | 'staff' | 'viewer';
const ROLES: Role[] = ['admin', 'staff', 'viewer'];
const ALL_STATES = [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES] as FilmSupplyOrderState[];
// R28: screens say the standard wording (lib/terms) first, then the API label.
const label = (key: string) => STANDARD_LABELS.filmSupplyOrderStates[key]?.ja ?? (FILM_SUPPLY_ORDER_STATUS_LABELS as Record<string, string>)[key] ?? key;

const PROJECT_ID = '01a1ec52-a795-7bdb-bc42-fd346d93d333';
const USER_ID = '01a1ec52-a730-7596-aff1-4072d76c1cf8';
const PO_ID = '01a1ec60-0000-7000-8000-00000000aa01';
const ORDER_READY = '01a1ec60-0000-7000-8000-00000000bb01';
const ORDER_SEND = '01a1ec60-0000-7000-8000-00000000bb02';
const ORDER_DONE = '01a1ec60-0000-7000-8000-00000000bb03';
const ORDER_HOLD = '01a1ec60-0000-7000-8000-00000000bb04';
const ORDER_DRAFT = '01a1ec60-0000-7000-8000-00000000bb05';
const ORDER_DELIVERED = '01a1ec60-0000-7000-8000-00000000bb06';
const MAKER_PO_SEND = '01a1ec60-0000-7000-8000-00000000cc01';
const REVISION_ID = '01a1ec60-0000-7000-8000-00000000dd01';
const APPROVAL_DOC = '01a1ec60-0000-7000-8000-00000000ee01';
const APPROVAL_VERSION = '01a1ec60-0000-7000-8000-00000000ee02';
const ACCEPT_DOC = '01a1ec60-0000-7000-8000-00000000ee03';
const ACCEPT_VERSION = '01a1ec60-0000-7000-8000-00000000ee04';
const DELIVERY_ID = '01a1ec60-0000-7000-8000-00000000ff01';
const PENDING_APPROVAL_EVENT = '01a1ec60-0000-7000-8000-00000000ff02';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let sequence = 0;
function auditRow(
  entityType: string,
  action: string,
  entityId: string,
  afterState: Record<string, unknown>,
  beforeState: Record<string, unknown> | null = null,
  requestMetadata: Record<string, unknown> = { operation: action.toLowerCase() }
): AuditHistoryRow {
  sequence += 1;
  return {
    id: `01a1ec61-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    action,
    entityType,
    entityId,
    beforeState,
    afterState,
    occurredAt: new Date(Date.UTC(2026, 10, 18, 3, 0, sequence)),
    requestMetadata,
    actor: { id: USER_ID, displayName: '合成代表者', role: 'admin' }
  };
}

function filmOrder(id: string, code: string, path: string[]): AuditHistoryRow[] {
  const rows = [auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', id, {
    id, code, status: 'DRAFT', lineCount: 1, projectId: PROJECT_ID, paymentTerms: 'prepaid',
    sevenPurchaseOrderId: PO_ID, createdByUserId: USER_ID
  })];
  let from = 'DRAFT';
  for (const to of path) {
    rows.push(auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_TRANSITIONED', id, { status: to }, { status: from }));
    from = to;
  }
  return rows;
}

const ROWS: AuditHistoryRow[] = [
  auditRow('seven_purchase_order', 'SEVEN_PO_CREATED', PO_ID, {
    id: PO_ID, projectId: PROJECT_ID, poNumber: 'SC-B-1', officialRegisteredAt: '2026-11-16T00:00:00.000Z',
    verificationStatus: 'unverified'
  }),
  auditRow('seven_purchase_order', 'SEVEN_PO_VERIFICATION_RECORDED', PO_ID, {
    id: PO_ID, verificationStatus: 'verified', reviewPending: false
  }),
  ...filmOrder(ORDER_READY, 'FSO-READY', ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY']),
  ...filmOrder(ORDER_SEND, 'FSO-SEND', ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY', 'APPROVED_FOR_MANUAL_SEND']),
  ...filmOrder(ORDER_DONE, 'FSO-DONE', ['SEVEN_PO_VERIFIED', 'FILM_SHIPPED', 'FILM_DELIVERED']),
  auditRow('film_supply_order', 'FILM_RECEIPT_ASSUMPTION_RECORDED', ORDER_DONE, {
    status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', receiptAssumedAt: '2026-11-18T02:00:00.000Z',
    receiptAssumedNote: '問題なし', evidenceFreeAcknowledgment: true
  }, { status: 'FILM_DELIVERED', receiptAssumedAt: null }),
  ...filmOrder(ORDER_HOLD, 'FSO-HOLD', ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'ON_HOLD']),
  ...filmOrder(ORDER_DRAFT, 'FSO-DRAFT', []),
  ...filmOrder(ORDER_DELIVERED, 'FSO-DELIV', ['SEVEN_PO_VERIFIED', 'FILM_SHIPPED', 'FILM_DELIVERED']),
  auditRow('document', 'DOCUMENT_CREATED', APPROVAL_DOC, {
    id: APPROVAL_DOC, projectId: PROJECT_ID, documentType: 'approval_evidence', issuerEntity: 'customer_generated',
    originalFilename: 'approval.eml', note: null, verificationStatus: 'verified', verificationNote: null,
    sevenPurchaseOrderId: null, filmSupplyOrderId: ORDER_HOLD, designKey: 'label-front'
  }),
  auditRow('document_version', 'DOCUMENT_VERSION_UPLOADED', APPROVAL_VERSION, {
    id: APPROVAL_VERSION, documentId: APPROVAL_DOC, versionNumber: 1, sha256: 'cd'.repeat(32), originalFilename: 'approval.eml'
  }, null, { operation: 'document:create', documentId: APPROVAL_DOC }),
  auditRow('document', 'DOCUMENT_CREATED', ACCEPT_DOC, {
    id: ACCEPT_DOC, projectId: PROJECT_ID, documentType: 'acceptance_evidence', issuerEntity: 'maker',
    originalFilename: 'accept.pdf', note: null, verificationStatus: 'verified', verificationNote: null,
    sevenPurchaseOrderId: null, filmSupplyOrderId: ORDER_DONE, designKey: null
  }),
  auditRow('document_version', 'DOCUMENT_VERSION_UPLOADED', ACCEPT_VERSION, {
    id: ACCEPT_VERSION, documentId: ACCEPT_DOC, versionNumber: 1, sha256: 'ef'.repeat(32), originalFilename: 'accept.pdf'
  }, null, { operation: 'document:create', documentId: ACCEPT_DOC }),
  auditRow('artwork_revision', 'ARTWORK_REVISION_REGISTERED', REVISION_ID, {
    id: REVISION_ID, filmSupplyOrderId: ORDER_HOLD, designKey: 'label-front', revisionNo: 1,
    fileDocumentVersionId: APPROVAL_VERSION, note: null, invalidatedApprovals: false
  }, null, { operation: 'artwork_revision:create', filmSupplyOrderId: ORDER_HOLD }),
  auditRow('film_delivery', 'FILM_DELIVERY_RECORDED', DELIVERY_ID, {
    id: DELIVERY_ID, filmSupplyOrderId: ORDER_DONE, filmSupplyOrderLineId: null, unit: 'rolls',
    deliveredQuantity: '5.000', deliverySequence: 1, deliveredAt: '2026-11-17T23:00:00.000Z', note: null
  }, null, { operation: 'film_delivery:create', filmSupplyOrderId: ORDER_DONE }),
  auditRow('maker_purchase_order', 'MAKER_PO_CREATED', MAKER_PO_SEND, {
    id: MAKER_PO_SEND, filmSupplyOrderId: ORDER_SEND, status: 'DRAFT'
  })
];

const MAKER_PO_ROW = {
  id: MAKER_PO_SEND, filmSupplyOrderId: ORDER_SEND, status: 'APPROVED_FOR_MANUAL_SEND', orderCode: 'FSO-SEND',
  recipientAddress: 'maker@example.test', ceoApprovedAt: '2026-11-18T01:00:00.000Z',
  createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T01:00:00.000Z'
};

function approvalGate(role: Role) {
  return {
    orderId: ORDER_HOLD,
    orderStatus: 'ON_HOLD',
    dualApproved: false,
    missingApprovals: [{ designKey: 'label-front', organization: 'seven' }],
    designs: [{
      designKey: 'label-front', currentRevisionId: REVISION_ID, currentRevisionNo: 1, fileSha256: 'cd'.repeat(32),
      dualApproved: false, customer: { valid: false, pendingEvidenceIdentifier: true }, seven: { valid: false }
    }],
    // The API answers this list to the representative only.
    pendingManualVerifications: role === 'admin'
      ? [{
        approvalEventId: PENDING_APPROVAL_EVENT, revisionId: REVISION_ID, designKey: 'label-front', revisionNo: 1,
        organization: 'customer', evidenceDocumentVersionId: APPROVAL_VERSION, evidenceIdentifier: '<a@example.test>',
        approvedFileSha256: 'cd'.repeat(32), eventTime: '2026-11-17T09:00:00.000Z', recordedAt: '2026-11-18T03:00:00.000Z',
        manualVerification: null
      }]
      : []
  };
}

/**
 * `role` is the session; `viewRole` shapes the API answers (default: the same
 * role). They differ only to check a screen rule on data the role cannot read
 * through the real API, and for a session whose role could not be read (null).
 */
function serveAs(role: Role | null, rows: AuditHistoryRow[] = ROWS, viewRole: Role = role ?? 'viewer') {
  sessionRole.current = role;
  callApi.mockImplementation(async (apiPath: string) => {
    const ok = (data: unknown) => ({ ok: true, status: 200, error: null, data });
    if (apiPath === `/api/projects/${PROJECT_ID}`) {
      return ok({ id: PROJECT_ID, code: 'CMP-F1-B', name: '合成B', route: 'F1', status: 'ACTIVE' });
    }
    if (apiPath === '/api/status-labels') return ok(japaneseStatusSurface());
    if (apiPath.includes('/audit-history')) {
      const entityType = new URL(apiPath, 'http://x').searchParams.get('entityType');
      const selected = rows.filter((row) => row.entityType === entityType);
      return ok({ events: JSON.parse(JSON.stringify(buildAuditViewForRole(viewRole, selected))) });
    }
    if (apiPath.endsWith('/payment-gate')) {
      return ok({ orderId: 'x', orderStatus: 'x', paymentTerms: 'prepaid', gate: { satisfied: true, code: null, reason: null }, paymentConfirmedAt: null });
    }
    if (apiPath === `/api/film-supply-orders/${ORDER_SEND}/maker-purchase-orders`) return ok({ makerPurchaseOrders: [MAKER_PO_ROW] });
    if (apiPath.endsWith('/maker-purchase-orders')) return ok({ makerPurchaseOrders: [] });
    if (apiPath === `/api/maker-purchase-orders/${MAKER_PO_SEND}`) return ok({ purchaseOrder: MAKER_PO_ROW, events: [] });
    if (apiPath === `/api/film-supply-orders/${ORDER_HOLD}/approval-gate`) return ok(approvalGate(viewRole));
    return { ok: false, status: 404, error: 'not served in this test', data: null };
  });
}

/**
 * The maker-PO screen renders async server components (the per-paper blocks
 * read their event trail), so the page is prerendered (every async part settled).
 */
async function renderPage(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

/** The page text outside every <details> (innermost first), tags removed. */
function textOutsideDetails(html: string): string {
  let rest = html;
  const innermost = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/;
  while (innermost.test(rest)) rest = rest.replace(innermost, '');
  return rest.replace(/<[^>]*>/g, ' ');
}

const PAGES = {
  orders: OrdersPage,
  documents: DocumentsPage,
  approvals: ApprovalsPage,
  'maker-po': MakerPoPage,
  deliveries: DeliveriesPage
} as const;
const PAGE_NAMES = Object.keys(PAGES) as Array<keyof typeof PAGES>;

beforeEach(() => {
  callApi.mockReset();
});

// ---------------------------------------------------------------------------
// ① progress: the state → step table and the marks
// ---------------------------------------------------------------------------

describe('① progress stepper: the state → current step table', () => {
  // Written out independently of the implementation: 0-based step per state.
  const EXPECTED: Record<FilmSupplyOrderState, number | null> = {
    DRAFT: 0, SEVEN_PO_VERIFIED: 1, ARTWORK_RECEIVED: 2, PROOF_READY: 2, APPROVAL_PENDING: 2,
    DUAL_APPROVED: 3, MAKER_PO_READY: 3, APPROVED_FOR_MANUAL_SEND: 4, MAKER_PO_SENT_MANUALLY: 5,
    MAKER_PO_ACCEPTED: 6, FILM_IN_PRODUCTION: 6, FILM_SHIPPED: 6, FILM_DELIVERED: 7,
    FILM_RECEIPT_ASSUMED_NO_ISSUE: 8, ON_HOLD: null, CHANGE_REVIEW: null, CANCELLATION_REVIEW: null
  };

  it('names exactly the 17 core states, eight steps in business order', () => {
    expect(ALL_STATES).toHaveLength(17);
    expect(Object.keys(STATUS_PROGRESS_STEP).sort()).toEqual([...ALL_STATES].sort());
    expect(STATUS_PROGRESS_STEP).toEqual(EXPECTED);
    expect(PROGRESS_STEPS).toEqual([
      '発注書確認', 'デザイン受領', '校正・校了', '発注書・代表承認', 'メーカーへ送信', '受入確認', '生産・出荷', '納品・受領'
    ]);
  });

  it.each(ALL_STATES.filter((state) => typeof EXPECTED[state] === 'number' && EXPECTED[state]! < 8))(
    '%s: earlier steps 済, its step いま, later steps upcoming',
    (state) => {
      const step = EXPECTED[state]!;
      const progress = orderProgress({ status: state, statusHidden: false, lastNormalStatus: state });
      expect(progress).toMatchObject({ phase: 'active', currentStep: step, interruptedStep: null });
      expect(progress.marks.filter((mark) => mark === 'current')).toHaveLength(1);
      expect(progress.marks.slice(0, step).every((mark) => mark === 'done')).toBe(true);
      expect(progress.marks.slice(step + 1).every((mark) => mark === 'upcoming')).toBe(true);
    }
  );

  it('the receipt-assumed terminal state has every step 済 and no current step', () => {
    const progress = orderProgress({ status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', statusHidden: false, lastNormalStatus: 'FILM_RECEIPT_ASSUMED_NO_ISSUE' });
    expect(progress.phase).toBe('complete');
    expect(progress.marks).toEqual(Array(8).fill('done'));
  });

  it.each(FILM_SUPPLY_ORDER_EXCEPTION_STATES)('%s: the interrupted step comes from lastNormalStatus, none without it', (state) => {
    const interrupted = orderProgress({ status: state, statusHidden: false, lastNormalStatus: 'MAKER_PO_SENT_MANUALLY' });
    expect(interrupted).toMatchObject({ phase: 'exception', currentStep: null, interruptedStep: 5 });
    expect(interrupted.marks).toEqual(['done', 'done', 'done', 'done', 'done', 'interrupted', 'upcoming', 'upcoming']);

    const unknown = orderProgress({ status: state, statusHidden: false, lastNormalStatus: null });
    expect(unknown).toMatchObject({ phase: 'exception', currentStep: null, interruptedStep: null });
    expect(unknown.marks).not.toContain('current');
    expect(unknown.marks).not.toContain('interrupted');
  });

  it('a withheld status is never its DRAFT placeholder: no marks, no step, knownStatus null', () => {
    const hidden = { status: 'DRAFT', statusHidden: true, lastNormalStatus: null };
    expect(knownStatus(hidden)).toBeNull();
    const progress = orderProgress(hidden);
    expect(progress).toMatchObject({ phase: 'hidden', status: null, currentStep: null });
    expect(progress.marks).toEqual(Array(8).fill('unmarked'));
    expect(knownStatus({ status: 'DRAFT', statusHidden: false })).toBe('DRAFT');
  });

  it('a status outside the table claims no step', () => {
    expect(orderProgress({ status: 'SOMETHING_NEW', statusHidden: false, lastNormalStatus: null })).toMatchObject({
      phase: 'unknown', currentStep: null, marks: Array(8).fill('unmarked')
    });
  });
});

describe('① replay: lastNormalStatus and the receipt assumption', () => {
  it.each(['admin', 'staff'] as const)('%s: an order on hold remembers the state it left; the receipt assumption completes', async (role) => {
    serveAs(role);
    const workspace = await loadWorkspace(PROJECT_ID);
    const byId = new Map(workspace.filmOrders.map((order) => [order.id, order]));
    expect(byId.get(ORDER_HOLD)).toMatchObject({ status: 'ON_HOLD', statusHidden: false, lastNormalStatus: 'APPROVAL_PENDING' });
    expect(byId.get(ORDER_DONE)).toMatchObject({ status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', lastNormalStatus: 'FILM_RECEIPT_ASSUMED_NO_ISSUE' });
    expect(byId.get(ORDER_READY)).toMatchObject({ status: 'MAKER_PO_READY', lastNormalStatus: 'MAKER_PO_READY' });
    const groups = groupOrdersForProgress(workspace.filmOrders);
    expect(groups.completed.map((order) => order.id)).toEqual([ORDER_DONE]);
    expect(groups.active.map((order) => order.id).sort()).toEqual([ORDER_READY, ORDER_SEND, ORDER_HOLD, ORDER_DRAFT, ORDER_DELIVERED].sort());
    expect(groups.hidden).toEqual([]);
  });

  it('viewer (server batch E): the statuses read like staff, the progress groups the same way', async () => {
    serveAs('viewer');
    const viewer = await loadWorkspace(PROJECT_ID);
    serveAs('staff');
    const staff = await loadWorkspace(PROJECT_ID);
    const staffById = new Map(staff.filmOrders.map((order) => [order.id, order]));
    for (const order of viewer.filmOrders) {
      expect(order.statusHidden).toBe(false);
      expect(order.status).toBe(staffById.get(order.id)?.status);
      expect(order.lastNormalStatus).toBe(staffById.get(order.id)?.lastNormalStatus);
      // The order's details (lines, PO link) stay withheld from the viewer.
      expect(order.detailsHidden).toBe(true);
    }
    const groups = groupOrdersForProgress(viewer.filmOrders);
    expect(groups.hidden).toEqual([]);
    expect(groups.completed.map((order) => order.id)).toEqual([ORDER_DONE]);
  });

  /**
   * Review mutant M08. The API writes every maker-chain move of the film order
   * as FILM_SUPPLY_ORDER_TRANSITIONED on the order itself (operation
   * maker_po:ceo_approve / send_evidence / verify_send / accept_evidence /
   * cancel, apps/api/src/app.ts), each with beforeState/afterState. On such a
   * complete trail the remembered state already equals the hold's beforeState.
   * The hold's beforeState is the stronger source: when the trail misses a
   * status write (a row written outside the audited endpoints, e.g. a restored
   * or repaired database), the remembered state is stale and the hold event
   * still names where the order really was.
   */
  describe('lastNormalStatus of a hold comes from the hold event itself (M08)', () => {
    const ORDER_GAP = '01a1ec60-0000-7000-8000-00000000bb07';
    const HEAD = ROWS.filter((row) => row.entityType === 'seven_purchase_order');
    const created = (id: string, code: string) => auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', id, {
      id, code, status: 'DRAFT', lineCount: 1, projectId: PROJECT_ID, paymentTerms: 'prepaid',
      sevenPurchaseOrderId: PO_ID, createdByUserId: USER_ID
    }, null, { operation: 'film_order:create' });
    const moved = (id: string, from: string, to: string, requestMetadata: Record<string, unknown>) =>
      auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_TRANSITIONED', id, { status: to }, { status: from }, requestMetadata);
    const UP_TO_READY = ['DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY'];
    const toReady = (id: string) => UP_TO_READY.slice(1).map((to, index) =>
      moved(id, UP_TO_READY[index]!, to, { operation: 'film_order:transition' }));
    const ceoApprove = (id: string) => moved(id, 'MAKER_PO_READY', 'APPROVED_FOR_MANUAL_SEND',
      { operation: 'maker_po:ceo_approve', reason: 'maker_po_approved' });
    const hold = (id: string, from: string) => moved(id, from, 'ON_HOLD', { operation: 'film_order:transition' });

    it.each(['admin', 'staff'] as const)('%s: a complete trail (the API\'s maker-chain row) remembers the maker-chain state', async (role) => {
      serveAs(role, [...HEAD, created(ORDER_GAP, 'FSO-GAP'), ...toReady(ORDER_GAP), ceoApprove(ORDER_GAP), hold(ORDER_GAP, 'APPROVED_FOR_MANUAL_SEND')]);
      const [order] = (await loadWorkspace(PROJECT_ID)).filmOrders;
      expect(order).toMatchObject({ id: ORDER_GAP, status: 'ON_HOLD', lastNormalStatus: 'APPROVED_FOR_MANUAL_SEND' });
    });

    it.each(['admin', 'staff'] as const)('%s: a stale remembered state loses to the hold event\'s beforeState', async (role) => {
      // The maker-chain row is missing: replay alone would remember MAKER_PO_READY.
      serveAs(role, [...HEAD, created(ORDER_GAP, 'FSO-GAP'), ...toReady(ORDER_GAP), hold(ORDER_GAP, 'APPROVED_FOR_MANUAL_SEND')]);
      const workspace = await loadWorkspace(PROJECT_ID);
      const [order] = workspace.filmOrders;
      expect(order).toMatchObject({ id: ORDER_GAP, status: 'ON_HOLD', lastNormalStatus: 'APPROVED_FOR_MANUAL_SEND' });
      // UI batch D: a hold is left only through the representative's release,
      // which resumes the remembered state on the server — the generic select
      // offers nothing (the API refuses every target without the origin).
      expect(nextActionForOrder(order!, workspace, role)).toMatchObject({
        operation: 'film_order:release_hold', owner: '代表者', screens: ['/orders']
      });
      expect(transitionChoicesFor('ON_HOLD', label, order!.lastNormalStatus)).toMatchObject({
        choices: [], emptyReason: HOLD_RELEASE_NOTICE, resumeNotice: null
      });
    });

    it('viewer (server batch E): the hold and the state it left read; the hold reason stays withheld', async () => {
      const rows = [...HEAD, created(ORDER_GAP, 'FSO-GAP'), ...toReady(ORDER_GAP), hold(ORDER_GAP, 'APPROVED_FOR_MANUAL_SEND')];
      serveAs('staff', rows);
      const [staffOrder] = (await loadWorkspace(PROJECT_ID)).filmOrders;
      serveAs('viewer', rows);
      const [order] = (await loadWorkspace(PROJECT_ID)).filmOrders;
      expect(order).toMatchObject({ statusHidden: false, status: 'ON_HOLD', lastNormalStatus: staffOrder!.lastNormalStatus });
      expect(order!.hold?.reasonHidden ?? true).toBe(true);
      expect(order!.hold?.reason ?? null).toBeNull();
    });

    it('orders (staff): 次にやること for that hold links no maker PO screen (B-M1); the release is the representative\'s', async () => {
      serveAs('staff', [...HEAD, created(ORDER_GAP, 'FSO-GAP'), ...toReady(ORDER_GAP), hold(ORDER_GAP, 'APPROVED_FOR_MANUAL_SEND')]);
      const html = await renderPage(OrdersPage);
      expect(html).toContain('代表者が理由を記録して保留を解除する（原則として保留にする前の状態に戻ります。保留中にその段階のメーカー発注書が取り消され、残っている発注書がない場合は「メーカー発注準備完了」に戻ります）。');
      expect(html).toContain('保留の解除は代表者が行います。');
      const links = [...html.matchAll(/<p class="next-links">([\s\S]*?)<\/p>/g)].map((match) => match[1]!);
      expect(links.length).toBeGreaterThan(0);
      for (const inner of links) expect(inner).not.toContain('href="/maker-po"');
      // No generic select for the held order: nothing to skip with (B-M2 holds trivially).
      expect([...html.matchAll(/<select[^>]*name="to"[^>]*>/g)]).toHaveLength(0);
      expect(html).not.toContain('value="FILM_IN_PRODUCTION"');
    });
  });

  it('a refused remembered project keeps the API wording and says to pick again; an outage does not', async () => {
    callApi.mockImplementation(async (apiPath: string) => apiPath === `/api/projects/${PROJECT_ID}`
      ? { ok: false, status: 404, error: '案件が見つかりません', data: null }
      : { ok: true, status: 200, error: null, data: { events: [] } });
    expect((await loadWorkspace(PROJECT_ID)).error).toBe(`案件が見つかりません ${RESELECT_PROJECT_HINT}`);

    // L4: a lost session asks for a new login, not for another project.
    callApi.mockImplementation(async (apiPath: string) => apiPath === `/api/projects/${PROJECT_ID}`
      ? { ok: false, status: 401, error: '認証が必要です', data: null }
      : { ok: true, status: 200, error: null, data: { events: [] } });
    expect((await loadWorkspace(PROJECT_ID)).error).toBe(`認証が必要です ${RELOGIN_HINT}`);

    callApi.mockImplementation(async () => ({ ok: false, status: 0, error: 'API（x）に接続できません。', data: null }));
    expect((await loadWorkspace(PROJECT_ID)).error).toBe('API（x）に接続できません。');
  });
});

// ---------------------------------------------------------------------------
// ① 次にやること per state and role
// ---------------------------------------------------------------------------

describe('① 次にやること: the step, the owner and the reason a role cannot do it', () => {
  const labels = japaneseStatusSurface();
  const po = {
    id: PO_ID, poNumber: 'SC-B-1', poNumberHidden: false, officialRegisteredAt: '2026-11-16T00:00:00.000Z',
    officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false,
    officialRegistrationHidden: false, verificationHidden: false
  };
  const order = (status: string, extra: Record<string, unknown> = {}) => ({
    id: ORDER_READY, code: 'FSO-X', status, sevenPurchaseOrderId: PO_ID, lineCount: 1, lines: [],
    detailsHidden: false, statusHidden: false, lastNormalStatus: null, createdAt: '', updatedAt: '', ...extra
  });
  const workspace = (sevenPurchaseOrders = [po], revisionsWithheld = 0) => ({ labels, sevenPurchaseOrders, revisions: [], revisionsWithheld });

  it.each([
    ['admin', null],
    ['staff', null],
    ['viewer', '閲覧権限のため操作できません。']
  ] as const)('MAKER_PO_READY (%s): P-6 — staff (or the representative) draft the maker PO; the representative approves it', (role, refusal) => {
    const action = nextActionForOrder(order('MAKER_PO_READY'), workspace(), role);
    expect(action).toMatchObject({ owner: '担当者・代表者', screens: ['/maker-po'], operation: 'maker_po:create', refusal });
    expect(action.text).toBe('メーカー発注書（下書き）を作成する。作成後に代表が承認します。');
  });

  it.each([
    ['admin', null],
    ['staff', null],
    ['viewer', '閲覧権限のため操作できません。']
  ] as const)('APPROVED_FOR_MANUAL_SEND (%s): staff and the representative record the send', (role, refusal) => {
    expect(nextActionForOrder(order('APPROVED_FOR_MANUAL_SEND'), workspace(), role)).toMatchObject({
      owner: '担当者・代表者', screens: ['/maker-po'], operation: 'maker_po:send_evidence', refusal
    });
  });

  it('DRAFT: names what the workspace shows is missing, then the transition', () => {
    const unregistered = { ...po, officiallyRegistered: false, officialRegisteredAt: null };
    expect(nextActionForOrder(order('DRAFT'), workspace([unregistered]), 'admin')).toMatchObject({
      text: 'セブン化学発注書（SC-B-1）の本登録日を記録する。', operation: 'seven_po:register', screens: ['/orders']
    });
    const unverified = { ...po, verificationStatus: null };
    expect(nextActionForOrder(order('DRAFT'), workspace([unverified]), 'admin')).toMatchObject({
      text: 'セブン化学発注書（SC-B-1）の発注書の照合チェックを記録し、確認済みにする。', operation: 'seven_po:verify'
    });
    expect(nextActionForOrder(order('DRAFT'), workspace(), 'admin')).toMatchObject({
      text: `状態を「${label('SEVEN_PO_VERIFIED')}」へ進める。`, operation: 'film_order:transition', refusal: null
    });
    expect(nextActionForOrder(order('DRAFT', { sevenPurchaseOrderId: null }), workspace(), 'admin').text)
      .toContain('セブン化学発注書に紐付いていないため');
    // Staff do not read the order's PO link: never a guess. UI batch E (F-05, T2):
    // with every visible PO registered and verified, the step is the transition
    // and the one cause left — never 「本登録と発注書の照合チェックを済ませ」 again.
    const general = nextActionForOrder(order('DRAFT', { detailsHidden: true, sevenPurchaseOrderId: null }), workspace(), 'staff');
    expect(general).toMatchObject({ operation: 'film_order:transition', refusal: null });
    expect(general.text).toBe(
      `状態を「${label('SEVEN_PO_VERIFIED')}」へ進める。進められないときは、この発注がセブン化学発注書に紐付いていません（紐付けは作成のときだけ選べます。発注画面の「フィルム発注を作成する」で発注書を選んで作り直し、この発注は「${label('CANCELLATION_REVIEW')}」から取消で終了してください）。`
    );
    // A PO still to register or verify: the general step stays.
    const pending = nextActionForOrder(order('DRAFT', { detailsHidden: true, sevenPurchaseOrderId: null }), workspace([{ ...po, verificationStatus: null }]), 'staff');
    expect(pending.text).toBe(`セブン化学発注書の本登録と発注書の照合チェックを済ませ、状態を「${label('SEVEN_PO_VERIFIED')}」へ進める。`);
  });

  it('ARTWORK_RECEIVED: asks for the proof revision, but never claims it missing when revisions are withheld (L8)', () => {
    expect(nextActionForOrder(order('ARTWORK_RECEIVED'), workspace(), 'admin')).toMatchObject({
      text: '校正ゲラを承認画面で登録します。登録すると自動で進みます。',
      operation: 'artwork_revision:create', screens: ['/approvals', '/orders']
    });
    expect(nextActionForOrder(order('ARTWORK_RECEIVED'), workspace([po], 2), 'staff')).toMatchObject({
      text: '校正ゲラの版が承認画面に登録されていることを確かめます。校正ゲラを登録すると自動で進みます。進んでいないときは、発注の画面で理由を確認してください。',
      operation: 'film_order:transition', refusal: null
    });
  });

  // B-M1: the maker PO screen does not list an order in a hold or review for
  // its normal work, so the step is no /maker-po link. Recheck 7 Medium-3: it
  // is listed (cleanup only) while maker paper is left to clean up — the link
  // then appears, and only then (tests/web-ui-recheck7.test.tsx). UI batch D: the hold release and the
  // cancellation review resolution are the representative's dedicated
  // operations on /orders (the server resumes the origin, maker chain
  // included); CHANGE_REVIEW keeps the generic restart transition.
  const MAKER_CHAIN_LEFT = ['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED'] as const;
  const EXCEPTION_STEP = {
    ON_HOLD: {
      text: '代表者が理由を記録して保留を解除する（原則として保留にする前の状態に戻ります。保留中にその段階のメーカー発注書が取り消され、残っている発注書がない場合は「メーカー発注準備完了」に戻ります）。',
      owner: '代表者', operation: 'film_order:release_hold'
    },
    CANCELLATION_REVIEW: {
      text: '代表者が理由を記録して取消確認を処理する（再開するか、取消で終了するか）。',
      owner: '代表者', operation: 'film_order:resolve_cancellation_review'
    },
    CHANGE_REVIEW: {
      text: '再開する状態を選んで、状態を進める。',
      owner: '担当者・代表者', operation: 'film_order:transition'
    }
  } as const;
  describe.each(FILM_SUPPLY_ORDER_EXCEPTION_STATES)('%s left from the maker chain (B-M1)', (exception) => {
    it.each(MAKER_CHAIN_LEFT)('after %s: the dedicated step on /orders, no maker PO screen link', (left) => {
      const action = nextActionForOrder(order(exception, { lastNormalStatus: left }), workspace(), 'staff');
      expect(action.text).toBe(EXCEPTION_STEP[exception].text);
      expect(action.owner).toBe(EXCEPTION_STEP[exception].owner);
      expect(action.screens).toEqual(['/orders']);
      expect(action.text).not.toContain('メーカー発注画面');
    });

    it.each(['admin', 'staff', 'viewer'] as const)('%s: the same wording; the refusal follows the operation\'s matrix', (role) => {
      const operation = EXCEPTION_STEP[exception].operation;
      for (const left of MAKER_CHAIN_LEFT) {
        const action = nextActionForOrder(order(exception, { lastNormalStatus: left }), workspace(), role);
        expect(action, `${role} ${left}`).toMatchObject({
          screens: ['/orders'], operation, refusal: operationRefusal(role, operation)
        });
      }
      // Independent of the helper: only the representative releases a hold or resolves a review.
      if (exception !== 'CHANGE_REVIEW') {
        expect(nextActionForOrder(order(exception), workspace(), role).refusal === null).toBe(role === 'admin');
      }
    });
  });

  it('guard: no exception state × left state ever links the maker PO screen (B-M1)', () => {
    // The maker PO screen lists none of the exception states, so a link there
    // from a hold or review is always a dead end.
    for (const exception of FILM_SUPPLY_ORDER_EXCEPTION_STATES) {
      for (const left of [...FILM_SUPPLY_ORDER_STATES, null]) {
        for (const role of ROLES) {
          const action = nextActionForOrder(order(exception, { lastNormalStatus: left }), workspace(), role);
          expect(action.screens, `${exception} ${left} ${role}`).not.toContain('/maker-po');
        }
      }
    }
  });

  it('exception, terminal and withheld states', () => {
    expect(nextActionForOrder(order('ON_HOLD'), workspace(), 'staff')).toMatchObject({
      text: '代表者が理由を記録して保留を解除する（原則として保留にする前の状態に戻ります。保留中にその段階のメーカー発注書が取り消され、残っている発注書がない場合は「メーカー発注準備完了」に戻ります）。', screens: ['/orders'],
      refusal: 'この操作は代表者が行います。'
    });
    expect(nextActionForOrder(order('CHANGE_REVIEW'), workspace(), 'staff')).toMatchObject({
      text: '再開する状態を選んで、状態を進める。', screens: ['/orders'], refusal: null
    });
    // Recheck 7 Medium-3: 「これ以上の作業はありません」 only once the maker paper is known to be settled.
    expect(nextActionForOrder(order('CANCELLED'), {
      ...workspace(),
      makerPaperCleanup: { [ORDER_READY]: { state: 'none', livePapers: 0, cancellablePapers: 0, acknowledgementPapers: 0 } }
    }, 'admin')).toEqual({
      text: 'この発注は取消で終了しています。これ以上の作業はありません。', owner: null, screens: [], operation: null, refusal: null
    });
    expect(nextActionForOrder(order('CANCELLED'), workspace(), 'admin')).toMatchObject({
      text: 'この発注は取消で終了しています。メーカー発注書の整理（取り消し・取り消し承認）が残っていないかは、メーカー発注画面で確認してください。',
      owner: null, screens: ['/maker-po']
    });
    expect(nextActionForOrder(order('FILM_RECEIPT_ASSUMED_NO_ISSUE'), workspace(), 'admin')).toEqual({
      text: 'この発注は完了しています。', owner: null, screens: [], operation: null, refusal: null
    });
    const hidden = nextActionForOrder(order('DRAFT', { statusHidden: true }), workspace(), 'viewer');
    expect(hidden).toMatchObject({ owner: null, screens: [], refusal: '閲覧権限のため操作できません。' });
    expect(hidden.text).not.toContain('発注書の照合済み');
  });

  it('every state yields a Japanese sentence without an English state code', () => {
    for (const state of ALL_STATES) {
      const action = nextActionForOrder(order(state), workspace(), 'admin');
      expect(action.text, state).toMatch(/。$/);
      expect(action.text, state).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    }
  });

  it('no film order yet: register the seven PO first, then create the film order', () => {
    expect(nextActionWithoutOrders({ sevenPurchaseOrders: [] }, 'staff')).toMatchObject({
      text: 'セブン化学発注書を登録する。', operation: 'seven_po:create', screens: ['/orders'], refusal: null
    });
    expect(nextActionWithoutOrders({ sevenPurchaseOrders: [po] }, 'viewer')).toMatchObject({
      text: 'フィルム発注を作成する。', operation: 'film_order:create', refusal: '閲覧権限のため操作できません。'
    });
  });
});

// ---------------------------------------------------------------------------
// ③ transition choices: a contract with the core state machine
// ---------------------------------------------------------------------------

describe('③ transitionChoicesFor: only targets the generic transition endpoint accepts', () => {
  const EX = ['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'];
  // Written out by hand from design section 6.1 (lastNormalStatus APPROVAL_PENDING for the exceptions).
  const EXPECTED_CHOICES: Record<FilmSupplyOrderState, string[]> = {
    DRAFT: ['SEVEN_PO_VERIFIED', ...EX],
    SEVEN_PO_VERIFIED: ['ARTWORK_RECEIVED', ...EX],
    // P4 M5: PROOF_READY / APPROVAL_PENDING / MAKER_PO_READY are the system's own steps (AUTO_TRANSITION_ONLY) — not offered.
    ARTWORK_RECEIVED: EX,
    PROOF_READY: EX,
    APPROVAL_PENDING: ['DUAL_APPROVED', ...EX],
    DUAL_APPROVED: EX,
    MAKER_PO_READY: EX,
    APPROVED_FOR_MANUAL_SEND: EX,
    MAKER_PO_SENT_MANUALLY: EX,
    MAKER_PO_ACCEPTED: ['FILM_IN_PRODUCTION', ...EX],
    FILM_IN_PRODUCTION: ['FILM_SHIPPED', ...EX],
    FILM_SHIPPED: ['FILM_DELIVERED', ...EX],
    FILM_DELIVERED: EX,
    FILM_RECEIPT_ASSUMED_NO_ISSUE: [],
    // UI batch D: the API refuses every generic target from a hold or a
    // cancellation review (core needs the origin only the dedicated endpoints
    // read), so the select offers nothing there.
    ON_HOLD: [],
    CHANGE_REVIEW: ['APPROVAL_PENDING', 'ARTWORK_RECEIVED', 'PROOF_READY'],
    CANCELLATION_REVIEW: []
  };
  const DEDICATED_EXIT = ['ON_HOLD', 'CANCELLATION_REVIEW'];

  it.each(ALL_STATES)('%s: exactly the expected targets, each allowed by core; only maker-chain / terminal / maker-skipping jumps left out', (state) => {
    const set = transitionChoicesFor(state, label, 'APPROVAL_PENDING');
    expect(set.choices.map((choice) => choice.value)).toEqual(EXPECTED_CHOICES[state]);
    for (const choice of set.choices) {
      expect(transitionFilmSupplyOrder(state, choice.value as FilmSupplyOrderState).ok, `${state}→${choice.value}`).toBe(true);
      expect(makerChainTransitionRefusal(choice.value).ok, choice.value).toBe(true);
      expect(choice.value).not.toBe('FILM_RECEIPT_ASSUMED_NO_ISSUE');
      // Japanese label only — no 「（DRAFT）」-style code next to it.
      expect(choice.label).toBe(label(choice.value));
      expect(choice.label).not.toContain(choice.value);
    }
    if (DEDICATED_EXIT.includes(state)) {
      // Why nothing is offered, checked against core directly: without the
      // origin no target is allowed (the generic endpoint never passes one).
      for (const to of filmSupplyOrderTransitions(state)) {
        expect(transitionFilmSupplyOrder(state, to).ok, `${state}→${to}`).toBe(false);
      }
      expect(set.emptyReason).toBe(state === 'ON_HOLD' ? HOLD_RELEASE_NOTICE : CANCELLATION_REVIEW_NOTICE);
      return;
    }
    const offered = new Set(set.choices.map((choice) => choice.value));
    const leftOut = filmSupplyOrderTransitions(state).filter((to) => !offered.has(to));
    const leftOutAllowed = (FILM_SUPPLY_ORDER_EXCEPTION_STATES as readonly string[]).includes(state)
      // B-M2: leaving at APPROVAL_PENDING, the jumps past the maker acceptance are held back too.
      ? ['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE',
        'FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED']
      : ['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE',
        'PROOF_READY', 'APPROVAL_PENDING', 'MAKER_PO_READY'];
    for (const to of leftOut) {
      expect(leftOutAllowed, `${state}→${to}`).toContain(to);
    }
  });

  it('normal targets first; the exceptions grouped under 例外（保留・見直し）', () => {
    const set = transitionChoicesFor('MAKER_PO_ACCEPTED', label);
    expect(set.choices.map((choice) => [choice.value, choice.group ?? null])).toEqual([
      ['FILM_IN_PRODUCTION', null],
      ['ON_HOLD', EXCEPTION_GROUP_LABEL],
      ['CHANGE_REVIEW', EXCEPTION_GROUP_LABEL],
      ['CANCELLATION_REVIEW', EXCEPTION_GROUP_LABEL]
    ]);
    expect(set).toMatchObject({ makerChainNotice: false, hint: null, emptyReason: null });
  });

  it.each(['MAKER_PO_READY', 'APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY'] as const)(
    '%s: the next step is the maker PO screen; only the exceptions remain here',
    (state) => {
      const set = transitionChoicesFor(state, label);
      expect(set.makerChainNotice).toBe(true);
      expect(set.choices.map((choice) => choice.value)).toEqual(['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW']);
    }
  );

  it('CHANGE_REVIEW resumes into the state it left first; later restart targets sit apart under 先の段階へ進める（注意）', () => {
    expect(transitionChoicesFor('CHANGE_REVIEW', label, 'PROOF_READY').choices.map((choice) => choice.value))
      .toEqual(['PROOF_READY', 'ARTWORK_RECEIVED', 'APPROVAL_PENDING']);
    const set = transitionChoicesFor('CHANGE_REVIEW', label, 'ARTWORK_RECEIVED');
    expect(set.choices[0]).toEqual({ value: 'ARTWORK_RECEIVED', label: label('ARTWORK_RECEIVED'), group: RESUME_GROUP_LABEL });
    expect(set.choices.filter((choice) => choice.group === SKIP_AHEAD_GROUP_LABEL).map((choice) => choice.value))
      .toEqual(['PROOF_READY', 'APPROVAL_PENDING']);
    // Unknown left state: nothing is called ahead.
    expect(transitionChoicesFor('CHANGE_REVIEW', label, null).choices.every((choice) => choice.group === RESUME_GROUP_LABEL)).toBe(true);
    expect(set.resumeNotice).toBeNull();
  });

  it('a hold or a cancellation review, from any left state (maker chain included): no generic target, the dedicated form named (UI batch D)', () => {
    for (const left of [...FILM_SUPPLY_ORDER_STATES, null]) {
      expect(transitionChoicesFor('ON_HOLD', label, left)).toEqual({
        choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: HOLD_RELEASE_NOTICE
      });
      expect(transitionChoicesFor('CANCELLATION_REVIEW', label, left)).toEqual({
        choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: CANCELLATION_REVIEW_NOTICE
      });
    }
    // The old 「どの画面からも戻せません」 notice is gone: the release resumes the maker-chain origin on the server.
    expect(HOLD_RELEASE_NOTICE).toContain('保留にする前の状態にシステムが戻します');
    expect(HOLD_RELEASE_NOTICE).not.toContain('メーカー発注画面');
  });

  it('CANCELLED (取消終了) offers nothing, with its own reason', () => {
    // Recheck 7 Medium-3: this plain reason only when the maker paper is settled ('none').
    expect(transitionChoicesFor('CANCELLED', label, null, 'none')).toMatchObject({
      choices: [], emptyReason: 'この発注は取消で終了しています（取消済）。これ以上進める先はありません。'
    });
  });

  it('B-M2 (api-probes.txt): ON_HOLD left at APPROVED_FOR_MANUAL_SEND never offers FILM_IN_PRODUCTION', () => {
    const values = transitionChoicesFor('ON_HOLD', label, 'APPROVED_FOR_MANUAL_SEND').choices.map((choice) => choice.value);
    expect(values).not.toContain('FILM_IN_PRODUCTION');
    expect(values).not.toContain('FILM_SHIPPED');
    expect(values).not.toContain('FILM_DELIVERED');
    // UI batch D: nothing at all — the representative's release resumes the origin on the server.
    expect(values).toEqual([]);
  });

  describe('B-M2: every exception state × every left state, checked against core directly', () => {
    // Independent of transitions.ts: the order of the chain and the allowed
    // targets come from core; the maker chain is written out by hand.
    const CHAIN = FILM_SUPPLY_ORDER_STATES as readonly string[];
    const ACCEPTED_AT = CHAIN.indexOf('MAKER_PO_ACCEPTED');
    const MAKER_CHAIN = ['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED'];
    const TERMINAL = 'FILM_RECEIPT_ASSUMED_NO_ISSUE';
    const LEFT_STATES: Array<string | null> = [...FILM_SUPPLY_ORDER_STATES, null, 'NOT_A_STATE'];
    const cases = FILM_SUPPLY_ORDER_EXCEPTION_STATES.flatMap((exception) =>
      LEFT_STATES.map((left) => [exception, left] as const));

    it('the fixture is what the rule is about', () => {
      expect(ACCEPTED_AT).toBe(9);
      expect(CHAIN.slice(ACCEPTED_AT + 1)).toEqual(['FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED', TERMINAL]);
      expect(cases).toHaveLength(3 * 16);
    });

    it.each(cases)('%s left at %s: no choice skips past the maker acceptance; the other core targets stay', (exception, left) => {
      const leftAt = left === null ? -1 : CHAIN.indexOf(left);
      const leftBeforeAcceptance = leftAt < ACCEPTED_AT; // includes unknown / null
      const set = transitionChoicesFor(exception, label, left);
      const values = set.choices.map((choice) => choice.value);
      if (exception !== 'CHANGE_REVIEW') {
        // UI batch D: left only through the dedicated admin endpoint — nothing here can skip.
        expect(values).toEqual([]);
        return;
      }
      const expected = filmSupplyOrderTransitions(exception).filter((to) =>
        !MAKER_CHAIN.includes(to)
        && to !== TERMINAL
        && !(leftBeforeAcceptance && CHAIN.indexOf(to) > ACCEPTED_AT));
      expect([...values].sort()).toEqual([...expected].sort());
      for (const choice of set.choices) {
        const index = CHAIN.indexOf(choice.value);
        if (leftBeforeAcceptance) expect(index, `${exception} ${left}→${choice.value}`).toBeLessThanOrEqual(ACCEPTED_AT);
        expect(transitionFilmSupplyOrder(exception, choice.value as FilmSupplyOrderState, null).ok).toBe(true);
        // Past the left state is a jump (注意); the rest resumes.
        expect(choice.group, `${exception} ${left}→${choice.value}`)
          .toBe(leftAt >= 0 && index > leftAt ? SKIP_AHEAD_GROUP_LABEL : RESUME_GROUP_LABEL);
      }
      if (!leftBeforeAcceptance) {
        // Left at or after the acceptance: production onward skips no maker step.
        for (const to of ['FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED']) {
          if (filmSupplyOrderTransitions(exception).includes(to as FilmSupplyOrderState)) expect(values, to).toContain(to);
        }
      }
    });

    it('the CHANGE_REVIEW restart jumps (all before the maker chain) remain under 先の段階へ進める（注意）', () => {
      const skip = (left: string) => transitionChoicesFor('CHANGE_REVIEW', label, left).choices
        .filter((choice) => choice.group === SKIP_AHEAD_GROUP_LABEL).map((choice) => choice.value);
      expect(skip('DRAFT')).toEqual(['ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']);
      expect(skip('PROOF_READY')).toEqual(['APPROVAL_PENDING']);
      expect(skip('FILM_SHIPPED')).toEqual([]);
    });
  });

  it('APPROVAL_PENDING keeps the dual approval target with a hint; FILM_DELIVERED leaves the receipt to its own form', () => {
    const pending = transitionChoicesFor('APPROVAL_PENDING', label);
    expect(pending.choices[0]?.value).toBe('DUAL_APPROVED');
    expect(pending.hint).toBe(`「${label('DUAL_APPROVED')}」へは、通常は承認の記録で自動的に進みます。`);
    const delivered = transitionChoicesFor('FILM_DELIVERED', label);
    expect(delivered.choices.map((choice) => choice.value)).toEqual(['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW']);
    expect(delivered.hint).toBe('「問題なしで完了」は下の操作で記録します。');
  });

  it('the terminal state and an unknown status offer nothing, with a reason', () => {
    expect(transitionChoicesFor('FILM_RECEIPT_ASSUMED_NO_ISSUE', label)).toMatchObject({
      choices: [], emptyReason: 'この発注は完了しています。進める先はありません。'
    });
    expect(transitionChoicesFor('NOT_A_STATE', label).choices).toEqual([]);
    expect(transitionChoicesFor('NOT_A_STATE', label).emptyReason).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ④ role helper and ⑥ short id
// ---------------------------------------------------------------------------

describe('④ canRoleOperate mirrors the core canPerform matrix', () => {
  const OPERATIONS: Operation[] = [
    'ceo_approve', 'seven_po:create', 'seven_po:register', 'seven_po:verify', 'document:create', 'document:verify',
    'artwork_revision:create', 'artwork_approval:record', 'artwork_approval:verify_evidence', 'maker_po:create',
    'maker_po:cancel', 'maker_po:send_evidence', 'maker_po:accept_evidence', 'maker_po:accept_provisional',
    'maker_po:verify_send', 'film_order:create', 'film_order:update_payment_terms', 'film_order:transition',
    'film_order:assume_receipt', 'film_delivery:create', 'delivery_confirmation:record', 'filling_order:create',
    'filling_delivery:create', 'commission_readiness:evaluate'
  ];

  it.each(ROLES)('%s: the same answer as canPerform on an assigned project, for every operation the screens use', (role) => {
    for (const operation of OPERATIONS) {
      const core = canPerform({ id: 'u', role, isActive: true, assignedProjectIds: ['p'] }, operation, 'F1', 'p').allowed;
      expect(canRoleOperate(role, operation), `${role} ${operation}`).toBe(core);
    }
  });

  it('representative-only work, staff work and the read-only viewer (independent expectations)', () => {
    // P-6 (P1 integration): maker_po:create (the DRAFT paper) is staff work now; approving it is not.
    for (const operation of ['ceo_approve', 'maker_po:cancel', 'maker_po:accept_evidence', 'maker_po:verify_send', 'artwork_approval:verify_evidence'] as Operation[]) {
      expect(canRoleOperate('admin', operation), operation).toBe(true);
      expect(canRoleOperate('staff', operation), operation).toBe(false);
    }
    for (const operation of ['maker_po:create', 'maker_po:send_evidence', 'maker_po:accept_provisional', 'film_order:transition', 'document:verify'] as Operation[]) {
      expect(canRoleOperate('staff', operation), operation).toBe(true);
    }
    for (const operation of OPERATIONS) expect(canRoleOperate('viewer', operation), operation).toBe(false);
  });

  it('an unknown or missing role is treated as viewer', () => {
    expect(canRoleOperate('superuser', 'film_order:create')).toBe(false);
    expect(canRoleOperate(undefined, 'seven_po:create')).toBe(false);
    expect(operationRefusal('superuser', 'seven_po:create', '発注書の登録')).toBe('発注書の登録は、閲覧権限のため操作できません。');
  });

  it('a role that could not be read hides the forms but is not called 閲覧者 (M5)', () => {
    expect(canRoleOperate(null, 'film_order:create')).toBe(false);
    expect(operationRefusal(null, 'seven_po:create', '発注書の登録')).toBe('役割を確認できませんでした。再読み込みしてください。');
    expect(operationRefusal(null, 'seven_po:create')).not.toContain('閲覧');
  });

  it('the refusal wording per role', () => {
    expect(operationRefusal('admin', 'ceo_approve')).toBeNull();
    expect(operationRefusal('staff', 'maker_po:create')).toBeNull();
    expect(operationRefusal('staff', 'ceo_approve')).toBe('この操作は代表者が行います。');
    expect(operationRefusal('staff', 'ceo_approve', '代表承認')).toBe('代表承認は代表者が行います。');
    expect(operationRefusal('viewer', 'seven_po:create')).toBe('閲覧権限のため操作できません。');
  });
});

describe('⑥ shortId', () => {
  it('two uuidv7 ids made in the same millisecond get different labels', () => {
    const first = '01a1ec60-1234-7000-8000-00000000a1b2';
    const second = '01a1ec60-1234-7abc-9def-00000000c3d4';
    expect(first.slice(0, 13)).toBe(second.slice(0, 13));
    expect(shortId(first)).toBe('…0000a1b2');
    expect(shortId(second)).toBe('…0000c3d4');
    expect(shortId(first)).not.toBe(shortId(second));
  });

  it('the maker PO choice and the hidden seven PO label use the tail', () => {
    const [choice] = toMakerPoChoices(
      [{ id: 'o1', code: 'FSO-1' }],
      new Map([['o1', [{ id: '01a1ec60-1234-7000-8000-00000000a1b2', status: 'DRAFT' }]]]),
      { DRAFT: '下書き' }
    );
    expect(choice?.label).toBe('FSO-1 / …0000a1b2（下書き）');
    expect(sevenPurchaseOrderChoiceLabel({
      id: PO_ID, poNumber: '', poNumberHidden: true, officialRegisteredAt: null, officiallyRegistered: true,
      verificationStatus: null, reviewPending: false, officialRegistrationHidden: true, verificationHidden: true
    })).toBe('発注番号 閲覧権限なし・ID …0000aa01（本登録済み）');
  });
});

// ---------------------------------------------------------------------------
// Rendered screens per role (integration through the API's own role filter)
// ---------------------------------------------------------------------------

const FORM_MARKERS = {
  // 支払条件 (FSO-DRAFT, P0 R01: label 「支払条件を変更する」) and 受領確認 (FSO-DELIV): both staff work, gated per role.
  orders: ['発注書を登録する', '状態を進める', '発注を作成する', '支払条件を変更する', '受領確認を記録する'],
  // P1 P-4: the fixture's documents were uploaded by this staff member — their 確認 is not offered (see below).
  documents: ['書類をアップロードする'],
  approvals: ['版を登録する'],
  'maker-po': ['送信を記録する', '発注を作成する'],
  deliveries: ['準備状態を再評価する', '納品を記録する', '納品を確認する']
} as const;

/**
 * Representative-only forms (submit labels) and the screen they live on. The
 * approval decision (artwork_approval:record) is staff work — see the
 * dedicated staff test below; it is not listed here.
 */
const ADMIN_ONLY_FORMS = {
  'maker-po': ['発注書を取り消す'],
  approvals: ['手動確認を記録する']
} as const;

describe('rendered screens: stepper, 次にやること and role-gated forms', () => {
  for (const page of PAGE_NAMES) {
    it(`${page} (viewer): no form at all, the read-only notice, and the progress with its marks (server batch E)`, async () => {
      serveAs('viewer');
      const html = await renderPage(PAGES[page]);
      expect(html.match(/<form\b/g) ?? []).toHaveLength(0);
      expect(html).toContain(VIEWER_PAGE_NOTICE);
      expect(html).toMatch(/閲覧権限のため操作できません/);
      expect(html).toContain('class="stepper"');
      // F-01 (server batch E): the viewer reads where each order stands.
      expect(html).toContain('aria-current="step"');
      expect(html).not.toContain('この役割では発注の状態は表示されません（閲覧権限なし）');
      expect(html).toContain('次にやること');
      // No 操作 column left without a form in it.
      expect(html).not.toContain('>操作</th>');
      expect(html).not.toContain('>確認を記録する</th>');
    });

    it(`${page} (staff): the allowed forms, never a representative-only one`, async () => {
      serveAs('staff');
      const html = await renderPage(PAGES[page]);
      for (const marker of FORM_MARKERS[page]) expect(html, marker).toContain(`>${marker}</button>`);
      if (page === 'documents') expect(html).toContain('自分で登録した証跡は自分で確認できません');
      if (page === 'documents') expect(html).toContain('自分で登録した証跡は自分で確認できません');
      for (const marker of (ADMIN_ONLY_FORMS as Record<string, readonly string[]>)[page] ?? []) {
        expect(html, marker).not.toContain(`>${marker}</button>`);
      }
      expect(html).not.toContain(VIEWER_PAGE_NOTICE);
      expect(html).toContain('aria-current="step"');
      expect(html).toContain('完了した発注 1件');
    });

    it(`${page} (admin): every form, the progress with its stamps`, async () => {
      serveAs('admin');
      const html = await renderPage(PAGES[page]);
      for (const marker of FORM_MARKERS[page]) expect(html, marker).toContain(`>${marker}</button>`);
      // P-4: the representative may confirm any evidence, their own included.
      if (page === 'documents') expect(html).toContain('>確認を記録する</button>');
      for (const marker of (ADMIN_ONLY_FORMS as Record<string, readonly string[]>)[page] ?? []) {
        expect(html, marker).toContain(`>${marker}</button>`);
      }
      expect(html).not.toContain('class="role-notice"');
      expect(html).toContain('<span class="step-mark">済</span>');
      expect(html).toContain('<span class="step-mark">いま</span>');
      expect(html).toContain('<span class="step-mark">中断</span>');
      expect(html).toContain(`<span class="progress-badge">${label('ON_HOLD')}</span>`);
    });

    it.each(ROLES)(`${page} (%s): no UUID outside a <details>, no English state code in the text`, async (role) => {
      serveAs(role);
      const text = textOutsideDetails(await renderPage(PAGES[page]));
      expect(text).not.toMatch(UUID);
      expect(text).not.toMatch(/\b(MAKER_PO_READY|FILM_DELIVERED|FILM_RECEIPT_ASSUMED_NO_ISSUE|SEND_UNVERIFIED)\b/);
      expect(text).not.toContain('/api/');
      expect(text).not.toMatch(/prepaid|on_delivery|undetermined/);
      expect(text).not.toMatch(/\b(seven_po|approval_evidence|acceptance_evidence|send_evidence|eml_header_check)\b/);
    });
  }

  it('viewer on maker-po (server batch E): the board follows the readable statuses, never 「no order yet」, no form (M2)', async () => {
    serveAs('viewer');
    const html = await renderPage(MakerPoPage);
    expect(html).not.toContain(STATUS_HIDDEN_NOTICE);
    expect(html).not.toContain('作業対象の発注はまだありません');
    expect(html.match(/<form\b/g) ?? []).toHaveLength(0);
    // The order at MAKER_PO_READY is on the board; its creation is the representative's.
    expect(html).toContain('メーカー発注書の作成は、閲覧権限のため操作できません。');
  });

  it('maker-po (admin): a DRAFT order is not on the board, so no 支払条件 form here (L10)', async () => {
    serveAs('admin');
    const html = await renderPage(MakerPoPage);
    expect(html).not.toContain('フィルム発注 FSO-DRAFT');
    expect(html).not.toContain('>支払条件を変更する</button>');
    expect(html).toContain('フィルム発注 FSO-READY');
  });

  it('approvals (staff, gate readable): the approval decision is staff work — form shown, no refusal (M3)', async () => {
    // The real API withholds the revision's order link from staff, so the gate
    // is shaped as admin here to check the screen rule itself.
    serveAs('staff', ROWS, 'admin');
    const html = await renderPage(ApprovalsPage);
    expect(html).toContain('>顧客として承認する</button>');
    expect(html).toContain('>セブン化学として承認する</button>');
    expect(html).toContain('approval.eml（版1／確認状態 確認済み／ID …0000ee02）');
    expect(html).not.toContain('承認の記録は');
    expect(html).not.toContain('>手動確認を記録する</button>');
    expect(html).toContain('手動確認の記録は代表者が行います。');
  });

  it.each(PAGE_NAMES)('%s (role unreadable): forms hidden, worded apart from 閲覧者 (M5)', async (page) => {
    serveAs(null);
    const html = await renderPage(PAGES[page]);
    expect(html.match(/<form\b/g) ?? []).toHaveLength(0);
    expect(html).toContain(ROLE_UNKNOWN_PAGE_NOTICE);
    expect(html).toContain('役割を確認できませんでした。再読み込みしてください。');
    expect(html).not.toContain(VIEWER_PAGE_NOTICE);
    expect(html).not.toContain('閲覧権限のため操作できません');
  });

  it('staff on maker-po: 次にやること names who does the representative step', async () => {
    serveAs('staff');
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('メーカー発注書（下書き）を作成する。作成後に代表が承認します。');
    expect(html).toContain('この操作は代表者が行います。');
    // P-6: staff may draft the paper themselves — no 「作成は代表者」 refusal any more.
    expect(html).not.toContain('メーカー発注書の作成は代表者が行います。');
    expect(html).toContain('この画面の下にあります');
  });

  it('orders (admin): the transition selects are narrowed, start blank and are required', async () => {
    serveAs('admin');
    const html = await renderPage(OrdersPage);
    const selects = [...html.matchAll(/<select[^>]*name="to"[^>]*>([\s\S]*?)<\/select>/g)];
    // FSO-READY, FSO-SEND, FSO-HOLD, FSO-DRAFT, FSO-DELIV: the completed order offers no form.
    const optionValues = (inner: string) => [...inner.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
    expect(selects.map(([, inner]) => optionValues(inner!))).toEqual([
      ['', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'], // FSO-READY
      ['', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'], // FSO-SEND
      // FSO-HOLD: no generic select — the representative's release form instead (UI batch D).
      ['', 'SEVEN_PO_VERIFIED', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'], // FSO-DRAFT
      ['', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'] // FSO-DELIV
    ]);
    for (const [whole, inner] of selects) {
      expect(whole).toMatch(/required/);
      expect(inner).toMatch(/^<option value="">（進める先を選ぶ）<\/option>/);
      expect(inner).not.toMatch(/selected/);
    }
    expect(html).toContain('「問題なしで完了」は下の操作で記録します。');
    expect(html).not.toContain(`<optgroup label="${RESUME_GROUP_LABEL}">`);
    expect(html).toContain(HOLD_RELEASE_NOTICE);
    expect(html).toContain('保留を解除する（代表者のみ）');
    expect(html).toContain(`<optgroup label="${EXCEPTION_GROUP_LABEL}">`);
    // A hold is offered with its reason field (the API's HOLD_REASON_REQUIRED).
    expect(html).toContain('name="holdReason"');
    expect(html).toContain('次はメーカー発注画面の操作で進みます。');
    expect(html).toContain('この発注は完了しています。進める先はありません。');
    expect(html).toContain('メーカー発注画面を開く');
  });
});

/**
 * Review mutant M11 (`canApprove = true` survived): a maker PO awaiting the
 * representative's approval, on the order at MAKER_PO_READY, shaped per role
 * by the API's own buildMakerPoViewForRole.
 */
describe('maker-po: the 代表承認 form is the representative\'s (M11)', () => {
  const DRAFT_PO = '01a1ec60-0000-7000-8000-00000000cc02';
  const RECORD: MakerPoRecord = {
    id: DRAFT_PO, filmSupplyOrderId: ORDER_READY,
    snapshot: { order: { code: 'FSO-READY' }, recipient: { address: 'maker@example.test' } },
    snapshotSha256: 'ab'.repeat(32), status: 'DRAFT', ceoApprovedByUserId: null, ceoApprovedAt: null,
    createdByUserId: USER_ID, createdAt: new Date(Date.UTC(2026, 10, 18, 0, 0, 0)), updatedAt: new Date(Date.UTC(2026, 10, 18, 0, 0, 0))
  };
  function serveDraftPo(role: Role) {
    serveAs(role);
    const base = callApi.getMockImplementation()!;
    const shaped = JSON.parse(JSON.stringify(buildMakerPoViewForRole(role, RECORD)));
    callApi.mockImplementation(async (apiPath: string, ...rest: unknown[]) => {
      const ok = (data: unknown) => ({ ok: true, status: 200, error: null, data });
      if (apiPath === `/api/film-supply-orders/${ORDER_READY}/maker-purchase-orders`) return ok({ makerPurchaseOrders: [shaped] });
      if (apiPath === `/api/maker-purchase-orders/${DRAFT_PO}`) return ok({ purchaseOrder: shaped, events: [] });
      return base(apiPath, ...rest);
    });
  }
  // P4 N5: this list no longer records the approval; it links the order screen's card (step 8).
  const APPROVE_BUTTON = '>代表承認を記録する</button>';
  const CARD_LINK = '内容を見て代表承認する';
  const WAITING = 'メーカー発注書 …0000cc02 は代表承認待ちです。';

  it('admin: the approval form for that paper, no refusal', async () => {
    serveDraftPo('admin');
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('手順2: 代表承認（代表者のみ）');
    expect(html).not.toContain(APPROVE_BUTTON);
    // The approval's own fields (the terms the representative saw) are gone from this list.
    expect(html).not.toContain('name="expectedPaymentTerms"');
    expect(html).toContain(CARD_LINK);
    expect(html).toMatch(/href="\/p\/TEST-P\/o\/FSO-READY\?step=8"/);
    expect(html).not.toContain(WAITING);
  });

  it('staff: no approval form; the refusal says the representative approves', async () => {
    serveDraftPo('staff');
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('手順2: 代表承認（代表者のみ）');
    expect(html).not.toContain(APPROVE_BUTTON);
    expect(html).not.toContain(CARD_LINK);
    expect(html).toContain(`${WAITING}代表承認は代表者が行います。`);
  });

  it('viewer: no approval form and no form at all', async () => {
    serveDraftPo('viewer');
    const html = await renderPage(MakerPoPage);
    expect(html).not.toContain(APPROVE_BUTTON);
    expect(html.match(/<form\b/g) ?? []).toHaveLength(0);
  });
});

describe('unselected project message', () => {
  it('is the same on all five screens', async () => {
    selectedProject.current = null;
    // ui/fix-project-select: with several projects to choose from nothing is
    // opened for the operator, so every screen asks for a choice.
    callApi.mockImplementation(async (apiPath: string) => apiPath === '/api/projects'
      ? { ok: true, status: 200, error: null, data: { projects: [
          { id: PROJECT_ID, code: 'P-1', name: '案件1', status: 'active' },
          { id: `${PROJECT_ID.slice(0, -1)}0`, code: 'P-2', name: '案件2', status: 'active' }
        ] } }
      : { ok: false, status: 404, error: 'not served in this test', data: null });
    try {
      for (const page of PAGE_NAMES) {
        const html = await renderPage(PAGES[page]);
        expect(html, page).toContain(NO_PROJECT_SELECTED_MESSAGE);
        expect(html, page).not.toContain('案件の選択');
      }
    } finally {
      selectedProject.current = PROJECT_ID;
    }
  });
});

describe('② ProjectPicker', () => {
  const choices = [
    { value: PROJECT_ID, label: 'CMP-F1-B（合成B）' },
    { value: '01a1ec52-a795-7bdb-bc42-fd346d93d334', label: 'CMP-F1-C（合成C）' }
  ];
  const action = async () => ({ ok: true, message: '' });

  it('posts the unchanged fields, starts on the selected project and keeps a live region', () => {
    const html = renderToString(<ProjectPicker action={action} choices={choices} currentProjectId={PROJECT_ID} />)
      .replaceAll('<!-- -->', '');
    expect(html).toContain('name="projectId"');
    expect(html).toContain('name="directProjectId"');
    expect(html).toContain('<option value="">（選択なし）</option>');
    expect(html).toContain(`<option value="${PROJECT_ID}" selected="">CMP-F1-B（合成B）</option>`);
    expect(html).toMatch(/<span role="status"[^>]*><\/span>/);
    expect(html).toContain('>切り替え</button>');
    // The id input and the current id sit under 「詳細」.
    expect(textOutsideDetails(html)).not.toMatch(UUID);
  });

  it('without a selection the blank choice is the default', () => {
    const html = renderToString(<ProjectPicker action={action} choices={choices} currentProjectId={null} />);
    expect(html).toContain('<option value="" selected="">（選択なし）</option>');
  });

  it('source guard: the select is keyed by the project (B1) and every event goes through the intent rules (H1, B-M3, B-M4)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(path.join(repoRoot, 'apps/web/src/components/ProjectPicker.tsx'), 'utf8');
    // The remount after the refresh and the event wiring cannot be observed
    // in a server render; pin the lines that carry them. The rules themselves
    // are checked on the helper below.
    expect(source).toContain("key={currentProjectId ?? ''}");
    expect(source).toMatch(/if \(intent\.change\(event\.timeStamp\)\) submitIfChosen/);
    expect(source).toMatch(/if \(!intent\.keyDown\(event\.key\)\) return;/);
    expect(source).toMatch(/onPointerDown=\{[^}]*intent\.pointerDown\(event\.timeStamp\)/);
    expect(source).toMatch(/onBlur=\{\(\) => intent\.blur\(\)\}/);
    // UI batch C (review M3): a submit while a switch runs is dropped (the button is aria-disabled, not disabled).
    expect(source).toMatch(/onSubmit=\{\(event\) => \{[\s\S]*?if \(pending\) \{\s*event\.preventDefault\(\);\s*return;\s*\}\s*intent\.submitted\(\);/);
    expect(source).toMatch(/if \(intent\.settled\(state\)\) document\.getElementById\(MAIN_REGION_ID\)\?\.focus\(\{ preventScroll: true \}\)/);
    expect(source).not.toMatch(/pointerChoice/);
  });

  it('the focus target is the layout\'s main region: present, programmatically focusable, no ring (B-M3)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const layout = readFileSync(path.join(repoRoot, 'apps/web/src/app/layout.tsx'), 'utf8');
    const css = readFileSync(path.join(repoRoot, 'apps/web/src/app/globals.css'), 'utf8');
    expect(MAIN_REGION_ID).toBe('main');
    expect(layout).toMatch(new RegExp(`<main id="${MAIN_REGION_ID}" tabIndex=\\{-1\\}`));
    expect(css).toMatch(/main:focus-visible \{\s*outline: none;/);
  });
});

describe('② ProjectPicker intent rules (B-M3, B-M4)', () => {
  // Event timestamps in ms, as event.timeStamp gives them.
  it('pointer press → change: switches at once', () => {
    const intent = createProjectPickerIntent();
    intent.pointerDown(100);
    expect(intent.change(400)).toBe(true);
  });

  it('pointer press → blur → change (no pointer): does not switch', () => {
    const intent = createProjectPickerIntent();
    intent.pointerDown(100);
    intent.blur();
    expect(intent.change(400)).toBe(false);
  });

  it('pointer press → change → another change without a press: only the first switches', () => {
    const intent = createProjectPickerIntent();
    intent.pointerDown(100);
    expect(intent.change(400)).toBe(true);
    expect(intent.change(900)).toBe(false);
  });

  it('a change with no pointer press at all (virtual cursor, voice control): does not switch', () => {
    expect(createProjectPickerIntent().change(400)).toBe(false);
  });

  it('pointer press that changes nothing, then a much later change without a key press: does not switch', () => {
    const intent = createProjectPickerIntent();
    intent.pointerDown(100);
    expect(intent.change(100 + POINTER_PICK_WINDOW_MS + 1)).toBe(false);
    const inTime = createProjectPickerIntent();
    inTime.pointerDown(100);
    expect(inTime.change(100 + POINTER_PICK_WINDOW_MS)).toBe(true);
  });

  it('arrow keys only move the choice; Enter switches', () => {
    const intent = createProjectPickerIntent();
    expect(intent.keyDown('ArrowDown')).toBe(false);
    expect(intent.change(200)).toBe(false);
    expect(intent.keyDown('ArrowUp')).toBe(false);
    expect(intent.keyDown('Enter')).toBe(true);
  });

  it('a key press after a pointer press cancels the pointer pick', () => {
    const intent = createProjectPickerIntent();
    intent.pointerDown(100);
    expect(intent.keyDown('ArrowDown')).toBe(false);
    expect(intent.change(300)).toBe(false);
  });

  it('a new pointer press after a used one switches again', () => {
    const intent = createProjectPickerIntent();
    intent.pointerDown(100);
    expect(intent.change(200)).toBe(true);
    intent.pointerDown(5000);
    expect(intent.change(5200)).toBe(true);
  });

  it('focus moves only after a switch submitted here succeeded — never on load or after a refusal', () => {
    const intent = createProjectPickerIntent();
    // First render: no answer yet, nothing submitted.
    expect(intent.settled(null)).toBe(false);
    // An answer this picker did not ask for (no submit) does not move focus.
    expect(intent.settled({ ok: true })).toBe(false);
    intent.submitted();
    expect(intent.settled({ ok: false })).toBe(false);
    // The refusal used up that submit.
    expect(intent.settled({ ok: true })).toBe(false);
    intent.submitted();
    expect(intent.settled({ ok: true })).toBe(true);
    // Once only.
    expect(intent.settled({ ok: true })).toBe(false);
  });
});
