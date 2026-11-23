/**
 * p6 int round 2 (review H-1): every GET × {admin, staff, viewer, auditor} after a canary — an amount, an
 * address and a mail address — was written into every free-text field the API takes (notes, memos, reasons,
 * evidence notes, closure notes, checklist notes). The representative may read them; the other roles get
 * none of them, on any route. (The first block of this file's header is shared with tests/p6-int.test.ts.)
 *
 * p6 int (audit44c REMAINING §1, conductor decisions 2026-11-23): the server half of
 * - X5: while receipt evidence waits for the representative (the queue's 「納品の確認」),
 *   staff may not close the order 「証跡なしで問題なし」 (409 RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE);
 *   the representative may; P-4 and the confirmed-deliveries closure are unchanged;
 * - X3: an inline send-evidence .eml keeps its own file name on the stored version (the
 *   logical document stays one per paper), and the evidence list says the send check apart
 *   from the document check (versions[].sendVerification);
 * - H10: the viewer reads the order code (film / filling order rows only) besides the stage —
 *   never an amount, a note, a file name or a partner contact.
 * Runs only against kanei_crm_mvp_test (tests/setup.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  auditEvents,
  createDatabase,
  documents,
  documentVersions,
  filmSupplyOrders,
  makerPoEvents,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE, sessionTokenHashForRole } from '../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p6-int canary tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const ids = {
  admin: uuidv7(), staff: uuidv7(), staff2: uuidv7(), viewer: uuidv7(), auditor: uuidv7(),
  customer: uuidv7(), seven: uuidv7(), maker: uuidv7(), projectA: uuidv7()
};
const DISPLAY = { admin: '合成代表者P6', staff: '合成担当者P6', staff2: '合成担当二P6', viewer: '合成閲覧者P6', auditor: '合成監査P6' } as const;
const CUSTOMER_MAIL = 'approvals@customer-p6.example';
const SEVEN_MAIL = 'po@seven-p6.example';
const MAKER_MAIL = 'maker-po-p6@example.com';
const PAPER_AMOUNT = '473921';
const tokens = { admin: '', staff: '', staff2: '', viewer: '', auditor: '' };
type Role = keyof typeof tokens;
let app: ReturnType<typeof createApp>;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${String(++counter).padStart(3, '0')}`;
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

async function send(role: Role | null, method: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { cookie: `${SESSION_COOKIE}=${tokens[role]}` } : {}),
      ...(method === 'GET' ? {} : { 'Idempotency-Key': `p6-${tag()}-key` })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}
const get = (role: Role | null, url: string) => send(role, 'GET', url);
const post = (role: Role | null, url: string, body: unknown) => send(role, 'POST', url, body);

function fullChecklist() {
  return {
    issuerNameRecorded: true, issuerName: '合成セブン化学P6',
    documentNumberRecorded: true, documentNumber: 'PO-P6-0001',
    issueDateRecorded: true, issueDate: '2026-11-11',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル',
    pastTransactionCompared: true, pastTransactionNote: '過去の発注書と一致',
    quoteCompared: true, quoteMatchesPo: true, quoteComparisonNote: '見積と一致',
    tamperHints: '', uncertain: false, confirmationReplyRecorded: false, confirmationReplyNote: '',
    verificationNote: '合成チェックリストP6'
  };
}

async function sevenPo() {
  const created = await post('staff', `/api/projects/${ids.projectA}/seven-purchase-orders`, {
    poNumber: `SEVEN-P6-${tag()}`, officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status, created.text).toBe(201);
  expect((await post('staff', `/api/seven-purchase-orders/${created.body.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  return created.body.id as string;
}

type Order = { orderId: string; code: string; sevenPoId: string; lineId: string };

async function createOrder(extra: Record<string, unknown> = {}): Promise<Order> {
  const sevenPoId = await sevenPo();
  const code = `FSO-P6-${tag()}`;
  const created = await post('staff', `/api/projects/${ids.projectA}/film-supply-orders`, {
    code, paymentTerms: 'prepaid', sevenPurchaseOrderId: sevenPoId, ...extra,
    lines: [{ lineNumber: 1, description: '合成フィルムP6', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(created.status, created.text).toBe(201);
  return { orderId: created.body.id as string, code, sevenPoId, lineId: created.body.lines[0].id as string };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p6-canary-'));
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, delivery_confirmations, film_deliveries, filling_deliveries,
      film_supply_order_lines, filling_order_lines, film_supply_orders, filling_orders,
      seven_purchase_orders, pre_order_references, document_versions, documents,
      artwork_revisions, artwork_approval_events, evidence_manual_verifications,
      maker_po_events, maker_po_send_manual_verifications, maker_purchase_orders, commission_readiness,
      seven_po_order_facts, maker_recipient_addresses, idempotency_keys, maker_po_display_numbers,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values((Object.keys(DISPLAY) as Role[]).map((name) => ({
    id: ids[name], username: `${name}_p6`, passwordHash: 'not-a-login-hash', displayName: DISPLAY[name],
    role: name === 'staff2' ? 'staff' : name
  })) as any);
  await db.insert(accounts).values([
    { id: ids.customer, name: '合成P6顧客', role: 'end_customer', externalCode: 'P6-CUST', contactEmail: CUSTOMER_MAIL },
    { id: ids.seven, name: '合成P6セブン', role: 'seven', externalCode: 'P6-SEVEN', contactEmail: SEVEN_MAIL },
    { id: ids.maker, name: '合成P6メーカー', role: 'maker', externalCode: 'P6-MAKER' }
  ]);
  const now = new Date();
  await db.insert(projects).values({
    id: ids.projectA, code: 'P6-A', name: '合成P6-A', businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
    endCustomerAccountId: ids.customer, sevenAccountId: ids.seven, makerAccountId: ids.maker, createdByUserId: ids.admin,
    createdAt: now, updatedAt: now
  });
  await db.insert(projectAssignments).values(['staff', 'staff2', 'viewer', 'auditor'].map((name) => ({
    id: uuidv7(), userId: ids[name as Role], projectId: ids.projectA
  })));
  for (const role of Object.keys(tokens) as Role[]) {
    const { token, tokenHash } = issueToken();
    const storedHash = sessionTokenHashForRole(tokenHash, role === 'auditor' ? 'auditor' : 'staff');
    await db.insert(sessions).values({ id: uuidv7(), userId: ids[role], tokenHash: storedHash, expiresAt: new Date(Date.now() + 3600_000) });
    tokens[role] = token;
  }
});

afterAll(async () => {
  await pool.end();
});

// ================================================================ H-1 canary
/** One canary per field, so a leak names its field. Amount (two shapes), address and mail address. */
const canary = (field: string) => `CANARY-${field} 見積473,921円（¥473921） 東京都千代田区丸の内1-2-3 buyer-${field}@canary-p6.example`;
const CANARY_FIELDS = [
  'pastTransactionNote', 'quoteComparisonNote', 'checklistNote', 'tamperHints', 'preOrderNote', 'paymentTermsReason', 'evidenceNote', 'documentNote',
  'verificationNote', 'revisionNote', 'approvalCheckReason', 'returnReason', 'sendCheckReason', 'deliveryNote', 'receiptDocumentNote',
  'confirmationNote', 'receiptClosureNote', 'holdReason', 'holdReleaseReason', 'cancellationReviewReason', 'evidenceFreeNote', 'fillingDeliveryNote'
] as const;
const CANARY_RE = /CANARY-[A-Za-z]+|473,?921|丸の内1-2-3|canary-p6\.example/;

function approvalEml(from: string, stamp = tag()): string {
  return [
    `From: 承認者 <${from}>`, 'To: KANEI 担当 <staff@kanei.example>', `Subject: 校正承認 ${stamp}`, 'Date: Mon, 16 Nov 2026 01:00:00 +0000',
    `Message-ID: <approval-${stamp}@mail.example>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', `承認します（${stamp}）`, ''
  ].join('\r\n');
}

async function must(role: Role, method: 'POST' | 'PATCH', url: string, body: unknown, expected: number[] = [200, 201]) {
  const answer = await send(role, method, url, body);
  expect(expected, `${role} ${method} ${url} ${answer.text}`).toContain(answer.status);
  return answer.body;
}

/** A world in which every free-text field the API takes holds a canary. Returns what the GET sweep needs. */
async function canaryWorld() {
  // セブン化学発注書 checklist: its three note fields (the names and numbers are identifiers, not notes).
  const po = await send('staff', 'POST', `/api/projects/${ids.projectA}/seven-purchase-orders`, { poNumber: `SEVEN-P6C-${tag()}`, officialRegisteredAt: '2026-11-01T09:00:00.000Z' });
  await must('staff', 'POST', `/api/seven-purchase-orders/${po.body.id}/verification-checklist`, {
    ...fullChecklist(), pastTransactionNote: canary('pastTransactionNote'), quoteComparisonNote: canary('quoteComparisonNote'),
    verificationNote: canary('checklistNote'), tamperHints: canary('tamperHints')
  });
  // 先行参照 note.
  await must('staff', 'POST', `/api/projects/${ids.projectA}/pre-order-references`, { referenceCode: `PRE-P6C-${tag()}`, note: canary('preOrderNote') });

  // The main order: payment terms reason, design note, approval evidence (one held → manual check reason),
  // document note + check note, maker paper returned (reason), re-made, approved, sent (manual check reason),
  // delivered with a delivery note, receipt confirmed with a note, closed with a note (H-1).
  const order = await createOrder({ requestedDeliveryDate: '2027-04-30' });
  await must('staff', 'POST', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED', evidenceNote: canary('evidenceNote') });
  const artwork = `p6c artwork ${tag()}\n`;
  const proof = await must('staff', 'POST', `/api/projects/${ids.projectA}/documents`, {
    documentType: 'proof', issuerEntity: 'kanei', filename: `p6c-proof-${tag()}.txt`, contentType: 'text/plain', contentBase64: b64(artwork),
    sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, designKey: 'label-front', note: canary('documentNote')
  });
  await must('admin', 'POST', `/api/documents/${proof.document.id}/verify`, { verificationStatus: 'verified', verificationNote: canary('verificationNote') });
  const revision = await must('staff', 'POST', `/api/film-supply-orders/${order.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.version.id, note: canary('revisionNote') });
  for (const [organization, from] of [['customer', 'boss@elsewhere-p6c.example'], ['seven', SEVEN_MAIL]] as const) {
    const doc = await must('staff', 'POST', `/api/projects/${ids.projectA}/documents`, {
      documentType: 'approval_evidence', issuerEntity: organization === 'customer' ? 'customer_generated' : 'seven', filename: `p6c-${organization}-${tag()}.eml`,
      contentType: 'text/plain', contentBase64: b64(approvalEml(from)), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, designKey: 'label-front'
    });
    const approval = await must('staff', 'POST', `/api/artwork-revisions/${revision.id}/approvals`, {
      organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z', evidenceIdentifier: `P6C-ID-${tag()}`, evidenceDocumentVersionId: doc.version.id
    });
    if (approval.countsTowardDualApproval === false) {
      await must('admin', 'POST', `/api/artwork-approval-events/${approval.approvalEvent.id}/verification`, { result: 'confirmed', reasonNote: canary('approvalCheckReason') });
    }
  }
  const returned = await must('admin', 'POST', `/api/film-supply-orders/${order.orderId}/maker-purchase-orders`, { recipientAddress: MAKER_MAIL, amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT } });
  await must('admin', 'POST', `/api/maker-purchase-orders/${returned.id}/return`, { reason: canary('returnReason') });
  const paper = await must('admin', 'POST', `/api/film-supply-orders/${order.orderId}/maker-purchase-orders`, { recipientAddress: MAKER_MAIL, amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT } });
  const card = await send('admin', 'GET', `/api/maker-purchase-orders/${paper.id}/approval-card`);
  await must('admin', 'POST', `/api/maker-purchase-orders/${paper.id}/ceo-approval`, { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: card.body.makerPurchaseOrder.approvalSnapshotSha256 });
  const boundary = `----p6c-${tag()}`;
  const eml = [
    'From: KANEI <staff@kanei.example>', `To: Maker <${MAKER_MAIL}>`, 'Subject: 製造先発注書（コードなし）', `Date: ${new Date().toUTCString()}`,
    `Message-ID: <p6c-send-${tag()}@mail.kanei.example>`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', '発注書を送ります', '',
    `--${boundary}`, 'Content-Type: text/plain; name="po.txt"', 'Content-Disposition: attachment; filename="po.txt"', 'Content-Transfer-Encoding: base64', '', b64(artwork), '', `--${boundary}--`, ''
  ].join('\r\n');
  await must('staff', 'POST', `/api/maker-purchase-orders/${paper.id}/send-evidence`, { contentBase64: b64(eml), filename: 'p6c-send.eml', senderAddress: 'staff@kanei.example', recipients: [MAKER_MAIL], sentAt: new Date().toISOString() });
  const [sendEvent] = await db.select().from(makerPoEvents).where(and(eq(makerPoEvents.makerPurchaseOrderId, paper.id), eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED')));
  await must('admin', 'POST', `/api/maker-po-events/${sendEvent!.id}/send-manual-verification`, { result: 'confirmed', verifierName: '合成代表者P6', verifiedAt: new Date().toISOString(), reasonNote: canary('sendCheckReason') });
  const delivery = await must('staff', 'POST', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 1000, unit: 'sheets', note: canary('deliveryNote') });
  const receipt = await must('admin', 'POST', `/api/projects/${ids.projectA}/documents`, {
    documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: `p6c-receipt-${tag()}.txt`, contentType: 'text/plain',
    contentBase64: b64(`p6c receipt ${tag()}\n`), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, note: canary('receiptDocumentNote')
  });
  await must('admin', 'POST', `/api/documents/${receipt.document.id}/verify`, { verificationStatus: 'verified' });
  await must('admin', 'POST', `/api/film-deliveries/${delivery.id}/confirmation`, { evidenceDocumentVersionId: receipt.version.id, note: canary('confirmationNote') });
  await db.update(filmSupplyOrders).set({ status: 'FILM_DELIVERED' }).where(eq(filmSupplyOrders.id, order.orderId));
  await must('staff', 'POST', `/api/film-supply-orders/${order.orderId}/receipt-assumption`, { note: canary('receiptClosureNote') });

  // A second order: put on hold (reason), released (reason), then a cancellation review resolved (reason);
  // a staff closure with the evidence-free agreement (note) on a third, so both closure paths are covered.
  const held = await createOrder();
  await must('staff', 'POST', `/api/film-supply-orders/${held.orderId}/transitions`, { to: 'ON_HOLD', holdReason: canary('holdReason') });
  await must('admin', 'POST', `/api/film-supply-orders/${held.orderId}/hold-release`, { reason: canary('holdReleaseReason') });
  await must('staff', 'POST', `/api/film-supply-orders/${held.orderId}/transitions`, { to: 'CANCELLATION_REVIEW' });
  await must('admin', 'POST', `/api/film-supply-orders/${held.orderId}/cancellation-review-resolve`, { outcome: 'resume', reason: canary('cancellationReviewReason') });
  const closed = await createOrder();
  await must('admin', 'PATCH', `/api/film-supply-orders/${closed.orderId}/payment-terms`, { paymentTerms: 'on_delivery', reason: canary('paymentTermsReason') });
  await db.update(filmSupplyOrders).set({ status: 'FILM_DELIVERED' }).where(eq(filmSupplyOrders.id, closed.orderId));
  await must('staff', 'POST', `/api/film-supply-orders/${closed.orderId}/receipt-assumption`, { note: canary('evidenceFreeNote'), acknowledgeNoEvidence: true });

  // A filling order delivery note.
  const filling = await send('staff', 'POST', `/api/projects/${ids.projectA}/filling-orders`, { code: `FIL-P6C-${tag()}`, lines: [{ lineNumber: 1, description: '合成充填P6C', orderedQuantity: 10, unit: 'pieces' }] });
  if (filling.status === 201) {
    await must('staff', 'POST', `/api/filling-orders/${filling.body.id}/deliveries`, { fillingOrderLineId: filling.body.lines[0].id, deliveredQuantity: 10, unit: 'pieces', note: canary('fillingDeliveryNote') });
  }
  return { orders: [order, held, closed], paperIds: [returned.id as string, paper.id as string] };
}

/** Every GET route of the API, for every id of the canary project (the routes come from the sources). */
async function everyGetUrl() {
  const P = ids.projectA;
  const q = async (text: string) => (await pool.query(text, [P])).rows.map((row) => row.id as string);
  const orders = await q('select id from film_supply_orders where project_id = $1');
  const papers = await q('select m.id from maker_purchase_orders m join film_supply_orders o on o.id = m.film_supply_order_id where o.project_id = $1');
  const sevens = await q('select id from seven_purchase_orders where project_id = $1');
  const versions = await q('select v.id from document_versions v join documents d on d.id = v.document_id where d.project_id = $1');
  const urls = ['/api/me', '/api/projects', `/api/projects/${P}`, `/api/projects/${P}/assignments`, `/api/projects/${P}/audit-history`,
    `/api/projects/${P}/audit-history?limit=500&order=desc`, `/api/projects/${P}/evidence-metadata`, `/api/projects/${P}/film-supply-orders`,
    `/api/projects/${P}/film-supply-orders?attention=true`, `/api/projects/${P}/maker-recipient-addresses`, '/api/representative-queue',
    '/api/assignable-users', '/api/maker-accounts', '/api/partner-accounts', '/api/status-labels', '/api/health'];
  for (const o of orders) urls.push(`/api/film-supply-orders/${o}/approval-gate`, `/api/film-supply-orders/${o}/delivery-status`, `/api/film-supply-orders/${o}/maker-purchase-orders`, `/api/film-supply-orders/${o}/payment-gate`, `/api/film-supply-orders/${o}/auto-advance`);
  for (const m of papers) urls.push(`/api/maker-purchase-orders/${m}`, `/api/maker-purchase-orders/${m}/approval-card`, `/api/maker-purchase-orders/${m}/send-evidence-candidates`);
  for (const s of sevens) urls.push(`/api/seven-purchase-orders/${s}/order-facts`);
  for (const v of versions) urls.push(`/api/document-versions/${v}/evidence-message-id`, `/api/document-versions/${v}/download`);
  return urls;
}

describe('H-1: no free text (note / memo / reason) reaches a role other than the representative, on any GET', () => {
  it('the GET route list here is the API\'s own (a new GET route fails this test until it is swept)', async () => {
    const { readFileSync } = await import('node:fs');
    const routes = ['app.ts', 'p2-routes.ts', 'p4-routes.ts', 'p5-routes.ts']
      .flatMap((file) => [...readFileSync(path.join(__dirname, '../apps/api/src', file), 'utf8').matchAll(/app\.get\('([^']+)'/g)].map((match) => match[1]!));
    const swept = (await everyGetUrlTemplates());
    expect([...routes].sort()).toEqual([...swept].sort());
  });

  it('canary in every free-text field: admin reads them; staff, viewer and auditor read none on any of the GET URLs', async () => {
    await canaryWorld();
    // Every canary was written (the sweep is not vacuous): each one is stored in the audit trail.
    const stored = new Set<string>();
    const { rows } = await pool.query("select coalesce(before_state::text, '') || coalesce(after_state::text, '') || coalesce(request_metadata::text, '') as t from audit_events");
    for (const row of rows) for (const match of String(row.t).matchAll(/CANARY-([A-Za-z]+)/g)) stored.add(match[1]!);
    expect([...stored].sort()).toEqual([...CANARY_FIELDS].sort());
    const urls = await everyGetUrl();
    expect(urls.length).toBeGreaterThan(40);
    // The control: the representative's answers carry the canaries (so the sweep can see them at all).
    const adminSeen = new Set<string>();
    for (const url of urls) {
      const answer = await send('admin', 'GET', url);
      for (const match of answer.text.matchAll(/CANARY-([A-Za-z]+)/g)) adminSeen.add(match[1]!);
    }
    console.log('admin reads canaries of:', [...adminSeen].sort().join(', '));
    for (const field of ['receiptClosureNote', 'evidenceFreeNote', 'deliveryNote', 'confirmationNote', 'holdReason']) expect([...adminSeen], field).toContain(field);
    const leaks: string[] = [];
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      for (const url of urls) {
        const answer = await send(role, 'GET', url);
        const found = CANARY_RE.exec(answer.text) ?? CANARY_RE.exec(Buffer.from(answer.text, 'utf8').toString('latin1'));
        if (found) leaks.push(`${role} ${answer.status} ${url.replace(/[0-9a-f-]{36}/g, ':id')} ${found[0]}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe('H-1: GET …/delivery-status answers the closure note to the representative only', () => {
  it('both closure paths: admin reads the note as written; staff (its author), viewer and auditor get no note key; the rest is unchanged', async () => {
    for (const confirmed of [false, true]) {
      const order = await createOrder();
      const delivery = await must('staff', 'POST', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 1000, unit: 'sheets' });
      if (confirmed) {
        const receipt = await must('admin', 'POST', `/api/projects/${ids.projectA}/documents`, {
          documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: `p6c-r-${tag()}.txt`, contentType: 'text/plain',
          contentBase64: b64(`p6c r ${tag()}\n`), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId
        });
        await must('admin', 'POST', `/api/documents/${receipt.document.id}/verify`, { verificationStatus: 'verified' });
        await must('admin', 'POST', `/api/film-deliveries/${delivery.id}/confirmation`, { evidenceDocumentVersionId: receipt.version.id });
      }
      await db.update(filmSupplyOrders).set({ status: 'FILM_DELIVERED' }).where(eq(filmSupplyOrders.id, order.orderId));
      const note = canary(confirmed ? 'closedOnConfirmed' : 'closedEvidenceFree');
      await must('staff', 'POST', `/api/film-supply-orders/${order.orderId}/receipt-assumption`, { note, ...(confirmed ? {} : { acknowledgeNoEvidence: true }) });
      const url = `/api/film-supply-orders/${order.orderId}/delivery-status`;
      const admin = await send('admin', 'GET', url);
      expect(admin.body.receiptAssumption).toMatchObject({ note, closureBasis: confirmed ? 'delivery_confirmations' : 'evidence_free_acknowledgment' });
      for (const role of ['staff', 'viewer', 'auditor'] as const) {
        const answer = await send(role, 'GET', url);
        expect(answer.status, role).toBe(200);
        expect(answer.body.receiptAssumption, role).not.toHaveProperty('note');
        const { note: _adminNote, ...rest } = admin.body.receiptAssumption;
        expect(answer.body.receiptAssumption, role).toEqual(rest);
        expect(answer.text, role).not.toMatch(CANARY_RE);
      }
    }
  });
});

/** The route templates everyGetUrl covers (kept beside it so the route-list test pins both). */
async function everyGetUrlTemplates() {
  return [
    '/api/health', '/api/me', '/api/projects', '/api/projects/:projectId', '/api/projects/:projectId/assignments', '/api/projects/:projectId/audit-history',
    '/api/projects/:projectId/evidence-metadata', '/api/projects/:projectId/film-supply-orders', '/api/projects/:projectId/maker-recipient-addresses',
    '/api/representative-queue', '/api/assignable-users', '/api/maker-accounts', '/api/partner-accounts', '/api/status-labels',
    '/api/film-supply-orders/:orderId/approval-gate', '/api/film-supply-orders/:orderId/delivery-status', '/api/film-supply-orders/:orderId/maker-purchase-orders',
    '/api/film-supply-orders/:orderId/payment-gate', '/api/film-supply-orders/:orderId/auto-advance',
    '/api/maker-purchase-orders/:poId', '/api/maker-purchase-orders/:poId/approval-card', '/api/maker-purchase-orders/:poId/send-evidence-candidates',
    '/api/seven-purchase-orders/:poId/order-facts', '/api/document-versions/:versionId/evidence-message-id', '/api/document-versions/:versionId/download'
  ];
}
