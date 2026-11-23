/**
 * P4 server (audit44 UNRESOLVED.md, conductor decisions 2026-11-23):
 * N2 EML Date original value in the send plausibility, N8 idempotency scope
 * userId:role, N1 project assignment API, H4① 金額・希望納期 required at the
 * representative's approval, H7② server-numbered 発注コード, M18 queue dates,
 * N11/M13 queue organization·designKey, N4 EML From-domain warning, N13
 * `existing.orderCode` on binding refusals, H14 delivery confirmation waiting
 * for the representative.
 * Each rule has normal, refusal and permission cases; every block carries a
 * test that fails when the rule is removed (mutation log in REPORT.md).
 * Runs only against kanei_crm_mvp_test (tests/setup.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  auditEvents,
  createDatabase,
  documents,
  filmSupplyOrders,
  makerPoEvents,
  makerPurchaseOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import {
  evaluateCeoApprovalFacts,
  evaluateEvidenceSenderDomain,
  evaluateMakerPoEmlEvidence,
  evidenceSenderDomainWarning
} from '@kanei/core';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE, sessionTokenHashForRole } from '../apps/api/src/auth.js';
import { IdempotencyStore, roleScopedIdempotencyKey, type IdempotencyBackend } from '../apps/api/src/idempotency.js';
import { withApprovalSnapshot } from './helpers/approval-snapshot.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p4-server tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const ids = {
  admin: uuidv7(), staff: uuidv7(), staffNew: uuidv7(), staffOff: uuidv7(), staffDeleted: uuidv7(), viewer: uuidv7(), auditor: uuidv7(), flip: uuidv7(),
  customer: uuidv7(), customerNoMail: uuidv7(), seven: uuidv7(), maker: uuidv7(),
  projectA: uuidv7(), projectB: uuidv7()
};
const PROJECT_A = 'P4-A';
const PROJECT_B = 'P4-B';
const CUSTOMER_MAIL = 'approvals@customer-p4.example';
const SEVEN_MAIL = 'po@seven-p4.example';
const PAPER_RECIPIENT = 'maker-po-p4@example.com';
const SENDER = 'staff@kanei.example';

const tokens = { admin: '', staff: '', staffNew: '', staffOff: '', viewer: '', auditor: '', flip: '' };
type Role = keyof typeof tokens;
let app: ReturnType<typeof createApp>;

let counter = 0;
function nextTag(): string {
  counter += 1;
  return `${Date.now().toString(36)}${String(counter).padStart(3, '0')}`;
}
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const key = () => `p4-${nextTag()}-key`;

async function send(role: Role | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { cookie: `${SESSION_COOKIE}=${tokens[role]}` } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}
const post = (role: Role | null, url: string, body?: unknown, headers?: Record<string, string>) => send(role, 'POST', url, body ?? {}, headers);
const get = (role: Role | null, url: string) => send(role, 'GET', url);
const del = (role: Role | null, url: string, headers?: Record<string, string>) => send(role, 'DELETE', url, undefined, headers);
const patch = (role: Role | null, url: string, body?: unknown, headers?: Record<string, string>) => send(role, 'PATCH', url, body ?? {}, headers);

function fullChecklist() {
  return {
    issuerNameRecorded: true, issuerName: '合成セブン化学P4',
    documentNumberRecorded: true, documentNumber: 'PO-P4-0001',
    issueDateRecorded: true, issueDate: '2026-11-11',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル',
    pastTransactionCompared: true, pastTransactionNote: '過去の発注書と一致',
    quoteCompared: true, quoteMatchesPo: true, quoteComparisonNote: '見積と一致',
    tamperHints: '', uncertain: false, confirmationReplyRecorded: false, confirmationReplyNote: '',
    verificationNote: '合成チェックリストP4'
  };
}

async function sevenPo(project = ids.projectA) {
  const created = await post('staff', `/api/projects/${project}/seven-purchase-orders`, {
    poNumber: `SEVEN-P4-${nextTag()}`, officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post('staff', `/api/seven-purchase-orders/${created.body.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  return created.body.id as string;
}

async function createOrder(sevenPoId: string, extra: Record<string, unknown> = {}, project = ids.projectA) {
  const code = `FSO-P4-${nextTag()}`;
  const created = await post('staff', `/api/projects/${project}/film-supply-orders`, {
    code, paymentTerms: 'prepaid', sevenPurchaseOrderId: sevenPoId,
    lines: [{ lineNumber: 1, description: '合成フィルムP4', orderedQuantity: 1000, unit: 'sheets' }],
    ...extra
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { orderId: created.body.id as string, code, lineId: created.body.lines[0].id as string };
}

async function upload(sevenPoId: string, orderId: string | null, overrides: Record<string, unknown>, role: Role = 'staff', project = ids.projectA) {
  const tag = nextTag();
  return await post(role, `/api/projects/${project}/documents`, {
    documentType: 'proof', issuerEntity: 'kanei', filename: `p4-${tag}.txt`, contentType: 'text/plain',
    contentBase64: b64(`p4 document ${tag}\n`), sevenPurchaseOrderId: sevenPoId,
    ...(orderId ? { filmSupplyOrderId: orderId } : {}),
    ...overrides
  });
}

async function uploadOk(sevenPoId: string, orderId: string | null, overrides: Record<string, unknown>, role: Role = 'staff', project = ids.projectA) {
  const response = await upload(sevenPoId, orderId, overrides, role, project);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { document: { id: string }; version: { id: string } };
}

/** デザインデータ受領 + one proof revision; answers the proof bytes (the approved artwork). */
async function orderWithRevision(project = ids.projectA, extra: Record<string, unknown> = { requestedDeliveryDate: '2027-02-15' }) {
  const sevenPoId = await sevenPo(project);
  const order = await createOrder(sevenPoId, extra, project);
  expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
  const artwork = `p4 artwork ${nextTag()}\n`;
  const proof = await uploadOk(sevenPoId, order.orderId, { designKey: 'label-front', contentBase64: b64(artwork) }, 'staff', project);
  const revision = await post('staff', `/api/film-supply-orders/${order.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.version.id });
  expect(revision.status, JSON.stringify(revision.body)).toBe(201);
  return { sevenPoId, ...order, revisionId: revision.body.id as string, artwork };
}

/** An approval mail export (text/plain upload). No Message-ID → stays pending for the representative. */
function approvalEml(input: { from: string; messageId?: string | null; tag?: string }): string {
  const tag = input.tag ?? nextTag();
  return [
    `From: 承認者 <${input.from}>`,
    'To: KANEI 担当 <staff@kanei.example>',
    `Subject: 校正承認 ${tag}`,
    'Date: Mon, 16 Nov 2026 01:00:00 +0000',
    ...(input.messageId === null ? [] : [`Message-ID: ${input.messageId ?? `<approval-${tag}@mail.example>`}`]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `承認します（${tag}）`,
    ''
  ].join('\r\n');
}

async function recordApproval(chain: { sevenPoId: string; orderId: string; revisionId: string }, organization: 'customer' | 'seven', eml: string, identifier?: string, project = ids.projectA) {
  const doc = await uploadOk(chain.sevenPoId, chain.orderId, {
    documentType: 'approval_evidence', issuerEntity: organization === 'customer' ? 'customer_generated' : 'seven',
    designKey: 'label-front', contentBase64: b64(eml)
  }, 'staff', project);
  return await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
    organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
    evidenceIdentifier: identifier ?? `P4-ID-${nextTag()}`, evidenceDocumentVersionId: doc.version.id
  });
}

/** Both organizations approved through text evidence → MAKER_PO_READY. */
async function approvedOrder(extra?: Record<string, unknown>) {
  const chain = await orderWithRevision(ids.projectA, extra);
  for (const [organization, issuer] of [['customer', 'customer_generated'], ['seven', 'seven']] as const) {
    const identifier = `MSG-P4-${organization.toUpperCase()}-${nextTag()}`;
    const doc = await uploadOk(chain.sevenPoId, chain.orderId, {
      documentType: 'approval_evidence', issuerEntity: issuer, designKey: 'label-front',
      contentBase64: b64(`p4 approval\nidentifier: ${identifier}\n`)
    });
    const approval = await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
      organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: identifier, evidenceDocumentVersionId: doc.version.id
    });
    expect(approval.status, JSON.stringify(approval.body)).toBe(201);
  }
  return chain;
}

async function createPaper(orderId: string, withAmount = true) {
  const created = await post('admin', `/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress: PAPER_RECIPIENT,
    ...(withAmount ? { amounts: { currency: 'JPY', totalAmount: '480000' } } : {})
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

async function cardHash(poId: string) {
  const card = await get('admin', `/api/maker-purchase-orders/${poId}/approval-card`);
  expect(card.status).toBe(200);
  return card.body as { makerPurchaseOrder: { approvalSnapshotSha256: string }; blockers: Array<{ code: string }>; canApprove: boolean };
}

async function approveRaw(poId: string, headers?: Record<string, string>) {
  const card = await cardHash(poId);
  return await post('admin', `/api/maker-purchase-orders/${poId}/ceo-approval`, {
    expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: card.makerPurchaseOrder.approvalSnapshotSha256
  }, headers);
}

async function queue() {
  const answer = await get('admin', '/api/representative-queue');
  expect(answer.status).toBe(200);
  return answer.body as { items: Array<Record<string, any>>; blocked: Array<Record<string, any>> };
}

async function auditRows(action: string, entityId: string) {
  return await db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)));
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p4-server-'));
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
  await db.insert(users).values([
    { id: ids.admin, username: 'admin_p4', passwordHash: 'not-a-login-hash', displayName: '合成代表者P4', role: 'admin' },
    { id: ids.staff, username: 'staff_p4', passwordHash: 'not-a-login-hash', displayName: '合成担当者P4', role: 'staff' },
    { id: ids.staffNew, username: 'staff_new_p4', passwordHash: 'not-a-login-hash', displayName: '合成新任担当P4', role: 'staff' },
    { id: ids.staffOff, username: 'staff_off_p4', passwordHash: 'not-a-login-hash', displayName: '合成無効担当P4', role: 'staff', isActive: false },
    // Review L-2: logically deleted while is_active stays true.
    { id: ids.staffDeleted, username: 'staff_deleted_p4', passwordHash: 'not-a-login-hash', displayName: '合成削除済担当P4', role: 'staff', isActive: true, deletedAt: new Date('2026-11-01T00:00:00.000Z') },
    { id: ids.viewer, username: 'viewer_p4', passwordHash: 'not-a-login-hash', displayName: '合成閲覧者P4', role: 'viewer' },
    { id: ids.auditor, username: 'auditor_p4', passwordHash: 'not-a-login-hash', displayName: '合成監査P4', role: 'auditor' },
    { id: ids.flip, username: 'flip_p4', passwordHash: 'not-a-login-hash', displayName: '合成役割変更P4', role: 'admin' }
  ]);
  await db.insert(accounts).values([
    { id: ids.customer, name: '合成P4顧客', role: 'end_customer', externalCode: 'P4-CUST', contactEmail: CUSTOMER_MAIL },
    { id: ids.customerNoMail, name: '合成P4顧客（連絡先なし）', role: 'end_customer', externalCode: 'P4-CUST-NOMAIL' },
    { id: ids.seven, name: '合成P4セブン', role: 'seven', externalCode: 'P4-SEVEN', contactEmail: SEVEN_MAIL },
    { id: ids.maker, name: '合成P4メーカー', role: 'maker', externalCode: 'P4-MAKER' }
  ]);
  const now = new Date();
  for (const [id, code, customer] of [[ids.projectA, PROJECT_A, ids.customer], [ids.projectB, PROJECT_B, ids.customerNoMail]] as const) {
    await db.insert(projects).values({
      id, code, name: `合成${code}`, businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
      endCustomerAccountId: customer, sevenAccountId: ids.seven, makerAccountId: ids.maker, createdByUserId: ids.admin,
      createdAt: now, updatedAt: now
    });
  }
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectB },
    { id: uuidv7(), userId: ids.viewer, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.auditor, projectId: ids.projectA }
  ]);
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

// ================================================================ N2
describe('N2: the send is judged by the EML Date original value (seconds kept)', () => {
  const RECIPIENT = 'maker@example.com';
  const ARTWORK = 'n2 approved artwork\n';
  function mail(dateIso: string): Buffer {
    const boundary = '----n2-boundary';
    return Buffer.from([
      `From: KANEI <${SENDER}>`, `To: Maker <${RECIPIENT}>`, 'Subject: 製造先発注書 FSO-N2-0001',
      `Date: ${new Date(dateIso).toUTCString()}`, 'Message-ID: <n2@mail.kanei.example>',
      'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', '添付します', '',
      `--${boundary}`, 'Content-Type: text/plain; name="po.txt"', 'Content-Disposition: attachment; filename="po.txt"',
      'Content-Transfer-Encoding: base64', '', b64(ARTWORK), '', `--${boundary}--`, ''
    ].join('\r\n'), 'utf8');
  }
  const evaluate = (dateIso: string, sentAtIso: string, approvedIso: string) => evaluateMakerPoEmlEvidence({
    bytes: mail(dateIso), sentAt: new Date(sentAtIso), ceoApprovedAt: new Date(approvedIso), now: new Date('2026-11-16T01:00:00.000Z'),
    expectedRecipientAddress: RECIPIENT, recordedSenderAddress: SENDER, subjectIdentifiers: ['FSO-N2-0001'],
    artworkFileSha256s: [sha256(ARTWORK)]
  });

  it('a minute-cut sentAt (00:10:00) with Date 00:10:40 after an approval at 00:10:20 is VERIFIED, judged at 00:10:40', () => {
    const result = evaluate('2026-11-16T00:10:40.000Z', '2026-11-16T00:10:00.000Z', '2026-11-16T00:10:20.000Z');
    expect(result.verificationStatus).toBe('VERIFIED');
    expect(result.effectiveSentAt.toISOString()).toBe('2026-11-16T00:10:40.000Z');
    expect(result.checks.find((check) => check.key === 'sent_at_plausibility')).toMatchObject({ status: 'passed', detail: 'emlDate=2026-11-16T00:10:40.000Z' });
  });

  it('the header also decides the other way: Date 00:10:10 before the approval stays pending even with a later typed sentAt', () => {
    const result = evaluate('2026-11-16T00:10:10.000Z', '2026-11-16T00:10:30.000Z', '2026-11-16T00:10:20.000Z');
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') throw new Error(`expected pending, got ${result.verificationStatus}`);
    expect(result.pendingCodes).toContain('SENT_AT_PRECEDES_CEO_APPROVAL');
  });

  it('M10 zero tolerance is kept: a Date in the approval second but before it (00:10:20 vs 00:10:20.500) stays pending', () => {
    const result = evaluate('2026-11-16T00:10:20.000Z', '2026-11-16T00:10:00.000Z', '2026-11-16T00:10:20.500Z');
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') throw new Error('expected pending');
    expect(result.pendingCodes).toContain('SENT_AT_PRECEDES_CEO_APPROVAL');
  });

  it('a recorded sentAt inside the header second is kept as recorded (milliseconds preserved)', () => {
    const result = evaluate('2026-11-16T00:10:40.000Z', '2026-11-16T00:10:40.935Z', '2026-11-16T00:10:20.000Z');
    expect(result.effectiveSentAt.toISOString()).toBe('2026-11-16T00:10:40.935Z');
  });

  it('a Date that contradicts sentAt beyond the skew tolerance is not used (conflict pending, judged by sentAt)', () => {
    const result = evaluate('2026-11-16T00:40:00.000Z', '2026-11-16T00:10:00.000Z', '2026-11-16T00:10:20.000Z');
    if (result.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') throw new Error('expected pending');
    expect(result.pendingCodes).toEqual(expect.arrayContaining(['EML_DATE_SENT_AT_CONFLICT', 'SENT_AT_PRECEDES_CEO_APPROVAL']));
    expect(result.effectiveSentAt.toISOString()).toBe('2026-11-16T00:10:00.000Z');
  });

  it('API: a send whose sentAt lost its seconds is VERIFIED and stored with the EML Date (seconds included)', async () => {
    const chain = await approvedOrder();
    const poId = await createPaper(chain.orderId);
    const approved = await post('admin', `/api/maker-purchase-orders/${poId}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, poId));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Pin the approval to HH:MM:20 of a past minute; the mail left at HH:MM:40,
    // and the form sent HH:MM:00 (the seconds the minute inputs dropped).
    const minuteStart = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000);
    const approvedAt = new Date(minuteStart.getTime() + 20_000);
    const dateHeader = new Date(minuteStart.getTime() + 40_000);
    await db.update(makerPurchaseOrders).set({ ceoApprovedAt: approvedAt }).where(eq(makerPurchaseOrders.id, poId));
    const boundary = '----n2-api-boundary';
    const eml = [
      `From: KANEI <${SENDER}>`, `To: Maker <${PAPER_RECIPIENT}>`, `Subject: 製造先発注書 ${chain.code}`,
      `Date: ${dateHeader.toUTCString()}`, `Message-ID: <n2-api-${nextTag()}@mail.kanei.example>`,
      'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', `発注コード ${chain.code}`, '',
      `--${boundary}`, 'Content-Type: text/plain; name="po.txt"', 'Content-Disposition: attachment; filename="po.txt"',
      'Content-Transfer-Encoding: base64', '', b64(chain.artwork), '', `--${boundary}--`, ''
    ].join('\r\n');
    const sent = await post('staff', `/api/maker-purchase-orders/${poId}/send-evidence`, {
      contentBase64: b64(eml), senderAddress: SENDER, recipients: [PAPER_RECIPIENT], sentAt: minuteStart.toISOString()
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.pendingCodes).toEqual([]);
    expect(sent.body.verificationStatus).toBe('VERIFIED');
    const [event] = await db.select().from(makerPoEvents)
      .where(and(eq(makerPoEvents.makerPurchaseOrderId, poId), eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED')));
    expect(event!.sentAt!.toISOString()).toBe(dateHeader.toISOString());
  });
});

// ================================================================ N8
describe('N8: an Idempotency-Key answer is scoped to (user, role)', () => {
  it('the stored key is role-bound, fixed-length and inside the 0027 key-format CHECK', () => {
    const raw = 'k'.repeat(128);
    const admin = roleScopedIdempotencyKey('admin', raw);
    expect(admin).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(admin.length).toBeLessThanOrEqual(128);
    expect(roleScopedIdempotencyKey('staff', raw)).not.toBe(admin);
    expect(roleScopedIdempotencyKey('admin', raw)).toBe(admin);
  });

  it('after admin → staff the same key runs anew under the staff permission (no replay of the amount answer); back to admin it replays', async () => {
    const chain = await approvedOrder();
    const poId = await createPaper(chain.orderId, false);
    const shown = (await cardHash(poId)).makerPurchaseOrder.approvalSnapshotSha256;
    const body = { amounts: { currency: 'JPY', totalAmount: '777000' }, expectedSnapshotSha256: shown };
    const k = key();
    const first = await patch('flip', `/api/maker-purchase-orders/${poId}/amounts`, body, { 'Idempotency-Key': k });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.text).toContain('777000');
    const again = await patch('flip', `/api/maker-purchase-orders/${poId}/amounts`, body, { 'Idempotency-Key': k });
    expect(again.headers.get('idempotent-replayed')).toBe('true');

    await db.update(users).set({ role: 'staff' }).where(eq(users.id, ids.flip));
    try {
      const demoted = await patch('flip', `/api/maker-purchase-orders/${poId}/amounts`, body, { 'Idempotency-Key': k });
      expect(demoted.headers.get('idempotent-replayed')).toBeNull();
      expect(demoted.status).toBe(403);
      expect(demoted.body.code).toBe('CEO_ONLY');
      expect(demoted.text).not.toContain('777000');
    } finally {
      await db.update(users).set({ role: 'admin' }).where(eq(users.id, ids.flip));
    }
    const restored = await patch('flip', `/api/maker-purchase-orders/${poId}/amounts`, body, { 'Idempotency-Key': k });
    expect(restored.headers.get('idempotent-replayed')).toBe('true');
    expect(restored.status).toBe(200);
  });
});

// ================================================================ N1
describe('N1: project assignments (admin only, audited)', () => {
  const url = (projectId = ids.projectA) => `/api/projects/${projectId}/assignments`;

  it('the representative assigns a staff member, who can then open the project; one audit row names the actor', async () => {
    expect((await get('staffNew', `/api/projects/${ids.projectA}`)).status).toBe(403);
    const created = await post('admin', url(), { userId: ids.staffNew });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.assignment).toMatchObject({ userId: ids.staffNew, displayName: '合成新任担当P4', role: 'staff', isActive: true });
    expect(created.body.project).toEqual({ id: ids.projectA, code: PROJECT_A, name: `合成${PROJECT_A}` });
    expect((await get('staffNew', `/api/projects/${ids.projectA}`)).status).toBe(200);
    const rows = await auditRows('PROJECT_ASSIGNMENT_CREATED', created.body.assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: ids.admin, projectId: ids.projectA, entityType: 'project_assignment' });
    expect(rows[0]!.afterState).toMatchObject({ userId: ids.staffNew, projectId: ids.projectA, role: 'staff' });

    const listed = await get('admin', url());
    expect(listed.status).toBe(200);
    expect(listed.body.assignments.map((row: { userId: string }) => row.userId)).toEqual(expect.arrayContaining([ids.staff, ids.staffNew, ids.viewer, ids.auditor]));
    expect(listed.body.assignableRoles).toEqual(['staff', 'viewer', 'auditor']);
    expect(JSON.stringify(listed.body)).not.toMatch(/passwordHash|username/);
  });

  it('a second assignment of the same user is 409 PROJECT_ASSIGNMENT_EXISTS and writes nothing', async () => {
    const before = (await db.select().from(auditEvents).where(eq(auditEvents.action, 'PROJECT_ASSIGNMENT_CREATED'))).length;
    const again = await post('admin', url(), { userId: ids.staff });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'PROJECT_ASSIGNMENT_EXISTS', existing: { userId: ids.staff } });
    expect((await db.select().from(auditEvents).where(eq(auditEvents.action, 'PROJECT_ASSIGNMENT_CREATED'))).length).toBe(before);
  });

  it('staff, viewer and auditor are refused 403 CEO_ONLY on every route and nothing is written; no session is 401', async () => {
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      expect((await get(role, url())).body.code, role).toBe('CEO_ONLY');
      const refused = await post(role, url(), { userId: ids.staffNew });
      expect(refused.status, role).toBe(403);
      expect(refused.body.code).toBe('CEO_ONLY');
      expect((await del(role, `${url()}/${ids.staff}`)).status, role).toBe(403);
    }
    expect((await post(null, url(), { userId: ids.staffNew })).status).toBe(401);
    expect(await db.select().from(projectAssignments).where(eq(projectAssignments.userId, ids.staff))).toHaveLength(2);
  });

  it('refuses the representative, an inactive user, a missing user id, an unknown project and a bad path', async () => {
    expect((await post('admin', url(), { userId: ids.admin })).body).toMatchObject({ code: 'ASSIGNMENT_ROLE_NOT_ASSIGNABLE', role: 'admin' });
    expect((await post('admin', url(), { userId: ids.staffOff })).body.code).toBe('ASSIGNMENT_USER_NOT_FOUND');
    expect((await post('admin', url(), { userId: uuidv7() })).body.code).toBe('ASSIGNMENT_USER_NOT_FOUND');
    expect((await post('admin', url(), { userId: 'not-a-uuid' })).body.code).toBe('ASSIGNMENT_USER_REQUIRED');
    expect((await post('admin', url(), {})).status).toBe(422);
    expect((await post('admin', url(uuidv7()), { userId: ids.staffNew })).status).toBe(404);
    expect((await post('admin', '/api/projects/x/assignments', { userId: ids.staffNew })).status).toBe(400);
    expect((await del('admin', `${url()}/x`)).status).toBe(400);
  });

  it('a keyed repeat of the assignment replays once (one row, one audit row)', async () => {
    const k = key();
    const first = await post('admin', url(ids.projectB), { userId: ids.viewer }, { 'Idempotency-Key': k });
    const second = await post('admin', url(ids.projectB), { userId: ids.viewer }, { 'Idempotency-Key': k });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await auditRows('PROJECT_ASSIGNMENT_CREATED', first.body.assignment.id)).toHaveLength(1);
  });

  it('removing an assignment closes the project again; the audit row keeps who was removed; a second removal is 404', async () => {
    const removed = await del('admin', `${url()}/${ids.staffNew}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.removed).toMatchObject({ userId: ids.staffNew, role: 'staff' });
    expect((await get('staffNew', `/api/projects/${ids.projectA}`)).status).toBe(403);
    const rows = await auditRows('PROJECT_ASSIGNMENT_REMOVED', removed.body.removed.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: ids.admin, projectId: ids.projectA });
    expect(rows[0]!.beforeState).toMatchObject({ userId: ids.staffNew, projectId: ids.projectA });
    expect((await del('admin', `${url()}/${ids.staffNew}`)).body.code).toBe('PROJECT_ASSIGNMENT_NOT_FOUND');
  });
});

// ================================================================ H4①
describe('H4①: 金額 and 希望納期 are required at the representative approval', () => {
  it('pure gate: both missing names both; the amount decides the code first', () => {
    expect(evaluateCeoApprovalFacts({ amounts: null, requestedDeliveryDate: null }))
      .toMatchObject({ ok: false, code: 'AMOUNT_REQUIRED', missing: ['totalAmount', 'requestedDeliveryDate'] });
    expect(evaluateCeoApprovalFacts({ amounts: { currency: 'JPY', totalAmount: '1' }, requestedDeliveryDate: null }))
      .toMatchObject({ ok: false, code: 'DELIVERY_DATE_REQUIRED', missing: ['requestedDeliveryDate'] });
    expect(evaluateCeoApprovalFacts({ amounts: { currency: 'JPY', totalAmount: ' ' }, requestedDeliveryDate: '2027-01-01' }))
      .toMatchObject({ ok: false, code: 'AMOUNT_REQUIRED' });
    expect(evaluateCeoApprovalFacts({ amounts: { currency: 'JPY', totalAmount: '1' }, requestedDeliveryDate: '2027-01-01' })).toEqual({ ok: true });
  });

  it('no amount → 422 AMOUNT_REQUIRED, the paper stays DRAFT and no CEO_APPROVED event is written; the card and the queue say the same', async () => {
    const chain = await approvedOrder();
    const poId = await createPaper(chain.orderId, false);
    const card = await cardHash(poId);
    expect(card.blockers.map((blocker) => blocker.code)).toEqual(['AMOUNT_REQUIRED']);
    expect(card.canApprove).toBe(false);
    const queued = (await queue()).items.find((item) => item.key === `maker_po_ceo_approval:${poId}`);
    expect(queued!.detail.blockers.map((blocker: { code: string }) => blocker.code)).toContain('AMOUNT_REQUIRED');
    const refused = await approveRaw(poId);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'AMOUNT_REQUIRED', missing: ['totalAmount'] });
    const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId));
    expect(row).toMatchObject({ status: 'DRAFT', ceoApprovedAt: null });
    expect(await db.select().from(makerPoEvents).where(and(eq(makerPoEvents.makerPurchaseOrderId, poId), eq(makerPoEvents.eventType, 'CEO_APPROVED')))).toHaveLength(0);
  });

  it('no 希望納期 → 422 DELIVERY_DATE_REQUIRED; once the date is entered the same Idempotency-Key approves (a 4xx is never stored)', async () => {
    const chain = await approvedOrder({});
    const poId = await createPaper(chain.orderId, true);
    expect((await cardHash(poId)).blockers.map((blocker) => blocker.code)).toEqual(['DELIVERY_DATE_REQUIRED']);
    const k = key();
    const refused = await approveRaw(poId, { 'Idempotency-Key': k });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'DELIVERY_DATE_REQUIRED', missing: ['requestedDeliveryDate'] });
    expect((await patch('staff', `/api/film-supply-orders/${chain.orderId}/delivery-dates`, { requestedDeliveryDate: '2027-04-01' })).status).toBe(200);
    // The date is frozen into the snapshot, so the card hash moves; the retry sends the new hash.
    const approved = await approveRaw(poId, { 'Idempotency-Key': key() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.headers.get('idempotent-replayed')).toBeNull();
  });

  it('both missing → AMOUNT_REQUIRED with both facts; staff still get 403 CEO_ONLY first', async () => {
    const chain = await approvedOrder({});
    const poId = await createPaper(chain.orderId, false);
    expect((await post('staff', `/api/maker-purchase-orders/${poId}/ceo-approval`, {})).body.code).toBe('CEO_ONLY');
    const refused = await approveRaw(poId);
    expect(refused.body).toMatchObject({ code: 'AMOUNT_REQUIRED', missing: ['totalAmount', 'requestedDeliveryDate'] });
  });

  it('with both facts the approval goes through (unchanged path)', async () => {
    const chain = await approvedOrder();
    const poId = await createPaper(chain.orderId, true);
    expect((await cardHash(poId)).blockers).toEqual([]);
    const approved = await approveRaw(poId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });
});

// ================================================================ H7②
describe('H7②: 発注コード is numbered by the server when left blank ({案件コード}-FILM-{3 digits})', () => {
  const create = (body: Record<string, unknown>, headers: Record<string, string> = { 'Idempotency-Key': key() }, project = ids.projectB) =>
    post('staff', `/api/projects/${project}/film-supply-orders`, { paymentTerms: 'prepaid', ...body }, headers);

  it('numbers 001, 002 … per project, skips past a typed number, ignores non-numeric suffixes and keeps typed codes', async () => {
    const first = await create({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ code: `${PROJECT_B}-FILM-001`, codeSource: 'auto' });
    expect((await create({ code: '' })).body.code).toBe(`${PROJECT_B}-FILM-002`);
    expect((await create({ code: '   ' })).body.code).toBe(`${PROJECT_B}-FILM-003`);
    const typed = await create({ code: `${PROJECT_B}-FILM-007` });
    expect(typed.body).toMatchObject({ code: `${PROJECT_B}-FILM-007`, codeSource: 'manual' });
    expect((await create({ code: `${PROJECT_B}-FILM-ABC` })).status).toBe(201);
    expect((await create({ code: null })).body.code).toBe(`${PROJECT_B}-FILM-008`);
    const audit = await auditRows('FILM_SUPPLY_ORDER_CREATED', first.body.id);
    expect(audit[0]!.afterState).toMatchObject({ code: `${PROJECT_B}-FILM-001`, codeSource: 'auto' });
  });

  it('without an Idempotency-Key the numbering path is refused 400 IDEMPOTENCY_KEY_REQUIRED and creates nothing; a typed code still needs none', async () => {
    const before = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.projectId, ids.projectB));
    const refused = await create({}, {});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.projectId, ids.projectB))).toHaveLength(before.length);
    expect((await create({ code: `FSO-P4-TYPED-${nextTag()}` }, {})).status).toBe(201);
    expect((await create({ code: 42 })).body.code).toBe('ORDER_CODE_REQUIRED');
  });

  it('a keyed double submit replays one order; five parallel creates get five consecutive codes', async () => {
    const k = key();
    const one = await create({}, { 'Idempotency-Key': k });
    const two = await create({}, { 'Idempotency-Key': k });
    expect(two.headers.get('idempotent-replayed')).toBe('true');
    expect(two.body.id).toBe(one.body.id);
    const parallel = await Promise.all([0, 1, 2, 3, 4].map(() => create({})));
    expect(parallel.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201]);
    const numbers = parallel.map((answer) => Number(String(answer.body.code).slice(`${PROJECT_B}-FILM-`.length))).sort((a, b) => a - b);
    const base = Number(String(one.body.code).slice(`${PROJECT_B}-FILM-`.length));
    expect(numbers).toEqual([base + 1, base + 2, base + 3, base + 4, base + 5]);
  });

  it('the seven-PO creation path numbers the same way; viewer is still 403', async () => {
    const sevenPoId = await sevenPo(ids.projectA);
    const created = await post('staff', `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, { paymentTerms: 'prepaid' }, { 'Idempotency-Key': key() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.code).toMatch(new RegExp(`^${PROJECT_A}-FILM-\\d{3}$`));
    expect(created.body.codeSource).toBe('auto');
    expect((await post('viewer', `/api/projects/${ids.projectA}/film-supply-orders`, { paymentTerms: 'prepaid' }, { 'Idempotency-Key': key() })).status).toBe(403);
  });
});

// ================================================================ M18 + N11/M13 + N4 (queue)
describe('M18 / N11 / N4: representative queue item facts', () => {
  it('every queue order carries 希望納期・納品予定日; every item names organization and designKey (null when not applicable)', async () => {
    const chain = await approvedOrder({ requestedDeliveryDate: '2027-05-10', plannedDeliveryDate: '2027-05-20' });
    const poId = await createPaper(chain.orderId);
    const answer = await queue();
    const item = answer.items.find((candidate) => candidate.key === `maker_po_ceo_approval:${poId}`)!;
    expect(item.order).toMatchObject({ id: chain.orderId, requestedDeliveryDate: '2027-05-10', plannedDeliveryDate: '2027-05-20' });
    expect(item).toMatchObject({ organization: null, designKey: null });
    for (const candidate of answer.items) {
      expect(candidate, candidate.key).toHaveProperty('organization');
      expect(candidate, candidate.key).toHaveProperty('designKey');
      expect(candidate.order, candidate.key).toHaveProperty('requestedDeliveryDate');
    }
  });

  it('a pending approval-evidence row says which organization and design it is about, the file, its uploader and the From check', async () => {
    const chain = await orderWithRevision();
    const recorded = await recordApproval(chain, 'customer', approvalEml({ from: 'someone@other-domain.example', messageId: null }));
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.evidenceIdentifierStatus).toBe('pending_manual_verification');
    const item = (await queue()).items.find((candidate) => candidate.key === `approval_evidence_verification:${recorded.body.approvalEvent.id}`)!;
    expect(item).toMatchObject({ organization: 'customer', designKey: 'label-front' });
    expect(item.detail.evidence).toMatchObject({
      filename: expect.stringMatching(/^p4-/),
      uploadedBy: { id: ids.staff, displayName: '合成担当者P4' },
      fromAddress: 'someone@other-domain.example',
      senderDomainCheck: { status: 'mismatch', fromDomain: 'other-domain.example', registeredDomain: 'customer-p4.example' }
    });
    expect(item.detail.warnings).toEqual([expect.objectContaining({ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH' })]);
    // Display only: the warning never makes the row unconfirmable.
    expect(item.detail.confirmable).toBe(true);
  });
});

describe('N4: EML From domain against the organization registered domain (never refuse; N4(b) 2026-11-23: a mismatch waits for the manual check)', () => {
  it('pure check: match, subdomain, mismatch, no From, not an email, no registered domain', () => {
    const eml = (from: string) => Buffer.from(approvalEml({ from }), 'utf8');
    expect(evaluateEvidenceSenderDomain({ bytes: eml('a@customer-p4.example'), registeredContactEmail: CUSTOMER_MAIL }).status).toBe('match');
    expect(evaluateEvidenceSenderDomain({ bytes: eml('a@mail.customer-p4.example'), registeredContactEmail: CUSTOMER_MAIL }).status).toBe('match');
    expect(evaluateEvidenceSenderDomain({ bytes: eml('a@customer-p4.example.evil'), registeredContactEmail: CUSTOMER_MAIL }).status).toBe('mismatch');
    expect(evaluateEvidenceSenderDomain({ bytes: eml('a@evilcustomer-p4.example'), registeredContactEmail: CUSTOMER_MAIL }).status).toBe('mismatch');
    expect(evaluateEvidenceSenderDomain({ bytes: Buffer.from('From: \r\nDate: Mon, 16 Nov 2026 01:00:00 +0000\r\n\r\nx'), registeredContactEmail: CUSTOMER_MAIL }).status).toBe('from_missing');
    expect(evaluateEvidenceSenderDomain({ bytes: Buffer.from('%PDF-1.7\n'), registeredContactEmail: CUSTOMER_MAIL }).status).toBe('not_email');
    expect(evaluateEvidenceSenderDomain({ bytes: Buffer.from('identifier: X\n'), registeredContactEmail: CUSTOMER_MAIL }).status).toBe('not_email');
    expect(evaluateEvidenceSenderDomain({ bytes: eml('a@customer-p4.example'), registeredContactEmail: null }).status).toBe('no_registered_domain');
  });

  it('a mismatching From is recorded (201) with a warning; since N4(b) (2026-11-23) it waits for the representative\'s manual check instead of counting', async () => {
    const chain = await orderWithRevision();
    const recorded = await recordApproval(chain, 'seven', approvalEml({ from: 'po@not-seven.example' }));
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body).toMatchObject({
      evidenceIdentifierStatus: 'pending_manual_verification',
      countsTowardDualApproval: false,
      manualCheckReason: { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: '差出人のドメインが登録先と違います' },
      senderDomainCheck: { status: 'mismatch', fromAddress: 'po@not-seven.example', registeredDomain: 'seven-p4.example' },
      warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', fromDomain: 'not-seven.example', registeredDomain: 'seven-p4.example' }]
    });
    const [row] = await auditRows('ARTWORK_APPROVAL_RECORDED', recorded.body.approvalEvent.id);
    expect((row!.afterState as any).senderDomainCheck.status).toBe('mismatch');
  });

  it('a matching From has no warning; a project whose customer has no registered address says so', async () => {
    const chain = await orderWithRevision();
    const ok = await recordApproval(chain, 'customer', approvalEml({ from: 'boss@customer-p4.example' }));
    expect(ok.body).toMatchObject({ senderDomainCheck: { status: 'match' }, warnings: [] });
    const chainB = await orderWithRevision(ids.projectB);
    const unknown = await recordApproval(chainB, 'customer', approvalEml({ from: 'boss@customer-p4.example' }), undefined, ids.projectB);
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(201);
    expect(unknown.body).toMatchObject({ senderDomainCheck: { status: 'no_registered_domain', registeredDomain: null }, warnings: [] });
  });
});

// ================================================================ N13
describe('N13: a binding refusal names the order (and design) the file belongs to', () => {
  it('DOCUMENT_BINDING_CONFLICT carries existing.orderCode and designKey', async () => {
    const sevenPoId = await sevenPo();
    const first = await createOrder(sevenPoId);
    const second = await createOrder(sevenPoId);
    const filename = `p4-shared-${nextTag()}.txt`;
    expect((await upload(sevenPoId, first.orderId, { filename, designKey: 'label-front' })).status).toBe(201);
    const refused = await upload(sevenPoId, second.orderId, { filename, designKey: 'label-front' });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'DOCUMENT_BINDING_CONFLICT', existing: { orderId: first.orderId, orderCode: first.code, designKey: 'label-front' } });
  });

  it('FILE_DOCUMENT_ORDER_MISMATCH on a revision carries existing.orderCode', async () => {
    const chain = await orderWithRevision();
    const other = await orderWithRevision();
    const proof = await uploadOk(other.sevenPoId, other.orderId, { designKey: 'label-front' });
    const refused = await post('staff', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.version.id });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'FILE_DOCUMENT_ORDER_MISMATCH', existing: { orderId: other.orderId, orderCode: other.code, designKey: 'label-front' } });
  });
});

// ================================================================ H14 (server side)
describe('H14: a delivery the uploader may not confirm waits in the representative queue', () => {
  it('appears after staff upload the receipt evidence, stays through the self-check refusal, and leaves once the representative confirms', async () => {
    const sevenPoId = await sevenPo();
    const order = await createOrder(sevenPoId);
    const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 1000, unit: 'sheets' });
    expect(delivery.status).toBe(201);
    const itemKey = `delivery_confirmation:${delivery.body.id}`;
    expect((await queue()).items.find((item) => item.key === itemKey)).toBeUndefined();

    const doc = await uploadOk(sevenPoId, order.orderId, { documentType: 'acceptance_evidence' });
    const waiting = (await queue()).items.find((item) => item.key === itemKey)!;
    expect(waiting).toMatchObject({
      kind: 'delivery_confirmation', organization: null, designKey: null,
      order: { id: order.orderId, code: order.code },
      requestedBy: { id: ids.staff },
      detail: {
        delivery: { id: delivery.body.id, quantity: '1000.000', display: '1,000 枚' },
        reason: { code: 'SELF_VERIFICATION_FORBIDDEN' },
        evidence: [{ documentId: doc.document.id, documentVersionId: doc.version.id, verificationStatus: 'unverified', uploadedBy: { id: ids.staff } }],
        documentVerificationRequired: true
      },
      deepLink: {
        action: { method: 'POST', path: `/api/film-deliveries/${delivery.body.id}/confirmation` },
        documentAction: { method: 'POST', path: `/api/documents/${doc.document.id}/verify` }
      }
    });
    expect(JSON.stringify(waiting)).not.toMatch(/totalAmount|480000/);

    expect((await post('admin', `/api/documents/${doc.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    const self = await post('staff', `/api/film-deliveries/${delivery.body.id}/confirmation`, { evidenceDocumentVersionId: doc.version.id });
    expect(self.body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
    const still = (await queue()).items.find((item) => item.key === itemKey)!;
    expect(still.detail.documentVerificationRequired).toBe(false);
    expect(still.deepLink.documentAction).toBeUndefined();

    expect((await post('admin', `/api/film-deliveries/${delivery.body.id}/confirmation`, { evidenceDocumentVersionId: doc.version.id })).status).toBe(201);
    expect((await queue()).items.find((item) => item.key === itemKey)).toBeUndefined();
  });

  it('evidence the representative uploaded alone puts nothing in the queue (they confirm it directly)', async () => {
    const sevenPoId = await sevenPo();
    const order = await createOrder(sevenPoId);
    const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 500, unit: 'sheets' });
    await uploadOk(sevenPoId, order.orderId, { documentType: 'acceptance_evidence' }, 'admin');
    expect((await queue()).items.find((item) => item.key === `delivery_confirmation:${delivery.body.id}`)).toBeUndefined();
  });

  it('the queue stays representative-only', async () => {
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      expect((await get(role, '/api/representative-queue')).status, role).toBe(403);
    }
  });
});

// ================================================================ P4 review (REVIEW.md M-1, M-2, L-1, L-2)
describe('P4 review M-1: the judged send time passes the SENT_AT_IN_FUTURE gate too (fail closed)', () => {
  function sendMail(code: string, artwork: string, date: Date): string {
    const boundary = '----m1-boundary';
    return [
      `From: KANEI <${SENDER}>`, `To: Maker <${PAPER_RECIPIENT}>`, `Subject: 製造先発注書 ${code}`,
      `Date: ${date.toUTCString()}`, `Message-ID: <m1-${nextTag()}@mail.kanei.example>`,
      'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', `発注コード ${code}`, '',
      `--${boundary}`, 'Content-Type: text/plain; name="po.txt"', 'Content-Disposition: attachment; filename="po.txt"',
      'Content-Transfer-Encoding: base64', '', b64(artwork), '', `--${boundary}--`, ''
    ].join('\r\n');
  }
  async function approvedPaper() {
    const chain = await approvedOrder();
    const poId = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${poId}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, poId))).status).toBe(200);
    return { chain, poId };
  }

  it('declared now+9 min with a Date of now+18 min is refused 422 SENT_AT_IN_FUTURE; nothing is recorded, the evidence file included', async () => {
    const { chain, poId } = await approvedPaper();
    const now = Date.now();
    const refused = await post('staff', `/api/maker-purchase-orders/${poId}/send-evidence`, {
      contentBase64: b64(sendMail(chain.code, chain.artwork, new Date(now + 18 * 60_000))),
      senderAddress: SENDER, recipients: [PAPER_RECIPIENT], sentAt: new Date(now + 9 * 60_000).toISOString()
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.code).toBe('SENT_AT_IN_FUTURE');
    expect(new Date(refused.body.sentAt).getTime()).toBeGreaterThan(now + 17 * 60_000);
    expect(await db.select().from(makerPoEvents)
      .where(and(eq(makerPoEvents.makerPurchaseOrderId, poId), eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED')))).toHaveLength(0);
    expect(await db.select().from(documents)
      .where(and(eq(documents.makerPurchaseOrderId, poId), eq(documents.documentType, 'send_evidence')))).toHaveLength(0);
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)))[0]!.status).toBe('APPROVED_FOR_MANUAL_SEND');
  });

  it('a Date a few minutes ahead (inside the allowed skew) still verifies and is stored as the header says', async () => {
    const { chain, poId } = await approvedPaper();
    const now = Date.now();
    const date = new Date(Math.floor((now + 4 * 60_000) / 1000) * 1000);
    const sent = await post('staff', `/api/maker-purchase-orders/${poId}/send-evidence`, {
      contentBase64: b64(sendMail(chain.code, chain.artwork, date)),
      senderAddress: SENDER, recipients: [PAPER_RECIPIENT], sentAt: new Date(now + 60_000).toISOString()
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.verificationStatus).toBe('VERIFIED');
    expect(new Date(sent.body.event.sentAt).toISOString()).toBe(date.toISOString());
  });
});

describe('P4 review M-2: N2 boundaries and the N8 wait path', () => {
  const RECIPIENT = 'maker@example.com';
  const ARTWORK = 'm2 approved artwork\n';
  function mail(dateIso: string): Buffer {
    const boundary = '----m2-boundary';
    return Buffer.from([
      `From: KANEI <${SENDER}>`, `To: Maker <${RECIPIENT}>`, 'Subject: 製造先発注書 FSO-M2-0001',
      `Date: ${new Date(dateIso).toUTCString()}`, 'Message-ID: <m2@mail.kanei.example>',
      'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', '添付します', '',
      `--${boundary}`, 'Content-Type: text/plain; name="po.txt"', 'Content-Disposition: attachment; filename="po.txt"',
      'Content-Transfer-Encoding: base64', '', b64(ARTWORK), '', `--${boundary}--`, ''
    ].join('\r\n'), 'utf8');
  }
  const evaluate = (dateIso: string, sentAtIso: string, approvedIso: string) => evaluateMakerPoEmlEvidence({
    bytes: mail(dateIso), sentAt: new Date(sentAtIso), ceoApprovedAt: new Date(approvedIso), now: new Date('2026-11-16T02:00:00.000Z'),
    expectedRecipientAddress: RECIPIENT, recordedSenderAddress: SENDER, subjectIdentifiers: ['FSO-M2-0001'],
    artworkFileSha256s: [sha256(ARTWORK)]
  });

  it('a Date exactly equal to the approval instant is not "before" it (strict <): VERIFIED', () => {
    const result = evaluate('2026-11-16T00:10:20.000Z', '2026-11-16T00:10:00.000Z', '2026-11-16T00:10:20.000Z');
    expect(result.effectiveSentAt.toISOString()).toBe('2026-11-16T00:10:20.000Z');
    expect(result.verificationStatus).toBe('VERIFIED');
  });

  it('a Date exactly at the 10-minute skew tolerance is adopted; one second more is a conflict judged by sentAt', () => {
    const at = evaluate('2026-11-16T00:20:00.000Z', '2026-11-16T00:10:00.000Z', '2026-11-16T00:05:00.000Z');
    expect(at.effectiveSentAt.toISOString()).toBe('2026-11-16T00:20:00.000Z');
    expect(at.verificationStatus).toBe('VERIFIED');
    const over = evaluate('2026-11-16T00:20:01.000Z', '2026-11-16T00:10:00.000Z', '2026-11-16T00:05:00.000Z');
    expect(over.effectiveSentAt.toISOString()).toBe('2026-11-16T00:10:00.000Z');
    if (over.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') throw new Error('expected pending');
    expect(over.pendingCodes).toContain('EML_DATE_SENT_AT_CONFLICT');
  });

  it('N8: a request that waited on a forgotten first answer begins again with the same role-scoped key', async () => {
    const inner = new IdempotencyStore();
    const keys: string[] = [];
    let secondArrived!: () => void;
    const arrived = new Promise<void>((resolve) => { secondArrived = resolve; });
    const spy: IdempotencyBackend = {
      begin(scope, storedKey, fingerprint) {
        keys.push(storedKey);
        if (keys.length === 2) secondArrived();
        const lookup = inner.begin(scope, storedKey, fingerprint);
        if (keys.length === 1 && lookup.kind === 'execute') {
          // Hold the first answer until the second request is waiting on it.
          const complete = lookup.complete;
          return { kind: 'execute', complete: async (answer) => {
            await Promise.race([arrived, new Promise((resolve) => setTimeout(resolve, 5000))]);
            await complete(answer);
          } };
        }
        return lookup;
      }
    };
    const waitingApp = createApp({ db, idempotencyStore: spy });
    const k = key();
    const request = () => waitingApp.request(`/api/projects/${ids.projectA}/seven-purchase-orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${tokens.staff}`, 'Idempotency-Key': k },
      body: JSON.stringify({})
    });
    const answers = await Promise.all([request(), request()]);
    // The first answer is a refusal (4xx), so it is forgotten and the waiter runs itself.
    expect(answers.map((answer) => answer.status)).toEqual([422, 422]);
    expect(keys).toHaveLength(3);
    expect(keys).toEqual(Array(3).fill(roleScopedIdempotencyKey('staff', k)));
  });
});

describe('P4 review L-2: a logically deleted user cannot be assigned', () => {
  it('deleted_at set (even with is_active true) → 422 ASSIGNMENT_USER_NOT_FOUND, no row', async () => {
    const refused = await post('admin', `/api/projects/${ids.projectA}/assignments`, { userId: ids.staffDeleted });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('ASSIGNMENT_USER_NOT_FOUND');
    expect(await db.select().from(projectAssignments).where(eq(projectAssignments.userId, ids.staffDeleted))).toHaveLength(0);
  });
});

describe('P4 review L-1: From shapes that cannot be compared become warnings (never refusals)', () => {
  const raw = (lines: string[]) => Buffer.from([...lines, '', '本文', ''].join('\r\n'), 'utf8');
  const check = (bytes: Buffer) => evaluateEvidenceSenderDomain({ bytes, registeredContactEmail: CUSTOMER_MAIL });

  it('a mail with only a From header (no Message-ID, Date or Received) is still compared', () => {
    expect(check(raw(['From: 承認者 <a@customer-p4.example>', 'Subject: 承認'])).status).toBe('match');
    expect(check(raw(['From: 承認者 <a@other.example>', 'Subject: 承認'])).status).toBe('mismatch');
  });

  it('an IP literal is compared as written and reported as a mismatch', () => {
    const result = check(raw(['From: a@[203.0.113.5]', 'Date: Mon, 16 Nov 2026 01:00:00 +0000']));
    expect(result).toMatchObject({ status: 'mismatch', fromDomain: '[203.0.113.5]' });
  });

  it('two From headers, or one From with two addresses, are multiple_from (the first is never trusted alone)', () => {
    expect(check(raw(['From: good <a@customer-p4.example>', 'From: evil <b@evil.example>', 'Date: Mon, 16 Nov 2026 01:00:00 +0000'])).status).toBe('multiple_from');
    expect(check(raw(['From: a@customer-p4.example, b@evil.example', 'Date: Mon, 16 Nov 2026 01:00:00 +0000'])).status).toBe('multiple_from');
  });

  it('a non-ASCII (homograph) domain is from_missing, not a silent match', () => {
    expect(check(raw(['From: a@customer-p4.exаmple', 'Date: Mon, 16 Nov 2026 01:00:00 +0000'])).status).toBe('from_missing');
  });

  it('the warning helper: mismatch → DOMAIN_MISMATCH; from_missing / multiple_from → UNVERIFIABLE; the rest → none', () => {
    const base = { fromAddress: null, fromDomain: null, registeredDomain: 'customer-p4.example' };
    expect(evidenceSenderDomainWarning({ ...base, status: 'mismatch' })?.code).toBe('EVIDENCE_SENDER_DOMAIN_MISMATCH');
    expect(evidenceSenderDomainWarning({ ...base, status: 'from_missing' })?.code).toBe('EVIDENCE_SENDER_UNVERIFIABLE');
    expect(evidenceSenderDomainWarning({ ...base, status: 'multiple_from' })?.code).toBe('EVIDENCE_SENDER_UNVERIFIABLE');
    for (const status of ['match', 'not_email', 'no_registered_domain'] as const) {
      expect(evidenceSenderDomainWarning({ ...base, status }), status).toBeNull();
    }
    expect(evidenceSenderDomainWarning(null)).toBeNull();
  });

  it('API: an approval mail with two From headers is recorded (201) with the UNVERIFIABLE warning; counting is unchanged', async () => {
    const chain = await orderWithRevision();
    const tag = nextTag();
    const eml = [
      'From: 承認者 <boss@customer-p4.example>', 'From: 別人 <x@evil.example>',
      'To: KANEI 担当 <staff@kanei.example>', `Subject: 校正承認 ${tag}`, 'Date: Mon, 16 Nov 2026 01:00:00 +0000',
      `Message-ID: <approval-${tag}@mail.example>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', `承認します（${tag}）`, ''
    ].join('\r\n');
    const recorded = await recordApproval(chain, 'customer', eml);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body).toMatchObject({
      evidenceIdentifierStatus: 'verified_in_document',
      countsTowardDualApproval: true,
      senderDomainCheck: { status: 'multiple_from' },
      warnings: [{ code: 'EVIDENCE_SENDER_UNVERIFIABLE' }]
    });
  });
});
