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
    : { id: USER_ID, role: sessionRole.current, displayName: '合成' })
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
const { transitionChoicesFor, EXCEPTION_GROUP_LABEL, RESUME_GROUP_LABEL, SKIP_AHEAD_GROUP_LABEL } = await import(
  '../apps/web/src/lib/transitions.js'
);
const { canRoleOperate, operationRefusal, ROLE_UNKNOWN_PAGE_NOTICE, VIEWER_PAGE_NOTICE } = await import(
  '../apps/web/src/lib/permissions.js'
);
const { ProjectPicker } = await import('../apps/web/src/components/ProjectPicker.js');
const { shortId } = await import('../apps/web/src/lib/short-id.js');
const { toMakerPoChoices } = await import('../apps/web/src/lib/document-maker-po.js');
const { default: OrdersPage } = await import('../apps/web/src/app/orders/page.js');
const { default: DocumentsPage } = await import('../apps/web/src/app/documents/page.js');
const { default: ApprovalsPage } = await import('../apps/web/src/app/approvals/page.js');
const { default: MakerPoPage } = await import('../apps/web/src/app/maker-po/page.js');
const { default: DeliveriesPage } = await import('../apps/web/src/app/deliveries/page.js');

type Role = 'admin' | 'staff' | 'viewer';
const ROLES: Role[] = ['admin', 'staff', 'viewer'];
const ALL_STATES = [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES] as FilmSupplyOrderState[];
const label = (key: string) => (FILM_SUPPLY_ORDER_STATUS_LABELS as Record<string, string>)[key] ?? key;

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

  it('viewer: every status withheld, no remembered state, all orders grouped as hidden', async () => {
    serveAs('viewer');
    const workspace = await loadWorkspace(PROJECT_ID);
    for (const order of workspace.filmOrders) {
      expect(order).toMatchObject({ statusHidden: true, lastNormalStatus: null });
    }
    const groups = groupOrdersForProgress(workspace.filmOrders);
    expect(groups).toMatchObject({ active: [], completed: [] });
    expect(groups.hidden).toHaveLength(6);
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
    ['staff', 'この操作は代表者が行います。'],
    ['viewer', '閲覧権限のため操作できません。']
  ] as const)('MAKER_PO_READY (%s): the representative creates and approves the maker PO', (role, refusal) => {
    const action = nextActionForOrder(order('MAKER_PO_READY'), workspace(), role);
    expect(action).toMatchObject({ owner: '代表者', screens: ['/maker-po'], operation: 'maker_po:create', refusal });
    expect(action.text).toBe('メーカー発注書を作成し、代表承認を記録する。');
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
      text: 'セブン化学発注書（SC-B-1）の公式登録日を記録する。', operation: 'seven_po:register', screens: ['/orders']
    });
    const unverified = { ...po, verificationStatus: null };
    expect(nextActionForOrder(order('DRAFT'), workspace([unverified]), 'admin')).toMatchObject({
      text: 'セブン化学発注書（SC-B-1）の真性行チェックリストを記録し、確認済みにする。', operation: 'seven_po:verify'
    });
    expect(nextActionForOrder(order('DRAFT'), workspace(), 'admin')).toMatchObject({
      text: `状態を「${label('SEVEN_PO_VERIFIED')}」へ進める。`, operation: 'film_order:transition', refusal: null
    });
    expect(nextActionForOrder(order('DRAFT', { sevenPurchaseOrderId: null }), workspace(), 'admin').text)
      .toContain('セブン化学発注書に紐付いていないため');
    // Staff do not read the order's PO link: the general step, never a guess.
    const general = nextActionForOrder(order('DRAFT', { detailsHidden: true, sevenPurchaseOrderId: null }), workspace(), 'staff');
    expect(general).toMatchObject({ operation: 'film_order:transition', refusal: null });
    expect(general.text).toBe(`セブン化学発注書の公式登録と真性行チェックリストを済ませ、状態を「${label('SEVEN_PO_VERIFIED')}」へ進める。`);
  });

  it('ARTWORK_RECEIVED: asks for the proof revision, but never claims it missing when revisions are withheld (L8)', () => {
    expect(nextActionForOrder(order('ARTWORK_RECEIVED'), workspace(), 'admin')).toMatchObject({
      text: `校正ゲラの版を承認画面で登録し、状態を「${label('PROOF_READY')}」へ進める。`,
      operation: 'artwork_revision:create', screens: ['/approvals', '/orders']
    });
    expect(nextActionForOrder(order('ARTWORK_RECEIVED'), workspace([po], 2), 'staff')).toMatchObject({
      text: `校正ゲラの版が承認画面に登録されていることを確かめて、状態を「${label('PROOF_READY')}」へ進める。`,
      operation: 'film_order:transition', refusal: null
    });
  });

  it.each(['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED'] as const)(
    'ON_HOLD after %s: says the left state cannot be named here (M1)',
    (left) => {
      const action = nextActionForOrder(order('ON_HOLD', { lastNormalStatus: left }), workspace(), 'staff');
      expect(action.text).toBe(
        `中断前の「${label(left)}」へはこの画面から戻せません。メーカー発注画面の記録で進めるか、代表者に相談してください。`
      );
      expect(action.screens).toEqual(['/maker-po', '/orders']);
    }
  );

  it('exception, terminal and withheld states', () => {
    expect(nextActionForOrder(order('ON_HOLD'), workspace(), 'staff')).toMatchObject({
      text: '再開する状態を選んで、状態を進める。', screens: ['/orders'], refusal: null
    });
    expect(nextActionForOrder(order('FILM_RECEIPT_ASSUMED_NO_ISSUE'), workspace(), 'admin')).toEqual({
      text: 'この発注は完了しています。', owner: null, screens: [], operation: null, refusal: null
    });
    const hidden = nextActionForOrder(order('DRAFT', { statusHidden: true }), workspace(), 'viewer');
    expect(hidden).toMatchObject({ owner: null, screens: [], refusal: '閲覧権限のため操作できません。' });
    expect(hidden.text).not.toContain('セブン化学発注書確認済');
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
    ARTWORK_RECEIVED: ['PROOF_READY', ...EX],
    PROOF_READY: ['APPROVAL_PENDING', ...EX],
    APPROVAL_PENDING: ['DUAL_APPROVED', ...EX],
    DUAL_APPROVED: ['MAKER_PO_READY', ...EX],
    MAKER_PO_READY: EX,
    APPROVED_FOR_MANUAL_SEND: EX,
    MAKER_PO_SENT_MANUALLY: EX,
    MAKER_PO_ACCEPTED: ['FILM_IN_PRODUCTION', ...EX],
    FILM_IN_PRODUCTION: ['FILM_SHIPPED', ...EX],
    FILM_SHIPPED: ['FILM_DELIVERED', ...EX],
    FILM_DELIVERED: EX,
    FILM_RECEIPT_ASSUMED_NO_ISSUE: [],
    ON_HOLD: ['APPROVAL_PENDING', 'DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY',
      'DUAL_APPROVED', 'MAKER_PO_READY', 'FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED'],
    CHANGE_REVIEW: ['APPROVAL_PENDING', 'ARTWORK_RECEIVED', 'PROOF_READY'],
    CANCELLATION_REVIEW: ['APPROVAL_PENDING', 'DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY',
      'DUAL_APPROVED', 'MAKER_PO_READY', 'FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED']
  };

  it.each(ALL_STATES)('%s: exactly the expected targets, each allowed by core; only maker-chain / terminal left out', (state) => {
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
    const offered = new Set(set.choices.map((choice) => choice.value));
    const leftOut = filmSupplyOrderTransitions(state).filter((to) => !offered.has(to));
    for (const to of leftOut) {
      expect(['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE'], `${state}→${to}`)
        .toContain(to);
    }
  });

  it('normal targets first; the exceptions grouped under 例外（保留・見直し）', () => {
    const set = transitionChoicesFor('PROOF_READY', label);
    expect(set.choices.map((choice) => [choice.value, choice.group ?? null])).toEqual([
      ['APPROVAL_PENDING', null],
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

  it('an exception resumes into the state it left first; later states sit apart under 先の段階へ進める（注意）', () => {
    const set = transitionChoicesFor('ON_HOLD', label, 'FILM_SHIPPED');
    expect(set.choices[0]).toEqual({ value: 'FILM_SHIPPED', label: label('FILM_SHIPPED'), group: RESUME_GROUP_LABEL });
    expect(set.choices.filter((choice) => choice.group === SKIP_AHEAD_GROUP_LABEL).map((choice) => choice.value))
      .toEqual(['FILM_DELIVERED']);
    expect(set.choices.filter((choice) => choice.group === RESUME_GROUP_LABEL)).toHaveLength(9);
    expect(set.choices.map((choice) => choice.value)).not.toContain('MAKER_PO_ACCEPTED');
    expect(set.resumeNotice).toBeNull();
    // Unknown left state: nothing is called ahead.
    expect(transitionChoicesFor('ON_HOLD', label, null).choices.every((choice) => choice.group === RESUME_GROUP_LABEL)).toBe(true);
    expect(transitionChoicesFor('CHANGE_REVIEW', label, 'PROOF_READY').choices.map((choice) => choice.value))
      .toEqual(['PROOF_READY', 'ARTWORK_RECEIVED', 'APPROVAL_PENDING']);
  });

  it('a hold left from the maker chain: a notice, earlier states to resume, later ones as a jump (M1)', () => {
    const set = transitionChoicesFor('ON_HOLD', label, 'MAKER_PO_SENT_MANUALLY');
    expect(set.resumeNotice).toBe(
      `中断前の「${label('MAKER_PO_SENT_MANUALLY')}」へはこの画面から戻せません。メーカー発注画面の記録で進めるか、代表者に相談してください。`
    );
    expect(set.choices.filter((choice) => choice.group === RESUME_GROUP_LABEL).map((choice) => choice.value))
      .toEqual(['DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY']);
    expect(set.choices.filter((choice) => choice.group === SKIP_AHEAD_GROUP_LABEL).map((choice) => choice.value))
      .toEqual(['FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED']);
    expect(transitionChoicesFor('ON_HOLD', label, 'APPROVAL_PENDING').resumeNotice).toBeNull();
  });

  it('APPROVAL_PENDING keeps the dual approval target with a hint; FILM_DELIVERED leaves the receipt to its own form', () => {
    const pending = transitionChoicesFor('APPROVAL_PENDING', label);
    expect(pending.choices[0]?.value).toBe('DUAL_APPROVED');
    expect(pending.hint).toBe(`「${label('DUAL_APPROVED')}」へは、通常は承認の記録で自動的に進みます。`);
    const delivered = transitionChoicesFor('FILM_DELIVERED', label);
    expect(delivered.choices.map((choice) => choice.value)).toEqual(['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW']);
    expect(delivered.hint).toBe('受領確認は下の「受領確認（問題なしとみなす）」で記録します。');
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
    for (const operation of ['ceo_approve', 'maker_po:create', 'maker_po:cancel', 'maker_po:accept_evidence', 'maker_po:verify_send', 'artwork_approval:verify_evidence'] as Operation[]) {
      expect(canRoleOperate('admin', operation), operation).toBe(true);
      expect(canRoleOperate('staff', operation), operation).toBe(false);
    }
    for (const operation of ['maker_po:send_evidence', 'maker_po:accept_provisional', 'film_order:transition', 'document:verify'] as Operation[]) {
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
    expect(operationRefusal('admin', 'maker_po:create')).toBeNull();
    expect(operationRefusal('staff', 'maker_po:create')).toBe('この操作は代表者が行います。');
    expect(operationRefusal('staff', 'maker_po:create', 'メーカー発注書の作成')).toBe('メーカー発注書の作成は代表者が行います。');
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
    })).toBe('発注番号 閲覧権限なし・ID …0000aa01（公式登録済み）');
  });
});

// ---------------------------------------------------------------------------
// Rendered screens per role (integration through the API's own role filter)
// ---------------------------------------------------------------------------

const FORM_MARKERS = {
  // 決済条件 (FSO-DRAFT) and 受領確認 (FSO-DELIV): both staff work, gated per role.
  orders: ['発注書を登録する', '状態を進める', '発注を作成する', '決済条件を記録する', '受領確認を記録する'],
  documents: ['書類をアップロードする', '確認を記録する'],
  approvals: ['版を登録する'],
  'maker-po': ['手動送信を記録する', '発注を作成する'],
  deliveries: ['準備状態を再評価する', '納品を記録する', '納品を確認する']
} as const;

/**
 * Representative-only forms (submit labels) and the screen they live on. The
 * approval decision (artwork_approval:record) is staff work — see the
 * dedicated staff test below; it is not listed here.
 */
const ADMIN_ONLY_FORMS = {
  'maker-po': ['メーカー発注書を作成する', '発注書を取り消す'],
  approvals: ['手動確認を記録する']
} as const;

describe('rendered screens: stepper, 次にやること and role-gated forms', () => {
  for (const page of PAGE_NAMES) {
    it(`${page} (viewer): no form at all, the read-only notice, and the progress without marks`, async () => {
      serveAs('viewer');
      const html = await renderPage(PAGES[page]);
      expect(html.match(/<form\b/g) ?? []).toHaveLength(0);
      expect(html).toContain(VIEWER_PAGE_NOTICE);
      expect(html).toMatch(/閲覧権限のため操作できません/);
      expect(html).toContain('class="stepper"');
      expect(html).not.toContain('aria-current="step"');
      expect(html).toContain('この役割では発注の状態は表示されません（閲覧権限なし）');
      expect(html).toContain('次にやること');
      // No 操作 column left without a form in it.
      expect(html).not.toContain('>操作</th>');
      expect(html).not.toContain('>確認を記録する</th>');
    });

    it(`${page} (staff): the allowed forms, never a representative-only one`, async () => {
      serveAs('staff');
      const html = await renderPage(PAGES[page]);
      for (const marker of FORM_MARKERS[page]) expect(html, marker).toContain(`>${marker}</button>`);
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

  it('viewer on maker-po: hidden statuses are never reported as 「no order yet」 (M2)', async () => {
    serveAs('viewer');
    const html = await renderPage(MakerPoPage);
    expect(html).toContain(`${STATUS_HIDDEN_NOTICE}。作成できる発注があるかどうかは表示できません。`);
    expect(html).toContain(`${STATUS_HIDDEN_NOTICE}。メーカー発注の作業対象になっている発注があるかどうかは、この画面に表示できません。`);
    expect(html).not.toContain('作成できる発注（');
    expect(html).not.toContain('作業対象の発注はまだありません');
  });

  it('maker-po (admin): a DRAFT order is not on the board, so no 決済条件 form here (L10)', async () => {
    serveAs('admin');
    const html = await renderPage(MakerPoPage);
    expect(html).not.toContain('フィルム発注 FSO-DRAFT');
    expect(html).not.toContain('>決済条件を記録する</button>');
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
    expect(html).toContain('メーカー発注書を作成し、代表承認を記録する。');
    expect(html).toContain('この操作は代表者が行います。');
    expect(html).toContain('メーカー発注書の作成は代表者が行います。');
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
      ['', 'APPROVAL_PENDING', 'DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', // FSO-HOLD
        'DUAL_APPROVED', 'MAKER_PO_READY', 'FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED'],
      ['', 'SEVEN_PO_VERIFIED', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'], // FSO-DRAFT
      ['', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'] // FSO-DELIV
    ]);
    for (const [whole, inner] of selects) {
      expect(whole).toMatch(/required/);
      expect(inner).toMatch(/^<option value="">（進める先を選ぶ）<\/option>/);
      expect(inner).not.toMatch(/selected/);
    }
    expect(html).toContain(`<optgroup label="${SKIP_AHEAD_GROUP_LABEL}">`);
    expect(html).toContain('受領確認は下の「受領確認（問題なしとみなす）」で記録します。');
    expect(html).toContain(`<optgroup label="${RESUME_GROUP_LABEL}"><option value="APPROVAL_PENDING">${label('APPROVAL_PENDING')}</option>`);
    expect(html).toContain(`<optgroup label="${EXCEPTION_GROUP_LABEL}">`);
    expect(html).toContain('次はメーカー発注画面の操作で進みます。');
    expect(html).toContain('この発注は完了しています。進める先はありません。');
    expect(html).toContain('メーカー発注画面を開く');
  });
});

describe('unselected project message', () => {
  it('is the same on all five screens', async () => {
    selectedProject.current = null;
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

  it('source guard: the select is keyed by the project (B1) and auto-submits only pointer choices (H1)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(path.join(repoRoot, 'apps/web/src/components/ProjectPicker.tsx'), 'utf8');
    // The remount after the refresh and the keyboard rule cannot be observed
    // in a server render; pin the two lines that carry them.
    expect(source).toContain("key={currentProjectId ?? ''}");
    expect(source).toMatch(/if \(pointerChoice\.current\) submitIfChosen/);
    expect(source).toMatch(/onKeyDown[\s\S]*pointerChoice\.current = false/);
  });
});
