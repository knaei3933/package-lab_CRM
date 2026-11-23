/**
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
import { createApp, sendEvidenceDisplayFilename } from '../apps/api/src/app.js';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import { issueToken, SESSION_COOKIE, sessionTokenHashForRole } from '../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p6-int tests require kanei_crm_mvp_test');
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
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p6-int-'));
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

// ================================================================ X5
describe('X5: staff may not close 「証跡なしで問題なし」 while receipt evidence waits for the representative', () => {
  const closeUrl = (orderId: string) => `/api/film-supply-orders/${orderId}/receipt-assumption`;
  const statusUrl = (orderId: string) => `/api/film-supply-orders/${orderId}/delivery-status`;
  const evidenceFree = { note: '問題なし（合成）', acknowledgeNoEvidence: true };

  async function uploadReceipt(order: Order, role: Role, extra: Record<string, unknown> = {}, content = `p6 receipt ${tag()}\n`) {
    const uploaded = await post(role, `/api/projects/${ids.projectA}/documents`, {
      documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: `p6-receipt-${tag()}.txt`, contentType: 'text/plain',
      contentBase64: b64(content), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, ...extra
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    return uploaded.body as { document: { id: string }; version: { id: string } };
  }

  /** A FILM_DELIVERED order with `deliveries` delivery rows, none confirmed. */
  async function deliveredOrder(deliveries = 1) {
    const order = await createOrder();
    const deliveryIds: string[] = [];
    for (let index = 0; index < deliveries; index += 1) {
      const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 500, unit: 'sheets' });
      expect(delivery.status, delivery.text).toBe(201);
      deliveryIds.push(delivery.body.id as string);
    }
    await db.update(filmSupplyOrders).set({ status: 'FILM_DELIVERED' }).where(eq(filmSupplyOrders.id, order.orderId));
    return { ...order, deliveryIds };
  }

  const closureRows = async (orderId: string) => db.select().from(auditEvents)
    .where(and(eq(auditEvents.entityId, orderId), eq(auditEvents.action, 'FILM_RECEIPT_ASSUMPTION_RECORDED')));
  const orderStatus = async (orderId: string) => (await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)))[0]!.status;
  const queueKeys = async () => ((await get('admin', '/api/representative-queue')).body.items as Array<{ key: string }>).map((item) => item.key);

  it('staff evidence waiting for the representative → staff 409 RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE, nothing written; the representative closes', async () => {
    const order = await deliveredOrder();
    await uploadReceipt(order, 'staff');
    // The same fact the representative's queue shows (one definition).
    expect(await queueKeys()).toContain(`delivery_confirmation:${order.deliveryIds[0]}`);
    expect((await get('staff', statusUrl(order.orderId))).body.receiptClosure).toEqual({
      basis: 'evidence_free_acknowledgment', acknowledgeNoEvidenceRequired: true, receiptEvidenceAwaitingRepresentative: true
    });
    const refused = await post('staff', closeUrl(order.orderId), evidenceFree);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body).toEqual({
      error: '受領証跡が代表の確認を待っています。証跡なしでの完了は代表だけが記録できます。代表の確認を待ってください',
      code: 'RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE',
      from: 'FILM_DELIVERED'
    });
    expect(await orderStatus(order.orderId)).toBe('FILM_DELIVERED');
    expect(await closureRows(order.orderId)).toHaveLength(0);
    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(row!.receiptAssumedAt).toBeNull();
    // The representative may (decision: 代表のみ可), and it is recorded as evidence-free.
    const closed = await post('admin', closeUrl(order.orderId), evidenceFree);
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', closureBasis: 'evidence_free_acknowledgment', evidenceFreeAcknowledgment: true });
  });

  it('another staff member\'s evidence waits too (the rule is the queue\'s, not the uploader\'s own P-4 view)', async () => {
    const order = await deliveredOrder();
    await uploadReceipt(order, 'staff2');
    const refused = await post('staff', closeUrl(order.orderId), evidenceFree);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE');
  });

  it('the input checks keep their order: a missing acknowledgment is still 422 (no write either way)', async () => {
    const order = await deliveredOrder();
    await uploadReceipt(order, 'staff');
    const refused = await post('staff', closeUrl(order.orderId), { note: '同意なし' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED');
  });

  it('no receipt evidence at all → staff still close evidence-free (the earlier contract); delivery-status says not waiting', async () => {
    const order = await deliveredOrder();
    expect(await queueKeys()).not.toContain(`delivery_confirmation:${order.deliveryIds[0]}`);
    expect((await get('staff', statusUrl(order.orderId))).body.receiptClosure.receiptEvidenceAwaitingRepresentative).toBe(false);
    const closed = await post('staff', closeUrl(order.orderId), evidenceFree);
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ closureBasis: 'evidence_free_acknowledgment', evidenceFreeAcknowledgment: true });
  });

  it('evidence the representative uploaded does not wait for the representative → staff may close', async () => {
    const order = await deliveredOrder();
    await uploadReceipt(order, 'admin');
    expect((await get('staff', statusUrl(order.orderId))).body.receiptClosure.receiptEvidenceAwaitingRepresentative).toBe(false);
    expect((await post('staff', closeUrl(order.orderId), evidenceFree)).status).toBe(200);
  });

  it('receipt evidence of another order does not hold this one (the rule is per order); maker-bound ones: tests/p4-server2 (7)(8)', async () => {
    const order = await deliveredOrder();
    const other = await deliveredOrder();
    await uploadReceipt(other, 'staff');
    expect((await get('staff', statusUrl(order.orderId))).body.receiptClosure.receiptEvidenceAwaitingRepresentative).toBe(false);
    expect((await get('staff', statusUrl(other.orderId))).body.receiptClosure.receiptEvidenceAwaitingRepresentative).toBe(true);
    expect((await post('staff', closeUrl(order.orderId), evidenceFree)).status).toBe(200);
  });

  it('a non-receipt document of the order (approval evidence) does not hold the closure', async () => {
    const order = await deliveredOrder();
    const uploaded = await post('staff', `/api/projects/${ids.projectA}/documents`, {
      documentType: 'approval_evidence', issuerEntity: 'customer_generated', filename: `p6-approval-${tag()}.txt`, contentType: 'text/plain',
      contentBase64: b64(`p6 approval ${tag()}\n`), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, designKey: 'label-front'
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    expect((await post('staff', closeUrl(order.orderId), evidenceFree)).status).toBe(200);
  });

  it('every delivery confirmed → the closure on confirmed deliveries is untouched for staff (P-4 path unchanged)', async () => {
    const order = await deliveredOrder();
    const receipt = await uploadReceipt(order, 'staff');
    // P-4: staff never confirm on their own evidence.
    const self = await post('staff', `/api/film-deliveries/${order.deliveryIds[0]}/confirmation`, { evidenceDocumentVersionId: receipt.version.id });
    expect(self.body.code).not.toBe('RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE');
    expect(self.status).not.toBe(201);
    expect((await post('admin', `/api/documents/${receipt.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    expect((await post('admin', `/api/film-deliveries/${order.deliveryIds[0]}/confirmation`, { evidenceDocumentVersionId: receipt.version.id })).status).toBe(201);
    expect((await get('staff', statusUrl(order.orderId))).body.receiptClosure).toEqual({
      basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false, receiptEvidenceAwaitingRepresentative: false
    });
    const closed = await post('staff', closeUrl(order.orderId), { note: '確認済み' });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body.closureBasis).toBe('delivery_confirmations');
  });

  it('one delivery confirmed, one still waiting on staff evidence → staff 409, the representative closes evidence-free', async () => {
    const order = await deliveredOrder(2);
    const receipt = await uploadReceipt(order, 'staff');
    expect((await post('admin', `/api/documents/${receipt.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    expect((await post('admin', `/api/film-deliveries/${order.deliveryIds[0]}/confirmation`, { evidenceDocumentVersionId: receipt.version.id })).status).toBe(201);
    expect((await post('staff', closeUrl(order.orderId), evidenceFree)).status).toBe(409);
    expect((await post('admin', closeUrl(order.orderId), evidenceFree)).body).toMatchObject({ closureBasis: 'evidence_free_acknowledgment', deliveries: { total: 2, confirmed: 1 } });
  });

  it('race: evidence registered while the staff closure waits on the order lock → refused under the lock (409), nothing written', async () => {
    const order = await deliveredOrder();
    const client = await pool.connect();
    let closing: Promise<any> | null = null;
    try {
      await client.query('begin');
      await client.query('select id from film_supply_orders where id = $1 for update', [order.orderId]);
      const { rows: [holder] } = await client.query('select pg_backend_pid() as pid');
      closing = post('staff', closeUrl(order.orderId), evidenceFree);
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
        const { rows } = await pool.query(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> $1",
          [holder.pid]
        );
        waiting = rows[0].n >= 1;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      // The upload's own FK check would wait on this lock too, so the evidence is written by the lock holder
      // (the staff member's receipt, as the documents intake stores it) and committed: the waiting closure
      // passed its first check before it existed, and must decide again on what is committed under the lock.
      const documentId = uuidv7();
      await client.query(
        `insert into documents (id, project_id, document_type, issuer_entity, original_filename, seven_purchase_order_id, film_supply_order_id, created_by_user_id)
         values ($1, $2, 'acceptance_evidence', 'customer_generated', $3, $4, $5, $6)`,
        [documentId, ids.projectA, `p6-race-${tag()}.txt`, order.sevenPoId, order.orderId, ids.staff]
      );
      await client.query(
        `insert into document_versions (id, document_id, version_number, sha256, byte_size, storage_path, original_filename, declared_mime_type, size_check_passed, type_check_passed, created_by_user_id)
         values ($1, $2, 1, $3, 10, $4, 'p6-race.txt', 'text/plain', true, true, $5)`,
        [documentId, documentId, uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64), `race/${documentId}`, ids.staff]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const answer = await closing!;
    expect(answer.status, answer.text).toBe(409);
    expect(answer.body.code).toBe('RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE');
    expect(await orderStatus(order.orderId)).toBe('FILM_DELIVERED');
    expect(await closureRows(order.orderId)).toHaveLength(0);
  });

  it('permissions are unchanged: viewer and auditor 403, no session 401; the answers carry no amount', async () => {
    const order = await deliveredOrder();
    await uploadReceipt(order, 'staff');
    expect((await post('viewer', closeUrl(order.orderId), evidenceFree)).status).toBe(403);
    expect((await post('auditor', closeUrl(order.orderId), evidenceFree)).status).toBe(403);
    expect((await post(null, closeUrl(order.orderId), evidenceFree)).status).toBe(401);
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      const status = await get(role, statusUrl(order.orderId));
      if (status.status === 200) expect(status.text, role).not.toMatch(/amount|price|unitPrice|totalAmount/i);
    }
  });
});

// ================================================================ X3
describe('X3: the send evidence keeps its own file name and says its send check', () => {
  function approvalEml(from: string, stamp = tag()): string {
    return [
      `From: 承認者 <${from}>`, 'To: KANEI 担当 <staff@kanei.example>', `Subject: 校正承認 ${stamp}`, 'Date: Mon, 16 Nov 2026 01:00:00 +0000',
      `Message-ID: <approval-${stamp}@mail.example>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', `承認します（${stamp}）`, ''
    ].join('\r\n');
  }

  /** An approved maker paper (CEO approval recorded), ready for its send evidence. */
  async function approvedPaper() {
    const order = await createOrder({ requestedDeliveryDate: '2027-04-30' });
    expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
    const artwork = `p6 artwork ${tag()}\n`;
    const proof = await post('staff', `/api/projects/${ids.projectA}/documents`, {
      documentType: 'proof', issuerEntity: 'kanei', filename: `p6-proof-${tag()}.txt`, contentType: 'text/plain',
      contentBase64: b64(artwork), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, designKey: 'label-front'
    });
    expect(proof.status, proof.text).toBe(201);
    const revision = await post('staff', `/api/film-supply-orders/${order.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.body.version.id });
    expect(revision.status, revision.text).toBe(201);
    for (const [organization, from] of [['customer', CUSTOMER_MAIL], ['seven', SEVEN_MAIL]] as const) {
      const doc = await post('staff', `/api/projects/${ids.projectA}/documents`, {
        documentType: 'approval_evidence', issuerEntity: organization === 'customer' ? 'customer_generated' : 'seven',
        filename: `p6-${organization}-${tag()}.eml`, contentType: 'text/plain', contentBase64: b64(approvalEml(from)),
        sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, designKey: 'label-front'
      });
      expect(doc.status, doc.text).toBe(201);
      const approval = await post('staff', `/api/artwork-revisions/${revision.body.id}/approvals`, {
        organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
        evidenceIdentifier: `P6-ID-${tag()}`, evidenceDocumentVersionId: doc.body.version.id
      });
      expect(approval.status, approval.text).toBe(201);
    }
    const paper = await post('admin', `/api/film-supply-orders/${order.orderId}/maker-purchase-orders`, {
      recipientAddress: MAKER_MAIL, amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT }
    });
    expect(paper.status, paper.text).toBe(201);
    const card = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(card.status, card.text).toBe(200);
    const approved = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, {
      expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: card.body.makerPurchaseOrder.approvalSnapshotSha256
    });
    expect(approved.status, approved.text).toBe(200);
    return { order, paperId: paper.body.id as string, artwork };
  }

  /** The send mail; `withCode: false` leaves the order code out of the body → the send waits for a manual check. */
  function sendEml(chain: { order: Order; artwork: string }, withCode = true) {
    const boundary = `----p6-send-${tag()}`;
    return [
      'From: KANEI <staff@kanei.example>', `To: Maker <${MAKER_MAIL}>`, `Subject: 製造先発注書 ${withCode ? chain.order.code : '（コードなし）'}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <p6-send-${tag()}@mail.kanei.example>`,
      'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', withCode ? `発注コード ${chain.order.code}` : '発注書を送ります', '',
      `--${boundary}`, 'Content-Type: text/plain; name="po.txt"', 'Content-Disposition: attachment; filename="po.txt"',
      'Content-Transfer-Encoding: base64', '', b64(chain.artwork), '', `--${boundary}--`, ''
    ].join('\r\n');
  }

  async function recordSend(chain: { paperId: string; order: Order; artwork: string }, extra: Record<string, unknown> = {}, withCode = true) {
    const sent = await post('staff', `/api/maker-purchase-orders/${chain.paperId}/send-evidence`, {
      contentBase64: b64(sendEml(chain, withCode)), senderAddress: 'staff@kanei.example', recipients: [MAKER_MAIL], sentAt: new Date().toISOString(), ...extra
    });
    expect(sent.status, sent.text).toBe(200);
    const [event] = await db.select().from(makerPoEvents)
      .where(and(eq(makerPoEvents.makerPurchaseOrderId, chain.paperId), eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED')));
    return event!;
  }

  const sendDocumentOf = async (paperId: string) => {
    const rows = await db.select().from(documents).where(and(eq(documents.makerPurchaseOrderId, paperId), eq(documents.documentType, 'send_evidence')));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  const evidenceRow = async (role: Role, documentId: string) => {
    const read = await get(role, `/api/projects/${ids.projectA}/evidence-metadata`);
    expect(read.status, read.text).toBe(200);
    return (read.body.documents as Array<any>).find((doc) => doc.documentId === documentId);
  };

  it('the uploaded name is the version\'s name; the logical document keeps one key per paper', async () => {
    const chain = await approvedPaper();
    const event = await recordSend(chain, { filename: 'd-send-002.eml' });
    expect(event.verificationStatus).toBe('VERIFIED');
    const document = await sendDocumentOf(chain.paperId);
    expect(document.originalFilename).toBe(`maker-po-${chain.paperId}-send-evidence.eml`);
    const [version] = await db.select().from(documentVersions).where(eq(documentVersions.id, event.evidenceDocumentVersionId!));
    expect(version!.originalFilename).toBe('d-send-002.eml');
    for (const role of ['admin', 'staff', 'auditor'] as const) {
      const row = await evidenceRow(role, document.id);
      expect(row.versions.at(-1), role).toMatchObject({ originalFilename: 'd-send-002.eml', sendVerification: 'auto_verified' });
      expect(JSON.stringify(row), role).not.toContain(PAPER_AMOUNT);
    }
    // The upload audit row names the file as uploaded (staff and auditor read originalFilename).
    const [uploadAudit] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, version!.id), eq(auditEvents.action, 'DOCUMENT_VERSION_UPLOADED')));
    expect((uploadAudit!.afterState as any).originalFilename).toBe('d-send-002.eml');
  });

  it('no file name (an older web) → the version keeps the per-paper key name, as before', async () => {
    const chain = await approvedPaper();
    const event = await recordSend(chain);
    const [version] = await db.select().from(documentVersions).where(eq(documentVersions.id, event.evidenceDocumentVersionId!));
    expect(version!.originalFilename).toBe(`maker-po-${chain.paperId}-send-evidence.eml`);
  });

  it('two papers sending a file of the same name stay two documents (the name never merges papers)', async () => {
    const first = await approvedPaper();
    const second = await approvedPaper();
    await recordSend(first, { filename: 'send.eml' });
    await recordSend(second, { filename: 'send.eml' });
    const a = await sendDocumentOf(first.paperId);
    const b = await sendDocumentOf(second.paperId);
    expect(a.id).not.toBe(b.id);
    expect(a.makerPurchaseOrderId).toBe(first.paperId);
    expect(b.makerPurchaseOrderId).toBe(second.paperId);
  });

  it('a send that waits for the manual check says 手動確認待ち, then the representative\'s result', async () => {
    const chain = await approvedPaper();
    const event = await recordSend(chain, { filename: 'no-code.eml' }, false);
    expect(event.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    const document = await sendDocumentOf(chain.paperId);
    expect((await evidenceRow('staff', document.id)).versions.at(-1).sendVerification).toBe('manual_pending');
    const checked = await post('admin', `/api/maker-po-events/${event.id}/send-manual-verification`, {
      result: 'confirmed', verifierName: '合成代表者P6', verifiedAt: new Date().toISOString(), reasonNote: 'メーカーに電話で受信を確認した（合成）'
    });
    expect(checked.status, checked.text).toBe(201);
    for (const role of ['admin', 'staff', 'auditor'] as const) {
      const row = await evidenceRow(role, document.id);
      expect(row.versions.at(-1).sendVerification, role).toBe('manual_confirmed');
      expect(JSON.stringify(row), role).not.toContain('電話で受信');
    }
  });

  it('a rejected manual check reads 却下 (manual_rejected), the reason never travels', async () => {
    const chain = await approvedPaper();
    const event = await recordSend(chain, {}, false);
    const checked = await post('admin', `/api/maker-po-events/${event.id}/send-manual-verification`, {
      result: 'rejected', verifierName: '合成代表者P6', verifiedAt: new Date().toISOString(), reasonNote: '宛先が違う（合成理由P6）'
    });
    expect(checked.status, checked.text).toBe(201);
    const document = await sendDocumentOf(chain.paperId);
    const row = await evidenceRow('auditor', document.id);
    expect(row.versions.at(-1).sendVerification).toBe('manual_rejected');
    expect(JSON.stringify(row)).not.toContain('合成理由P6');
    // A later check of the same send (a rejection is not final) is the one the list says.
    const again = await post('admin', `/api/maker-po-events/${event.id}/send-manual-verification`, {
      result: 'confirmed', verifierName: '合成代表者P6', verifiedAt: new Date().toISOString(), reasonNote: '再確認で受信を確認した（合成）'
    });
    expect(again.status, again.text).toBe(201);
    expect((await evidenceRow('staff', document.id)).versions.at(-1).sendVerification).toBe('manual_confirmed');
  });

  it('documents that are not a cited send evidence carry sendVerification null; the viewer is still refused the list', async () => {
    const order = await createOrder();
    const uploaded = await post('staff', `/api/projects/${ids.projectA}/documents`, {
      documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: `p6-other-${tag()}.txt`, contentType: 'text/plain',
      contentBase64: b64(`p6 other ${tag()}\n`), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    const row = await evidenceRow('staff', uploaded.body.document.id);
    expect(row.versions[0].sendVerification).toBeNull();
    expect((await get('viewer', `/api/projects/${ids.projectA}/evidence-metadata`)).status).toBe(403);
  });

  it('pure: the display name is the last path segment, without control characters, trimmed, at most 200 characters', () => {
    expect(sendEvidenceDisplayFilename('d-send-002.eml')).toBe('d-send-002.eml');
    expect(sendEvidenceDisplayFilename('C:\\Users\\a\\送信済み.eml')).toBe('送信済み.eml');
    expect(sendEvidenceDisplayFilename('../../etc/passwd.eml')).toBe('passwd.eml');
    expect(sendEvidenceDisplayFilename('a\nb/c\u0007d.eml')).toBe('cd.eml');
    expect(sendEvidenceDisplayFilename('  spaced.eml  ')).toBe('spaced.eml');
    expect(sendEvidenceDisplayFilename(`${'あ'.repeat(250)}.eml`)).toBe('あ'.repeat(200));
    // Cut by characters, never inside a surrogate pair (𠮷 is two UTF-16 units).
    expect(sendEvidenceDisplayFilename(`${'𠮷'.repeat(250)}.eml`)).toBe('𠮷'.repeat(200));
    expect(sendEvidenceDisplayFilename('<script>alert(1)</script>.eml')).toBe('script>.eml');
    for (const bad of [undefined, null, 7, {}, '', '   ', 'dir/', '\u0001\u0002']) expect(sendEvidenceDisplayFilename(bad), String(bad)).toBeNull();
  });
});

// ================================================================ H10
describe('H10: the viewer reads the order code and the stage — nothing else of the order', () => {
  it('audit history: film and filling order rows carry code + status for the viewer; no amount, note, file name or contact', async () => {
    const order = await createOrder({ requestedDeliveryDate: '2027-04-30' });
    const filling = await post('staff', `/api/projects/${ids.projectA}/filling-orders`, {
      code: `FIL-P6-${tag()}`, lines: [{ lineNumber: 1, description: '合成充填P6', orderedQuantity: 10, unit: 'pieces' }]
    });
    const history = await get('viewer', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
    expect(history.status, history.text).toBe(200);
    const created = (history.body.events as Array<any>).find((event) => event.action === 'FILM_SUPPLY_ORDER_CREATED' && event.entityId === order.orderId);
    expect(created.afterState).toEqual({ code: order.code, status: expect.any(String), paymentTerms: 'prepaid' });
    if (filling.status === 201) {
      const fillingCreated = (history.body.events as Array<any>).find((event) => event.action === 'FILLING_ORDER_CREATED' && event.entityId === filling.body.id);
      expect(fillingCreated.afterState).toEqual({ code: filling.body.code });
    }
    for (const event of history.body.events as Array<any>) {
      const orderRow = event.entityType === 'film_supply_order' || event.entityType === 'filling_order';
      for (const state of [event.beforeState, event.afterState]) {
        if (state) for (const key of Object.keys(state)) expect(['status', 'readinessState', 'isReady', 'paymentTerms', ...(orderRow ? ['code'] : [])], `${event.action} ${key}`).toContain(key);
      }
      expect(event).not.toHaveProperty('requestMetadata');
    }
    expect(history.text).not.toContain(PAPER_AMOUNT);
    expect(history.text).not.toContain(CUSTOMER_MAIL);
    expect(history.text).not.toContain(SEVEN_MAIL);
    expect(history.text).not.toContain('合成フィルムP6');
    expect(history.text).not.toMatch(/\.eml|\.txt|\.pdf/);
  });

  it('pure: the code is added on order rows only; staff, auditor and admin answers are unchanged', () => {
    const row = (entityType: string) => ({
      id: 'e', action: 'X', entityType, entityId: 'o', occurredAt: new Date(), requestMetadata: { operation: 'x' }, actor: null,
      beforeState: { code: 'OLD', status: 'DRAFT', amount: 1 },
      afterState: { code: 'FSO-1', status: 'READY', totalAmount: '9', note: 'n', originalFilename: 'f.eml', contactEmail: 'a@b.example', lineCount: 1 }
    });
    for (const entityType of ['film_supply_order', 'filling_order']) {
      const [view] = buildAuditViewForRole('viewer', [row(entityType)]);
      expect(view!.afterState, entityType).toEqual({ code: 'FSO-1', status: 'READY' });
      expect(view!.beforeState, entityType).toEqual({ code: 'OLD', status: 'DRAFT' });
    }
    for (const entityType of ['project', 'maker_purchase_order', 'document', 'seven_purchase_order', 'film_supply_order_line']) {
      const [view] = buildAuditViewForRole('viewer', [row(entityType)]);
      expect(view!.afterState, entityType).toEqual({ status: 'READY' });
    }
    // A role this function does not know falls to the viewer answer (fail closed), with the same order-code rule.
    const [unknown] = buildAuditViewForRole('owner' as never, [row('project')]);
    expect(unknown!.afterState).toEqual({ status: 'READY' });
    const [staff] = buildAuditViewForRole('staff', [row('project')]);
    expect(staff!.afterState).toMatchObject({ code: 'FSO-1', status: 'READY', lineCount: 1 });
  });

  it('the order screen\'s reads stay closed to the viewer (stage only through the overview): maker papers and evidence 403 / status only', async () => {
    const order = await createOrder();
    expect((await get('viewer', `/api/projects/${ids.projectA}/evidence-metadata`)).status).toBe(403);
    const list = await get('viewer', `/api/projects/${ids.projectA}/film-supply-orders`);
    expect(list.status).toBe(200);
    const listed = (list.body.orders as Array<any>).find((row) => row.id === order.orderId);
    expect(listed).toMatchObject({ code: order.code });
    expect(list.text).not.toMatch(/amount|price/i);
  });
});
