import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  japaneseStatusSurface,
  MAKER_PURCHASE_ORDER_STATUSES
} from '@kanei/core';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';
import { projectScreen } from './helpers/project-screen.js';

/**
 * UI batch C, part 2 (screens): the maker-PO stage function, the status tone
 * table and badge, and the five screens rendered per role — table captions
 * and header scopes, the scroll regions, the folded /maker-po card (stages,
 * the one open current stage, done stages folded, the danger zone), the
 * confirmation markup on consequential forms, and the corrected wording.
 * Rendering reuses the batch B pattern: audit rows shaped by the API's own
 * buildAuditViewForRole, the web's API client mocked. Display only.
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
  loadSessionUser: async () => ({ id: USER_ID, role: sessionRole.current, displayName: '合成' }),
  loadSession: async () => ({ kind: 'user', user: ({ id: USER_ID, role: sessionRole.current, displayName: '合成' }) })
}));

const { makerPoStages, papersNewestFirst, paymentGateDecides, stageHeadline, stageLabel, upcomingStagesLine } = await import(
  '../apps/web/src/lib/maker-po-stage.js'
);
type StagePaper = Parameters<typeof makerPoStages>[0]['papers'][number];
const {
  DELIVERY_CONFIRMATION_TONES,
  FILM_ORDER_STATUS_TONES,
  MAKER_PO_STATUS_TONES,
  STATUS_TONES,
  statusTone,
  TONE_SYMBOLS,
  VERIFICATION_STATUS_TONES
} = await import('../apps/web/src/lib/status-tone.js');
const { StatusBadge } = await import('../apps/web/src/components/StatusBadge.js');
const { webErrorText } = await import('../apps/web/src/lib/error-dictionary.js');
const { DataTable } = await import('../apps/web/src/components/DataTable.js');
const { MAKER_PO_STATUS_LABELS } = await import('../apps/web/src/lib/maker-po-data.js');
const { VERIFICATION_STATUS_LABELS } = await import('../apps/web/src/lib/vocabulary.js');
const { HIDDEN_BY_ROLE_LABEL } = await import('../apps/web/src/lib/redaction.js');
const OrdersPage = projectScreen((await import('../apps/web/src/screens/OrdersScreen.js')).OrdersScreen);
const DocumentsPage = projectScreen((await import('../apps/web/src/screens/DocumentsScreen.js')).DocumentsScreen);
const ApprovalsPage = projectScreen((await import('../apps/web/src/screens/ApprovalsScreen.js')).ApprovalsScreen);
const MakerPoPage = projectScreen((await import('../apps/web/src/screens/MakerPoScreen.js')).MakerPoScreen);
const DeliveriesPage = projectScreen((await import('../apps/web/src/screens/DeliveriesScreen.js')).DeliveriesScreen);

type Role = 'admin' | 'staff' | 'viewer';
const ROLES: Role[] = ['admin', 'staff', 'viewer'];

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
const SEND_EVENT = '01a1ec60-0000-7000-8000-00000000cc09';
const REVISION_ID = '01a1ec60-0000-7000-8000-00000000dd01';
const APPROVAL_DOC = '01a1ec60-0000-7000-8000-00000000ee01';
const APPROVAL_VERSION = '01a1ec60-0000-7000-8000-00000000ee02';
const ACCEPT_DOC = '01a1ec60-0000-7000-8000-00000000ee03';
const ACCEPT_VERSION = '01a1ec60-0000-7000-8000-00000000ee04';
const DELIVERY_ID = '01a1ec60-0000-7000-8000-00000000ff01';
const PENDING_APPROVAL_EVENT = '01a1ec60-0000-7000-8000-00000000ff02';

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

const TO_READY = ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY'];
const READY_ROWS = filmOrder(ORDER_READY, 'FSO-READY', TO_READY);
const SEND_ROWS = filmOrder(ORDER_SEND, 'FSO-SEND', [...TO_READY, 'APPROVED_FOR_MANUAL_SEND']);
const BASE_ROWS: AuditHistoryRow[] = [
  auditRow('seven_purchase_order', 'SEVEN_PO_CREATED', PO_ID, {
    id: PO_ID, projectId: PROJECT_ID, poNumber: 'SC-C-1', officialRegisteredAt: '2026-11-16T00:00:00.000Z',
    verificationStatus: 'unverified'
  }),
  auditRow('seven_purchase_order', 'SEVEN_PO_VERIFICATION_RECORDED', PO_ID, {
    id: PO_ID, verificationStatus: 'verified', reviewPending: false
  }),
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
const ROWS = [...READY_ROWS, ...SEND_ROWS, ...BASE_ROWS];

const MAKER_PO_ROW = {
  id: MAKER_PO_SEND, filmSupplyOrderId: ORDER_SEND, status: 'APPROVED_FOR_MANUAL_SEND', orderCode: 'FSO-SEND',
  recipientAddress: 'maker@example.test', ceoApprovedAt: '2026-11-18T01:00:00.000Z',
  createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T01:00:00.000Z'
};

/** A send recorded by the EML check that it could not settle (PENDING_MANUAL_VERIFICATION). */
const PENDING_SEND_EVENT = {
  id: SEND_EVENT, eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'PENDING_MANUAL_VERIFICATION',
  verificationNote: '送信日時が代表承認より前です', sentAt: '2026-11-18T02:00:00.000Z',
  recordedAt: '2026-11-18T02:05:00.000Z', senderAddress: 'kanei@example.test', recipients: ['maker@example.test']
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

function serveAs(role: Role, rows: AuditHistoryRow[] = ROWS, sendEvents: unknown[] = []) {
  sessionRole.current = role;
  callApi.mockImplementation(async (apiPath: string) => {
    const ok = (data: unknown) => ({ ok: true, status: 200, error: null, data });
    if (apiPath === `/api/projects/${PROJECT_ID}`) {
      return ok({ id: PROJECT_ID, code: 'CMP-F1-C', name: '合成C', route: 'F1', status: 'ACTIVE' });
    }
    if (apiPath === '/api/status-labels') return ok(japaneseStatusSurface());
    if (apiPath.includes('/audit-history')) {
      const entityType = new URL(apiPath, 'http://x').searchParams.get('entityType');
      const selected = rows.filter((row) => row.entityType === entityType);
      return ok({ events: JSON.parse(JSON.stringify(buildAuditViewForRole(role, selected))) });
    }
    if (apiPath.endsWith('/payment-gate')) {
      return ok({ orderId: 'x', orderStatus: 'x', paymentTerms: 'prepaid', gate: { satisfied: true, code: null, reason: null }, paymentConfirmedAt: null });
    }
    if (apiPath === `/api/film-supply-orders/${ORDER_SEND}/maker-purchase-orders`) return ok({ makerPurchaseOrders: [MAKER_PO_ROW] });
    if (apiPath.endsWith('/maker-purchase-orders')) return ok({ makerPurchaseOrders: [] });
    if (apiPath === `/api/maker-purchase-orders/${MAKER_PO_SEND}`) return ok({ purchaseOrder: MAKER_PO_ROW, events: sendEvents });
    if (apiPath === `/api/film-supply-orders/${ORDER_HOLD}/approval-gate`) return ok(approvalGate(role));
    return { ok: false, status: 404, error: 'not served in this test', data: null };
  });
}

async function renderPage(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

/** The markup of the first element opened by `open` (balanced on its tag name). */
function elementAt(html: string, open: string): string {
  const start = html.indexOf(open);
  if (start < 0) return '';
  const tag = /^<([a-z]+)/.exec(open)![1]!;
  const pattern = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  pattern.lastIndex = start + 1;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  return html.slice(start);
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
// 2-④ maker-po-stage: the stage table
// ---------------------------------------------------------------------------

function paper(
  status: string,
  options: Partial<Omit<StagePaper, 'po'>> & { ceoApprovedAt?: string | null; id?: string; createdAt?: string } = {}
): StagePaper {
  return {
    po: {
      id: options.id ?? '01a1ec60-0000-7000-8000-0000000000p1',
      status,
      ceoApprovedAt: options.ceoApprovedAt === undefined ? '2026-11-18T01:00:00.000Z' : options.ceoApprovedAt,
      createdAt: options.createdAt ?? '2026-11-18T00:00:00.000Z'
    },
    events: options.events ?? [],
    pendingVerification: options.pendingVerification ?? false,
    confirmedVerification: options.confirmedVerification ?? null
  };
}

/** key → state, written out per case (independent of the implementation). */
const states = (view: ReturnType<typeof makerPoStages>) =>
  Object.fromEntries(view.stages.map((stage) => [stage.key, stage.state]));

const SENT_EVENT = { id: 'e1', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'VERIFIED', sentAt: '2026-11-18T02:00:00.000Z' };
const ACCEPT_EVENT = { id: 'e2', eventType: 'ACCEPT_EVIDENCE_REGISTERED', recordedAt: '2026-11-18T05:00:00.000Z' };
const PENDING_EVENT = { id: 'e3', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'PENDING_MANUAL_VERIFICATION', sentAt: '2026-11-18T02:00:00.000Z' };
const CONFIRMED = {
  makerPoEventId: 'e3', result: 'confirmed' as const, verifierName: '合成代表者',
  verifiedAt: '2026-11-18T04:00:00.000Z', reasonNote: '原本を確認', recordedAt: '2026-11-18T04:01:00.000Z'
};

describe('2-④ maker-po stages: status × (pending check, events) → done / current / upcoming / skipped', () => {
  it('no paper yet: ① is current, everything else upcoming, no ③′', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [] });
    expect(states(view)).toEqual({ create: 'current', approve: 'upcoming', send: 'upcoming', accept: 'upcoming', complete: 'upcoming' });
    expect(view.current?.key).toBe('create');
    expect(view).toMatchObject({ condition: 'normal', primaryPoId: null, cancelledPapers: [] });
  });

  it('a withheld order status with no paper still starts at ①', () => {
    expect(makerPoStages({ orderStatus: null, papers: [] }).current?.key).toBe('create');
  });

  it('DRAFT: ① done with its JST summary, ② current', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('DRAFT', { ceoApprovedAt: null })] });
    expect(states(view)).toEqual({ create: 'done', approve: 'current', send: 'upcoming', accept: 'upcoming', complete: 'upcoming' });
    expect(view.stages[0]!.summary).toBe('発注書 …000000p1 を作成（2026/11/18 09:00 JST）');
    expect(upcomingStagesLine(view)).toBe('このあと: 手順3: 送信の記録 → 手順4: 受入 → 完了');
  });

  it('SNAPSHOT_VOIDED: ② current again, flagged for attention', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('SNAPSHOT_VOIDED')] });
    expect(view.current?.key).toBe('approve');
    expect(view.condition).toBe('attention');
  });

  it('APPROVED_FOR_MANUAL_SEND without a pending check: ③ current, ② done with the approval time, no ③′', () => {
    const view = makerPoStages({ orderStatus: 'APPROVED_FOR_MANUAL_SEND', papers: [paper('APPROVED_FOR_MANUAL_SEND')] });
    expect(states(view)).toEqual({ create: 'done', approve: 'done', send: 'current', accept: 'upcoming', complete: 'upcoming' });
    expect(view.stages[1]!.summary).toBe('代表承認（2026/11/18 10:00:00 JST）');
    expect(view.stages.map((stage) => stage.key)).not.toContain('verify');
  });

  it('APPROVED_FOR_MANUAL_SEND with a send waiting for the manual check: ③′ is the current stage (2-⑦)', () => {
    const view = makerPoStages({
      orderStatus: 'APPROVED_FOR_MANUAL_SEND',
      papers: [paper('APPROVED_FOR_MANUAL_SEND', { events: [PENDING_EVENT], pendingVerification: true })]
    });
    expect(states(view)).toEqual({
      create: 'done', approve: 'done', send: 'done', verify: 'current', accept: 'upcoming', complete: 'upcoming'
    });
    expect(stageLabel(view.current!)).toBe('手順3の確認: 送信の手動確認');
    expect(view.stages[2]!.summary).toBe('送信の記録（送信日時 2026/11/18 11:00:00 JST）');
    expect(upcomingStagesLine(view)).toBe('このあと: 手順4: 受入 → 完了');
  });

  it('SEND_UNVERIFIED: ③ is where the paper stopped (halted)', () => {
    const view = makerPoStages({ orderStatus: 'APPROVED_FOR_MANUAL_SEND', papers: [paper('SEND_UNVERIFIED', { events: [SENT_EVENT] })] });
    expect(view.current?.key).toBe('send');
    expect(view.condition).toBe('halted');
  });

  it('MAKER_PO_SENT_MANUALLY after an automatic check: ④ current, no ③′', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_SENT_MANUALLY', papers: [paper('MAKER_PO_SENT_MANUALLY', { events: [SENT_EVENT] })] });
    expect(states(view)).toEqual({ create: 'done', approve: 'done', send: 'done', accept: 'current', complete: 'upcoming' });
  });

  it('MAKER_PO_SENT_MANUALLY after the representative confirmed the send: ③′ done with who and when', () => {
    const view = makerPoStages({
      orderStatus: 'MAKER_PO_SENT_MANUALLY',
      papers: [paper('MAKER_PO_SENT_MANUALLY', { events: [PENDING_EVENT], confirmedVerification: CONFIRMED })]
    });
    expect(states(view)).toMatchObject({ send: 'done', verify: 'done', accept: 'current' });
    expect(view.stages.find((stage) => stage.key === 'verify')!.summary).toBe('手動確認: 確認（合成代表者／2026/11/18 13:00 JST）');
  });

  it('MAKER_PO_ACCEPTED: every stage done, no current stage, complete', () => {
    const view = makerPoStages({
      orderStatus: 'MAKER_PO_ACCEPTED',
      papers: [paper('MAKER_PO_ACCEPTED', { events: [SENT_EVENT, ACCEPT_EVENT] })]
    });
    expect(Object.values(states(view)).every((state) => state === 'done')).toBe(true);
    expect(view.current).toBeNull();
    expect(view.condition).toBe('complete');
    expect(view.stages.find((stage) => stage.key === 'accept')!.summary).toBe('最終受入確認（2026/11/18 14:00 JST）');
    expect(upcomingStagesLine(view)).toBeNull();
  });

  it('an order past the maker acceptance is complete even when no paper is visible', () => {
    const view = makerPoStages({ orderStatus: 'FILM_IN_PRODUCTION', papers: [] });
    expect(view.condition).toBe('complete');
    expect(view.current).toBeNull();
    expect(Object.values(states(view)).every((state) => state === 'done')).toBe(true);
  });

  it('CANCELLED before any send: what it reached is done, the rest skipped, nothing current (halted)', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('CANCELLED')] });
    expect(states(view)).toEqual({ create: 'done', approve: 'done', send: 'skipped', accept: 'skipped', complete: 'skipped' });
    expect(view.current).toBeNull();
    expect(view.condition).toBe('halted');
  });

  it('CANCELLED unapproved paper: ② is skipped too', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('CANCELLED', { ceoApprovedAt: null })] });
    expect(states(view)).toMatchObject({ create: 'done', approve: 'skipped' });
  });

  // Review M2: GET …/maker-purchase-orders lists the papers newest first
  // (apps/api orderBy createdAt desc), so every fixture below is in API order.
  it('a cancelled paper replaced by a new one (API order: newest first): the stages follow the new paper, the old one is one history line', () => {
    const replacement = paper('DRAFT', {
      id: '01a1ec60-0000-7000-8000-0000000000d1', ceoApprovedAt: null, createdAt: '2026-11-18T04:00:00.000Z'
    });
    const cancelled = paper('CANCELLED', {
      id: '01a1ec60-0000-7000-8000-0000000000c1',
      createdAt: '2026-11-18T00:00:00.000Z',
      events: [{ id: 'x', eventType: 'MAKER_PO_CANCELLED', recordedAt: '2026-11-18T03:00:00.000Z' }]
    });
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [replacement, cancelled] });
    expect(view.primaryPoId).toBe(replacement.po.id);
    expect(view.current?.key).toBe('approve');
    expect(view.cancelledPapers).toEqual(['取り消した発注書 …000000c1（取消 2026/11/18 12:00 JST）']);
  });

  it('every paper cancelled (cancel → recreate → cancel, newest first): the stages describe the NEWEST paper', () => {
    const newest = paper('CANCELLED', {
      id: '01a1ec60-0000-7000-8000-0000000000c3',
      createdAt: '2026-11-18T06:00:00.000Z',
      ceoApprovedAt: null,
      events: [{ id: 'c3', eventType: 'MAKER_PO_CANCELLED', recordedAt: '2026-11-18T07:00:00.000Z' }]
    });
    const middle = paper('CANCELLED', {
      id: '01a1ec60-0000-7000-8000-0000000000c2',
      createdAt: '2026-11-18T03:00:00.000Z',
      events: [{ id: 'c2', eventType: 'MAKER_PO_CANCELLED', recordedAt: '2026-11-18T04:00:00.000Z' }]
    });
    const oldest = paper('CANCELLED', {
      id: '01a1ec60-0000-7000-8000-0000000000c1',
      createdAt: '2026-11-18T00:00:00.000Z',
      events: [
        SENT_EVENT,
        { id: 'c1', eventType: 'MAKER_PO_CANCELLED', recordedAt: '2026-11-18T01:00:00.000Z' }
      ]
    });
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [newest, middle, oldest] });
    expect(view.primaryPoId).toBe(newest.po.id);
    // The newest paper was never approved nor sent (the oldest was): ② ③ skipped.
    expect(states(view)).toEqual({ create: 'done', approve: 'skipped', send: 'skipped', accept: 'skipped', complete: 'skipped' });
    expect(view.condition).toBe('halted');
    expect(view.cancelledPapers).toEqual([
      '取り消した発注書 …000000c2（取消 2026/11/18 13:00 JST）',
      '取り消した発注書 …000000c1（取消 2026/11/18 10:00 JST）'
    ]);
  });

  it('createdAt decides even when a caller passes the papers oldest first', () => {
    const older = paper('CANCELLED', { id: '01a1ec60-0000-7000-8000-0000000000c1', createdAt: '2026-11-17T00:00:00.000Z' });
    const newer = paper('CANCELLED', { id: '01a1ec60-0000-7000-8000-0000000000c2', createdAt: '2026-11-18T00:00:00.000Z' });
    expect(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [older, newer] }).primaryPoId).toBe(newer.po.id);
    expect(papersNewestFirst([older, newer]).map((entry) => entry.po.id)).toEqual([newer.po.id, older.po.id]);
  });

  it('a missing or unreadable createdAt falls back to the API order (newest first), after the dated papers', () => {
    const undatedFirst = paper('CANCELLED', { id: '01a1ec60-0000-7000-8000-0000000000u1' });
    delete (undatedFirst.po as { createdAt?: string }).createdAt;
    const undatedSecond = paper('CANCELLED', { id: '01a1ec60-0000-7000-8000-0000000000u2' });
    undatedSecond.po.createdAt = 'not a date';
    expect(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [undatedFirst, undatedSecond] }).primaryPoId)
      .toBe(undatedFirst.po.id);
    const dated = paper('CANCELLED', { id: '01a1ec60-0000-7000-8000-0000000000d9', createdAt: '2026-11-01T00:00:00.000Z' });
    expect(papersNewestFirst([undatedFirst, dated, undatedSecond]).map((entry) => entry.po.id))
      .toEqual([dated.po.id, undatedFirst.po.id, undatedSecond.po.id]);
    // A live paper still wins over a newer cancelled one.
    const live = paper('DRAFT', { id: '01a1ec60-0000-7000-8000-0000000000l1', createdAt: '2026-11-01T00:00:00.000Z' });
    const newerCancelled = paper('CANCELLED', { id: '01a1ec60-0000-7000-8000-0000000000c9', createdAt: '2026-11-02T00:00:00.000Z' });
    expect(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [newerCancelled, live] }).primaryPoId).toBe(live.po.id);
  });

  it('a status outside the table claims nothing past ①', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('SOMETHING_NEW')] });
    expect(states(view)).toMatchObject({ create: 'done', approve: 'upcoming' });
    expect(view.current).toBeNull();
    expect(view.condition).toBe('attention');
  });

  it('the 「いまの段階」 headline: current stage, complete, all cancelled, and a neutral text for an unknown status (review L4)', () => {
    expect(stageHeadline(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('DRAFT')] }))).toBe('手順2: 代表承認');
    expect(stageHeadline(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('MAKER_PO_ACCEPTED')] })))
      .toBe('完了（受入確認済み）');
    expect(stageHeadline(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('CANCELLED')] })))
      .toBe('取り消し済み（新しい発注書の作成待ち）');
    const unknown = stageHeadline(makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [paper('SOMETHING_NEW')] }));
    expect(unknown).toBe('状態を確認できません');
    expect(unknown).not.toContain('取り消し');
  });

  it('the G6 box is large at ① / ②, when every paper is cancelled (back to ①) and for an unknown status; small afterwards (review M1)', () => {
    const decides = (papers: StagePaper[], orderStatus = 'MAKER_PO_READY') =>
      paymentGateDecides(makerPoStages({ orderStatus, papers }));
    expect(decides([])).toBe(true); // ①
    expect(decides([paper('DRAFT')])).toBe(true); // ②
    expect(decides([paper('SNAPSHOT_VOIDED')])).toBe(true); // ② again
    expect(decides([paper('CANCELLED'), paper('CANCELLED', { id: '01a1ec60-0000-7000-8000-0000000000c2' })])).toBe(true);
    expect(decides([paper('SOMETHING_NEW')])).toBe(true);
    expect(decides([paper('APPROVED_FOR_MANUAL_SEND')])).toBe(false); // ③
    expect(decides([paper('APPROVED_FOR_MANUAL_SEND', { pendingVerification: true })])).toBe(false); // ③′
    expect(decides([paper('SEND_UNVERIFIED')])).toBe(false);
    expect(decides([paper('MAKER_PO_SENT_MANUALLY')])).toBe(false); // ④
    expect(decides([paper('MAKER_PO_ACCEPTED')])).toBe(false); // complete
    expect(decides([], 'FILM_IN_PRODUCTION')).toBe(false); // past the acceptance
  });

  it.each(MAKER_PURCHASE_ORDER_STATUSES)('%s: at most one current stage, stages in business order', (status) => {
    for (const pendingVerification of [false, true]) {
      const view = makerPoStages({
        orderStatus: 'MAKER_PO_READY',
        papers: [paper(status, { pendingVerification, events: pendingVerification ? [PENDING_EVENT] : [] })]
      });
      expect(view.stages.filter((stage) => stage.state === 'current').length).toBeLessThanOrEqual(1);
      const keys = view.stages.map((stage) => stage.key);
      expect(keys[0]).toBe('create');
      expect(keys[keys.length - 1]).toBe('complete');
      expect(['create', 'approve', 'send', 'verify', 'accept', 'complete'].filter((key) => keys.includes(key as never)))
        .toEqual(keys);
      // A done stage always says what was recorded.
      for (const stage of view.stages) if (stage.state === 'done' && stage.key !== 'complete') expect(stage.summary).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 2-⑤ status tones and the badge
// ---------------------------------------------------------------------------

describe('2-⑤ status tone table', () => {
  it('maps all 17 core film order states and CANCELLED (取消終了) — none missing, none extra', () => {
    const core = [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES].sort();
    expect(core).toHaveLength(17);
    // UI batch D: a cancellation review resolved as cancel ends the order in CANCELLED (core FILM_ORDER_CANCELLATION_STATE).
    expect(Object.keys(FILM_ORDER_STATUS_TONES).sort()).toEqual([...core, 'CANCELLED'].sort());
  });

  it('maps every maker PO status: the web label keys and the core vocabulary', () => {
    expect(Object.keys(MAKER_PO_STATUS_TONES).sort()).toEqual(Object.keys(MAKER_PO_STATUS_LABELS).sort());
    expect(Object.keys(MAKER_PO_STATUS_TONES).sort()).toEqual([...MAKER_PURCHASE_ORDER_STATUSES].sort());
    expect(Object.keys(VERIFICATION_STATUS_TONES).sort()).toEqual(Object.keys(VERIFICATION_STATUS_LABELS).sort());
    expect(Object.keys(DELIVERY_CONFIRMATION_TONES).sort()).toEqual(['CONFIRMED', 'PENDING_CONFIRMATION']);
  });

  it('a few anchors: finished, waiting, stopped', () => {
    expect(statusTone('filmOrder', 'FILM_RECEIPT_ASSUMED_NO_ISSUE')).toBe('done');
    expect(statusTone('filmOrder', 'ON_HOLD')).toBe('blocked');
    expect(statusTone('makerPo', 'MAKER_PO_ACCEPTED')).toBe('done');
    expect(statusTone('makerPo', 'SEND_UNVERIFIED')).toBe('blocked');
    expect(statusTone('makerPo', 'CANCELLED')).toBe('blocked');
    expect(statusTone('verification', 'mismatch')).toBe('blocked');
    expect(statusTone('deliveryConfirmation', 'PENDING_CONFIRMATION')).toBe('waiting');
  });

  it('an unknown value is neutral; a withheld one (null) is hidden; object keys are not states', () => {
    expect(statusTone('filmOrder', 'SOMETHING_NEW')).toBe('neutral');
    expect(statusTone('makerPo', 'toString')).toBe('neutral');
    expect(statusTone('verification', '')).toBe('neutral');
    expect(statusTone('makerPo', null)).toBe('hidden');
    expect(statusTone('makerPo', undefined)).toBe('hidden');
  });

  it('every tone carries its own written symbol — never colour alone', () => {
    const symbols = STATUS_TONES.map((tone) => TONE_SYMBOLS[tone]);
    expect(STATUS_TONES).toEqual(['done', 'active', 'waiting', 'blocked', 'neutral', 'hidden']);
    for (const symbol of symbols) expect(symbol.trim().length).toBeGreaterThan(0);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});

describe('2-⑤ StatusBadge and DataTable markup', () => {
  it('symbol (aria-hidden) + Japanese label, tone class, never the stored code', () => {
    const html = renderToString(<StatusBadge domain="makerPo" status="SEND_UNVERIFIED" label="送信未確認（要対応）" />);
    expect(html).toBe(
      '<span class="status-badge status-badge--blocked"><span class="status-badge-mark" aria-hidden="true">✕</span>送信未確認（要対応）</span>'
    );
    expect(html).not.toContain('SEND_UNVERIFIED');
  });

  it('a withheld status reads 閲覧権限なし in the hidden tone', () => {
    const html = renderToString(<StatusBadge domain="filmOrder" status={null} />);
    expect(html).toContain('status-badge--hidden');
    expect(html).toContain(`—</span>${HIDDEN_BY_ROLE_LABEL}`);
  });

  it('an unknown status falls back to neutral with the given label', () => {
    expect(renderToString(<StatusBadge domain="filmOrder" status="NEW_STATE" label="NEW_STATE" />))
      .toContain('status-badge--neutral');
  });

  it('DataTable: a focusable scroll region named by the caption; hidden caption on request', () => {
    const html = renderToString(<DataTable caption="納品の一覧" captionHidden><tbody><tr><td>1</td></tr></tbody></DataTable>);
    expect(html).toMatch(/^<div class="table-scroll" role="region" aria-label="納品の一覧" tabindex="0"><table/);
    expect(html).toContain('<caption class="visually-hidden">納品の一覧</caption>');
    expect(renderToString(<DataTable caption="記録"><tbody /></DataTable>)).toContain('<caption class="table-caption">記録</caption>');
  });
});

// ---------------------------------------------------------------------------
// Rendered screens per role
// ---------------------------------------------------------------------------

/** Consequential forms per screen: the confirmation title each must carry (admin). */
/**
 * P4 web2a §0: the lists only read — the consequential forms (and their dialogs) moved to the
 * order screen; their dialogs are pinned there (tests/web-p4-web2a.test.tsx, 「その他の操作」).
 */
const CONFIRM_TITLES: Record<keyof typeof PAGES, string[]> = {
  orders: [],
  documents: [],
  approvals: [],
  'maker-po': [],
  deliveries: []
};
const MOVED_DIALOG_TITLES: Record<keyof typeof PAGES, string[]> = {
  orders: ['発注の状態を変更しますか？', '問題なしで完了を記録しますか？'],
  documents: ['書類の確認結果を記録しますか？'],
  approvals: ['承認証跡の手動確認を記録しますか？'],
  'maker-po': ['メーカー発注書を作成しますか？', 'を取り消しますか？'],
  deliveries: ['納品を確認済みにしますか？']
};

describe('2-⑤ tables: caption, header scope, scroll region (5 screens × 3 roles)', () => {
  for (const page of PAGE_NAMES) {
    it.each(ROLES)(`${page} (%s)`, async (role) => {
      serveAs(role);
      const html = await renderPage(PAGES[page]);
      const tables = html.match(/<table\b/g) ?? [];
      // The viewer reads no approval gate (revisions withheld), so approvals shows no table to it.
      if (!(page === 'approvals' && role === 'viewer')) expect(tables.length, 'a table to check').toBeGreaterThan(0);
      expect(html.match(/<table\b[^>]*><caption\b/g) ?? []).toHaveLength(tables.length);
      const headers = html.match(/<th\b/g) ?? [];
      expect(html.match(/<th\b[^>]*\bscope="(col|row)"/g) ?? []).toHaveLength(headers.length);
      expect(html.match(/<div class="table-scroll" role="region" aria-label="[^"]+" tabindex="0"(?: data-cards="true")?><table/g) ?? [])
        .toHaveLength(tables.length);
      // The old ad-hoc badge style is gone; badges carry a symbol.
      expect(html).not.toMatch(/border-radius:999px/);
      // P4 M12: the list tables of orders / documents / deliveries turn into cards at 390px — every
      // cell of such a table names its column (data-label), so the card reads without the header.
      if (page === 'orders' || page === 'documents' || page === 'deliveries') {
        const cardTables = [...html.matchAll(/<div class="table-scroll"[^>]*data-cards="true"><table[^>]*class="ui-table--cards"[\s\S]*?<\/table>/g)].map(([whole]) => whole);
        expect(cardTables.length, 'a card table').toBeGreaterThan(0);
        for (const table of cardTables) {
          const cells = table.match(/<td\b[^>]*>/g) ?? [];
          expect(cells.length).toBeGreaterThan(0);
          for (const cell of cells) expect(cell).toMatch(/data-label="[^"]+"/);
        }
      }
      // P4 L5: an order code cell never wraps and is not translated.
      if (page === 'orders') expect(html).toMatch(role === 'viewer' ? /<td class="ui-td p4-nowrap" data-label="発注コード" translate="no">/ : /<td class="ui-td p4-nowrap" data-label="発注コード" translate="no">FSO-READY/);
    });
  }
});

describe('confirmation markup and viewer forms', () => {
  for (const page of PAGE_NAMES) {
    it(`${page} (admin): consequential forms carry a <dialog> with its title and キャンセル`, async () => {
      serveAs('admin');
      const html = await renderPage(PAGES[page]);
      for (const title of MOVED_DIALOG_TITLES[page]) expect(html, title).not.toContain(title);
      for (const title of CONFIRM_TITLES[page]) {
        const dialog = [...html.matchAll(/<dialog\b[\s\S]*?<\/dialog>/g)].map(([whole]) => whole).find((whole) => whole.includes(title));
        expect(dialog, title).toBeDefined();
        expect(dialog).toMatch(/aria-labelledby="[^"]+"/);
        expect(dialog).toContain('>キャンセル</button>');
      }
    });

    it(`${page} (viewer): still no form at all`, async () => {
      serveAs('viewer');
      const html = await renderPage(PAGES[page]);
      expect(html.match(/<form\b/g) ?? []).toHaveLength(0);
      expect(html).not.toContain('<dialog');
    });
  }

  it('maker-po: the cancellation confirmation and its submit button are danger-toned — in the order screen\'s 「その他の操作」 (P4 §0)', async () => {
    serveAs('admin');
    const { loadMakerPoBoard } = await import('../apps/web/src/lib/maker-po-data.js');
    const { loadOrderMakerPaperWork, OrderMakerPaperWork } = await import('../apps/web/src/screens/MakerPoScreen.js');
    const board = await loadMakerPoBoard(PROJECT_ID);
    const entry = board.boards.find((candidate) => candidate.order.id === ORDER_SEND)!;
    const work = await loadOrderMakerPaperWork(PROJECT_ID, entry, 'admin', board.workspace.documents);
    expect(work).not.toBeNull();
    const html = renderToString(<OrderMakerPaperWork work={work!} />).replaceAll('<!-- -->', '');
    expect(html).toMatch(/<dialog class="confirm-dialog confirm-dialog--danger"[^>]*>[\s\S]*?を取り消しますか？/);
    expect(html).toContain('この発注書は未送信です。');
    // The list itself draws no cancellation form.
    expect(await renderPage(MakerPoPage)).not.toContain('を取り消しますか？');
    // Staff are never offered it (maker_po:cancel is the representative's).
    expect(await loadOrderMakerPaperWork(PROJECT_ID, entry, 'staff', board.workspace.documents)).toBeNull();
  });
});

describe('2-④ /maker-po card: stages, one open current stage, folded history, danger zone', () => {
  it.each(['admin', 'staff'] as const)('%s: each order on the board has a named stage list with a current stage', async (role) => {
    serveAs(role);
    const html = await renderPage(MakerPoPage);
    const lists = [...html.matchAll(/<ol class="stepper" aria-label="メーカー発注の段階">([\s\S]*?)<\/ol>/g)];
    // FSO-READY, FSO-SEND, then FSO-DONE and FSO-DELIV (past the maker acceptance).
    expect(lists).toHaveLength(4);
    expect(lists.map(([, inner]) => (inner!.match(/aria-current="step"/g) ?? []).length)).toEqual([1, 1, 0, 0]);
    expect(lists[2]![1]!.match(/step-mark">済</g) ?? []).toHaveLength(5);
    // FSO-SEND: ① ② done, ③ now, then ④ and 完了.
    const send = lists[1]![1]!;
    expect(send).toContain('<li class="step step--current" aria-current="step"><span class="step-mark">いま</span><span class="step-label">送信の記録</span></li>');
    expect(send.match(/step-mark">済</g) ?? []).toHaveLength(2);
    expect(html).toContain('<p class="stage-next">このあと: 手順4: 受入 → 完了</p>');
    expect(html).toContain('<span class="stage-now">いまの段階</span><strong>手順3: 送信の記録</strong>');
  });

  it('admin: the done stages are folded in one closed <details> with one line each', async () => {
    serveAs('admin');
    const html = await renderPage(MakerPoPage);
    const done = elementAt(html, '<details class="stage-done">');
    expect(done).toContain('<summary>済んだ段階（2件）</summary>');
    expect(done).toContain('<li>手順1: 発注書の作成: 発注書 …0000cc01 を作成（2026/11/18 09:00 JST）</li>');
    expect(done).toContain('<li>手順2: 代表承認: 代表承認（2026/11/18 10:00:00 JST）</li>');
  });

  it('admin: the 支払条件 box is large only before the approval; after it, one line', async () => {
    serveAs('admin');
    const html = await renderPage(MakerPoPage);
    expect(html.match(/<strong>支払条件の状態: <\/strong>/g) ?? []).toHaveLength(1); // FSO-READY (①)
    expect(html.match(/<p class="gate-line">/g) ?? []).toHaveLength(3); // FSO-SEND (③), FSO-DONE, FSO-DELIV
    expect(html).not.toContain('檢証');
    expect(html).not.toContain('現在はまだ記録操作がありません');
    expect(html).toContain('入金確認の記録はこの画面ではできません');
  });

  it('admin, review M1: an unmet gate keeps the badge short (the reason is wrapping text), and an all-cancelled order shows the large box again', async () => {
    serveAs('admin');
    const base = callApi.getMockImplementation()!;
    const reason = '支払条件が未確定のため承認できません。取引条件を前払いか搬入時払いに設定してから代表承認してください。';
    callApi.mockImplementation(async (apiPath: string, ...rest: unknown[]) => {
      if (apiPath.endsWith('/payment-gate')) {
        return {
          ok: true, status: 200, error: null,
          data: { orderId: 'x', orderStatus: 'x', paymentTerms: 'undetermined', gate: { satisfied: false, code: 'PAYMENT_GATE_UNSATISFIED', reason }, paymentConfirmedAt: null }
        };
      }
      const cancelledRow = { ...MAKER_PO_ROW, status: 'CANCELLED' };
      if (apiPath === `/api/film-supply-orders/${ORDER_SEND}/maker-purchase-orders`) {
        return { ok: true, status: 200, error: null, data: { makerPurchaseOrders: [cancelledRow] } };
      }
      if (apiPath === `/api/maker-purchase-orders/${MAKER_PO_SEND}`) {
        return { ok: true, status: 200, error: null, data: { purchaseOrder: cancelledRow, events: [] } };
      }
      return (base as (...args: unknown[]) => unknown)(apiPath, ...rest);
    });
    const html = await renderPage(MakerPoPage);
    // FSO-READY (①) and FSO-SEND (every paper cancelled → ① again) take the large box.
    expect(html.match(/<strong>支払条件の状態: <\/strong>/g) ?? []).toHaveLength(2);
    expect(html).toContain('<span class="stage-now">いまの段階</span><strong>取り消し済み（新しい発注書の作成待ち）</strong>');
    // The one-line form (orders past the acceptance): a short nowrap badge, then the reason as ordinary text.
    const lines = [...html.matchAll(/<p class="gate-line">([\s\S]*?)<\/p>/g)].map(([, inner]) => inner!);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.match(/class="status-badge /g) ?? []).toHaveLength(1);
      expect(line).toContain('<span class="status-badge-mark" aria-hidden="true">✕</span>満たしていません</span>');
      // P0 R09: the API's own reason is never shown; the dictionary sentence of the gate code is.
      expect(line).toContain(`<span class="gate-line-reason">（${webErrorText('PAYMENT_GATE_UNSATISFIED').message}）</span>`);
      expect(line).not.toContain(reason);
    }
  });

  it('admin: the cancellation is named and linked to the order screen (no form on the list); staff has none (P4 §0)', async () => {
    serveAs('admin');
    const admin = await renderPage(MakerPoPage);
    expect(admin).not.toContain('danger-zone');
    expect(admin).not.toContain('>発注書を取り消す</button>');
    expect(admin).toContain('取り消し・取り消し承認の操作があります。');
    expect(admin).toMatch(/href="\/p\/TEST-P\/o\/FSO-SEND">発注の画面の「その他の操作」で記録する（代表者のみ）/);
    serveAs('staff');
    const staff = await renderPage(MakerPoPage);
    expect(staff).not.toContain('danger-zone');
    expect(staff).not.toContain('取り消し・取り消し承認の操作があります。');
  });

  it('the new film order card and the audit dashboard are folded (closed <details>)', async () => {
    serveAs('admin');
    const html = await renderPage(MakerPoPage);
    // P4 §0: a new order is registered in the wizard — a link, not a folded form.
    expect(html).toMatch(/<a href="\/p\/TEST-P\/new">新しいフィルム発注を登録する<\/a>/);
    expect(html).toMatch(/<details class="collapsed-card[^"]*"[^>]*><summary><h2[^>]*>監査ダッシュボード（役割に応じた表示）— 1件<\/h2><\/summary>/);
    expect(html).not.toContain('<h2 style="font-size:20px;margin:0 0 4px">支払条件を設定して発注を作成する</h2>');
    expect(html).not.toMatch(/<details class="collapsed-card[^"]*"[^>]* open/);
  });

  it('a send waiting for the manual check: ③′ is current, with the corrected wording', async () => {
    serveAs('admin', ROWS, [PENDING_SEND_EVENT]);
    const admin = await renderPage(MakerPoPage);
    expect(admin).toContain('<li class="step step--current" aria-current="step"><span class="step-mark">いま</span><span class="step-label">送信の手動確認</span></li>');
    expect(admin).toContain('<strong>手順3の確認: 送信の手動確認</strong>');
    // P4 §0: the check is recorded at step 9 of the order screen (SendWaitFacts + the form there).
    expect(admin).not.toContain('送信の手動確認を記録しますか？');
    expect(admin).toMatch(/href="\/p\/TEST-P\/o\/FSO-SEND\?step=9"[^>]*>発注の画面で進める（手順9）/);
    expect(admin).not.toContain('納品を断定');

    serveAs('staff', ROWS, [PENDING_SEND_EVENT]);
    const staff = await renderPage(MakerPoPage);
    expect(staff).toContain('<strong>手順3の確認: 送信の手動確認</strong>');
    expect(staff).toContain('送信記録は代表者の手動確認待ちです。');
    expect(staff).not.toContain('>手動確認を記録する</button>');
  });

  it.each(ROLES)('%s: no 「檢証」 or 「納品を断定」 anywhere on the screen', async (role) => {
    serveAs(role);
    const html = await renderPage(MakerPoPage);
    expect(html).not.toContain('檢証');
    expect(html).not.toContain('納品を断定');
  });
});

describe('2-④ ① 作成 card: one line when there is nothing to create, no misleading 両組織の承認不足', () => {
  it('orders already past ① (no MAKER_PO_READY order): the paper is below, not 「両組織の承認不足」', async () => {
    serveAs('admin', [...SEND_ROWS, ...BASE_ROWS]);
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('作成待ちの発注はありません。作成済みの発注書は下の各発注に表示されます。');
    expect(html).not.toContain('両組織の承認不足');
    expect(html).not.toContain('>メーカー発注書を作成する</button>');
  });

  it('no order on the maker board at all: the double-approval guidance stays', async () => {
    serveAs('admin', BASE_ROWS.filter((row) => row.entityId !== ORDER_DONE && row.entityId !== ORDER_DELIVERED));
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('ブロック理由: 両組織の承認不足');
    expect(html).not.toContain('作成待ちの発注はありません');
  });

  it('an order ready for paper: the card links step 7 of its order screen (the form is there, P4 §0)', async () => {
    serveAs('admin');
    const html = await renderPage(MakerPoPage);
    expect(html).not.toContain('>メーカー発注書を作成する</button>');
    expect(html).toMatch(/href="\/p\/TEST-P\/o\/FSO-READY\?step=7"><span translate="no">FSO-READY<\/span> のメーカー発注書を発注の画面で作る（手順7）/);
    expect(html).not.toContain('両組織の承認不足');
  });
});

describe('2-⑤ status badges on the screens', () => {
  it('orders (admin): film order statuses are badges; 下書き never wraps', async () => {
    serveAs('admin');
    const html = await renderPage(OrdersPage);
    // R27: the cell style is the ui-td class now (no inline style).
    expect(html).toContain('<td class="status-cell ui-td" data-label="状態"><span class="status-badge status-badge--active"><span class="status-badge-mark" aria-hidden="true">●</span>下書き</span>');
    // UI batch E (F-16): 保留中 keeps the blocked colour but reads ‖ (paused), not the ✕ of 取消済.
    expect(html).toContain('status-badge--blocked"><span class="status-badge-mark" aria-hidden="true">‖</span>保留中');
  });

  it('orders (viewer): a withheld status is the hidden-tone badge', async () => {
    serveAs('viewer');
    const html = await renderPage(OrdersPage);
    expect(html).toContain(`<span class="status-badge status-badge--hidden"><span class="status-badge-mark" aria-hidden="true">—</span>${HIDDEN_BY_ROLE_LABEL}</span>`);
  });

  it('maker-po (admin): the paper status is a badge in the card head', async () => {
    serveAs('admin');
    const html = await renderPage(MakerPoPage);
    expect(html).toMatch(/<h2 class="card-head"><span>フィルム発注 FSO-SEND[^<]*<\/span><span class="status-badge status-badge--active">/);
  });
});

describe('2-⑥ / 2-⑦ layout and small fixes (source of the shared stylesheet and layout)', () => {
  const webSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps/web/src');
  const css = readFileSync(path.join(webSrc, 'app/globals.css'), 'utf8');
  const layout = readFileSync(path.join(webSrc, 'app/layout.tsx'), 'utf8');

  it('the gutter narrows to 16px under 768px; header and main use it', () => {
    expect(css).toMatch(/@media \(max-width: 768px\) \{\s*:root \{\s*--gutter: var\(--space-4\);\s*--card-pad: var\(--space-3\);/);
    expect(css).toMatch(/\.app-main \{[^}]*padding: 0 var\(--gutter\) 64px;/);
    expect(css).toMatch(/\.app-header-inner \{[^}]*padding: var\(--space-3\) var\(--gutter\);/);
    expect(layout).toContain('<main id="main" tabIndex={-1} className="app-main">');
    expect(layout).not.toContain("padding: '0 24px 64px'");
  });

  it('nav links ≥ 32px, every summary ≥ 24px, badges never wrap, tables scroll', () => {
    expect(css).toMatch(/\.app-nav a \{[^}]*min-height: 32px;/);
    expect(css).toMatch(/summary \{[^}]*min-height: 24px;/);
    expect(css).toMatch(/\.status-badge \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.table-scroll \{[^}]*overflow-x: auto;/);
  });

  it('the scroll wrapper contains absolutely positioned descendants (hidden captions, empty live regions) so they cannot widen the page at 390px', () => {
    // Browser finding (ego-browser, 390px): without a positioned wrapper the
    // 1px live regions of row forms kept their static x inside the wide table
    // and stretched the document to 583px.
    expect(css).toMatch(/\.table-scroll \{[^}]*position: relative;[^}]*overflow-x: auto;/);
  });

  it('the batch B progress stepper is named (aria-label on its <ol>)', async () => {
    serveAs('admin');
    const html = await renderPage(OrdersPage);
    expect(html).toContain('<ol class="stepper" aria-label="FSO-READY の進み具合">');
    expect(html.match(/<ol class="stepper"(?! aria-label)/g) ?? []).toHaveLength(0);
  });

  it('本登録日・発行日: the date-only inputs are no longer type="date" (same field names; on the order screen since P4 §0)', async () => {
    const { SevenPoChecklistForm, SevenPoRegisterForm } = await import('../apps/web/src/components/SevenPoForms.js');
    const html = renderToString(<><SevenPoRegisterForm poId="po-1" poNumber="PO-1" role="admin" /><SevenPoChecklistForm poId="po-1" poNumber="PO-1" role="admin" /></>);
    expect(html).not.toContain('type="date"');
    expect(html).toMatch(/name="officialRegisteredAt"/);
    expect(html).toMatch(/name="issueDate"/);
  });
});
