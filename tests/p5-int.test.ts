/**
 * P5 int (audit44b REMAINING §0–§1, conductor 2026-11-23): the server half of
 * R1 (却下 dead end), N4(b) (a mail from another domain waits for the
 * representative's check like a PDF), R5 (取引先の連絡先), R3 (監査履歴の根拠),
 * R8 (受領証跡の発行元 on the delivery queue row).
 * Every block has normal, refusal and permission cases; the ones that pin new
 * behaviour fail on the base p4/rc a5dd052 (evidence: demo-eml/p5-int/evidence).
 * Runs only against kanei_crm_mvp_test (tests/setup.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  artworkApprovalEvents,
  artworkRevisions,
  auditEvents,
  createDatabase,
  filmSupplyOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { canPerform, maskAmountsInNote, NOTE_AMOUNT_MASK, senderDomainRequiresManualVerification } from '@kanei/core';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE, sessionTokenHashForRole } from '../apps/api/src/auth.js';
import { withApprovalSnapshot } from './helpers/approval-snapshot.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p5-int tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const ids = {
  admin: uuidv7(), staff: uuidv7(), viewer: uuidv7(), auditor: uuidv7(),
  customer: uuidv7(), customerNoMail: uuidv7(), seven: uuidv7(), maker: uuidv7(), customerGone: uuidv7(),
  projectA: uuidv7(), projectB: uuidv7()
};
const CUSTOMER_MAIL = 'approvals@customer-p5.example';
const SEVEN_MAIL = 'po@seven-p5.example';
const DISPLAY = { admin: '合成代表者P5', staff: '合成担当者P5', viewer: '合成閲覧者P5', auditor: '合成監査P5' } as const;
const tokens = { admin: '', staff: '', viewer: '', auditor: '' };
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
      ...(method === 'GET' ? {} : { 'Idempotency-Key': `p5-${tag()}-key` })
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
const patch = (role: Role | null, url: string, body: unknown) => send(role, 'PATCH', url, body);

function fullChecklist() {
  return {
    issuerNameRecorded: true, issuerName: '合成セブン化学P5',
    documentNumberRecorded: true, documentNumber: 'PO-P5-0001',
    issueDateRecorded: true, issueDate: '2026-11-11',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル',
    pastTransactionCompared: true, pastTransactionNote: '過去の発注書と一致',
    quoteCompared: true, quoteMatchesPo: true, quoteComparisonNote: '見積と一致',
    tamperHints: '', uncertain: false, confirmationReplyRecorded: false, confirmationReplyNote: '',
    verificationNote: '合成チェックリストP5'
  };
}

async function sevenPo(project: string) {
  const created = await post('staff', `/api/projects/${project}/seven-purchase-orders`, {
    poNumber: `SEVEN-P5-${tag()}`, officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status, created.text).toBe(201);
  expect((await post('staff', `/api/seven-purchase-orders/${created.body.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  return created.body.id as string;
}

type Chain = { project: string; sevenPoId: string; orderId: string; code: string; lineId: string; revisionId: string };

/** An order at 校了 (one proof revision of design label-front), with 希望納期 (the 代表承認 needs it). */
async function orderAtApproval(project = ids.projectA): Promise<Chain> {
  const sevenPoId = await sevenPo(project);
  const code = `FSO-P5-${tag()}`;
  const created = await post('staff', `/api/projects/${project}/film-supply-orders`, {
    code, paymentTerms: 'prepaid', sevenPurchaseOrderId: sevenPoId, requestedDeliveryDate: '2027-04-30',
    lines: [{ lineNumber: 1, description: '合成フィルムP5', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(created.status, created.text).toBe(201);
  const orderId = created.body.id as string;
  expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
  const proof = await post('staff', `/api/projects/${project}/documents`, {
    documentType: 'proof', issuerEntity: 'kanei', filename: `p5-proof-${tag()}.txt`, contentType: 'text/plain',
    contentBase64: b64(`p5 artwork ${tag()}\n`), sevenPurchaseOrderId: sevenPoId, filmSupplyOrderId: orderId, designKey: 'label-front'
  });
  expect(proof.status, proof.text).toBe(201);
  const revision = await post('staff', `/api/film-supply-orders/${orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.body.version.id });
  expect(revision.status, revision.text).toBe(201);
  return { project, sevenPoId, orderId, code, lineId: created.body.lines[0].id as string, revisionId: revision.body.id as string };
}

function approvalEml(from: string, stamp = tag()): string {
  return [
    `From: 承認者 <${from}>`, 'To: KANEI 担当 <staff@kanei.example>', `Subject: 校正承認 ${stamp}`,
    'Date: Mon, 16 Nov 2026 01:00:00 +0000', `Message-ID: <approval-${stamp}@mail.example>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', `承認します（${stamp}）`, ''
  ].join('\r\n');
}
const pdf = (stamp = tag()) => `%PDF-1.4\n% p5 approval ${stamp}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n`;

async function uploadEvidence(chain: Chain, organization: 'customer' | 'seven', kind: 'eml' | 'pdf', content: string) {
  const uploaded = await post('staff', `/api/projects/${chain.project}/documents`, {
    documentType: 'approval_evidence', issuerEntity: organization === 'customer' ? 'customer_generated' : 'seven',
    filename: `p5-${organization}-${tag()}.${kind}`, contentType: kind === 'eml' ? 'text/plain' : 'application/pdf',
    contentBase64: b64(content), sevenPurchaseOrderId: chain.sevenPoId, filmSupplyOrderId: chain.orderId, designKey: 'label-front'
  });
  expect(uploaded.status, uploaded.text).toBe(201);
  return uploaded.body as { document: { id: string }; version: { id: string } };
}

async function recordApproval(chain: Chain, organization: 'customer' | 'seven', kind: 'eml' | 'pdf', content: string) {
  const doc = await uploadEvidence(chain, organization, kind, content);
  const approval = await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
    organization, decision: 'APPROVE', evidenceSource: kind === 'eml' ? 'email' : 'signed_document', eventTime: '2026-11-15T10:00:00.000Z',
    evidenceIdentifier: `P5-ID-${tag()}`, evidenceDocumentVersionId: doc.version.id
  });
  return { ...approval, versionId: doc.version.id, documentId: doc.document.id };
}

const verify = (eventId: string, result: 'confirmed' | 'rejected', reasonNote: string) =>
  post('admin', `/api/artwork-approval-events/${eventId}/verification`, { result, reasonNote });
const gateOf = async (role: Role, orderId: string) => {
  const answer = await get(role, `/api/film-supply-orders/${orderId}/approval-gate`);
  expect(answer.status, answer.text).toBe(200);
  return answer.body;
};
async function queue() {
  const answer = await get('admin', '/api/representative-queue');
  expect(answer.status, answer.text).toBe(200);
  return answer.body as { items: Array<Record<string, any>>; blocked: Array<Record<string, any>>; counts: Record<string, any> };
}
async function orderStatus(orderId: string) {
  const [row] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId));
  return String(row!.status);
}
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((entry) => allKeys(entry, out));
  else if (value && typeof value === 'object') for (const [name, entry] of Object.entries(value)) { out.push(name); allKeys(entry, out); }
  return out;
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p5-int-'));
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
  await db.insert(users).values((['admin', 'staff', 'viewer', 'auditor'] as const).map((name) => ({
    id: ids[name], username: `${name}_p5`, passwordHash: 'not-a-login-hash', displayName: DISPLAY[name], role: name
  })) as any);
  await db.insert(accounts).values([
    { id: ids.customer, name: '合成P5顧客', role: 'end_customer', externalCode: 'P5-CUST', contactEmail: CUSTOMER_MAIL },
    { id: ids.customerNoMail, name: '合成P5顧客（連絡先なし）', role: 'end_customer', externalCode: 'P5-CUST-NOMAIL' },
    { id: ids.seven, name: '合成P5セブン', role: 'seven', externalCode: 'P5-SEVEN', contactEmail: SEVEN_MAIL },
    { id: ids.maker, name: '合成P5メーカー', role: 'maker', externalCode: 'P5-MAKER', contactEmail: 'maker@maker-p5.example' },
    { id: ids.customerGone, name: '合成P5顧客（削除済み）', role: 'end_customer', externalCode: 'P5-GONE', deletedAt: new Date('2026-11-01T00:00:00Z') }
  ] as any);
  const now = new Date();
  for (const [id, code, customer] of [[ids.projectA, 'P5-A', ids.customer], [ids.projectB, 'P5-B', ids.customerNoMail]] as const) {
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
    await db.insert(sessions).values({
      id: uuidv7(), userId: ids[role], tokenHash: sessionTokenHashForRole(tokenHash, role === 'auditor' ? 'auditor' : 'staff'),
      expiresAt: new Date(Date.now() + 3600_000)
    });
    tokens[role] = token;
  }
});

afterAll(async () => {
  await pool.end();
});

// ===================================================================== R1
describe('R1: after the representative rejects an evidence, the organization records its approval again', () => {
  const REASON = '押印欄の会社名がセブン化学ではない。見積480,000円の書類と取り違え';

  async function rejectedSeven() {
    const chain = await orderAtApproval();
    const customer = await recordApproval(chain, 'customer', 'eml', approvalEml('boss@customer-p5.example'));
    expect(customer.status, customer.text).toBe(201);
    expect(customer.body.countsTowardDualApproval).toBe(true);
    const seven = await recordApproval(chain, 'seven', 'pdf', pdf());
    expect(seven.status, seven.text).toBe(201);
    expect(seven.body.evidenceIdentifierStatus).toBe('pending_manual_verification');
    const rejected = await verify(seven.body.approvalEvent.id, 'rejected', REASON);
    expect(rejected.status, rejected.text).toBe(201);
    return { chain, rejectedEventId: seven.body.approvalEvent.id as string, rejectedVersionId: seven.versionId };
  }

  it('measured first: the API accepts a NEW APPROVE for the same revision and organization (201), linked to the rejected one', async () => {
    const { chain, rejectedEventId } = await rejectedSeven();
    const again = await recordApproval(chain, 'seven', 'pdf', pdf());
    expect(again.status, again.text).toBe(201);
    expect(again.body.approvalEvent).toMatchObject({ organization: 'seven', decision: 'APPROVE', supersedesEventId: rejectedEventId });
    expect(again.body).toMatchObject({ evidenceIdentifierStatus: 'pending_manual_verification', countsTowardDualApproval: false });
  });

  it('the gate says the slot is rejected (core flag), with who, when and why; the new APPROVE drops the flag', async () => {
    const { chain } = await rejectedSeven();
    const gate = await gateOf('staff', chain.orderId);
    expect(gate.designs[0].seven).toMatchObject({
      valid: false, pendingEvidenceIdentifier: true, rejected: true,
      manualVerification: { result: 'rejected', verifierName: DISPLAY.admin }
    });
    expect(gate.designs[0].customer).toMatchObject({ valid: true, rejected: false });
    await recordApproval(chain, 'seven', 'pdf', pdf());
    const after = await gateOf('staff', chain.orderId);
    expect(after.designs[0].seven).toMatchObject({ valid: false, pendingEvidenceIdentifier: true, rejected: false, manualVerification: null });
  });

  it('the reason reaches the representative as written, staff and auditor with the amount masked, the viewer not at all', async () => {
    const { chain } = await rejectedSeven();
    expect((await gateOf('admin', chain.orderId)).designs[0].seven.manualVerification.reasonNote).toBe(REASON);
    for (const role of ['staff', 'auditor'] as const) {
      const note = (await gateOf(role, chain.orderId)).designs[0].seven.manualVerification.reasonNote as string;
      expect(note, role).toContain('押印欄の会社名がセブン化学ではない');
      expect(note, role).toContain(NOTE_AMOUNT_MASK);
      expect(note, role).not.toMatch(/480,?000/);
    }
    // The viewer cannot read the gate at all (403, unchanged); the server's null for it is a fail-closed default.
    expect((await get('viewer', `/api/film-supply-orders/${chain.orderId}/approval-gate`)).status).toBe(403);
  });

  it('the representative queue lists it as stuck (fixable by staff or the representative) instead of dropping it', async () => {
    const { chain, rejectedEventId } = await rejectedSeven();
    const answer = await queue();
    expect(answer.items.find((item) => item.subjectId === rejectedEventId)).toBeUndefined();
    const row = answer.blocked.find((item) => item.key === `approval_evidence_rejected:${rejectedEventId}`);
    expect(row, 'rejected evidence missing from blocked').toBeDefined();
    expect(row).toMatchObject({
      kind: 'approval_evidence_rejected', organization: 'seven', designKey: 'label-front',
      order: { id: chain.orderId, code: chain.code },
      reason: { code: 'APPROVAL_EVIDENCE_REJECTED' },
      fixableBy: ['admin', 'staff'],
      detail: { organization: 'seven', revisionNo: 1, rejection: { verifierName: DISPLAY.admin, reasonNote: REASON },
        evidenceIssuerEntity: 'seven', evidence: { filename: expect.stringMatching(/^p5-seven-.*\.pdf$/) } },
      deepLink: { step: 'approval', subjectId: rejectedEventId, action: { method: 'POST', path: `/api/artwork-revisions/${chain.revisionId}/approvals` } }
    });
    expect(row!.reason.message).toContain('セブン化学の承認証跡（デザイン label-front）は却下されました');
    expect(answer.counts.blocked).toBe(answer.blocked.length);
    expect(allKeys(row)).not.toContain('totalAmount');
  });

  it('T-5: rejected → re-recorded → confirmed → the order completes 校了 (dual approval, the order moves on)', async () => {
    const { chain, rejectedEventId } = await rejectedSeven();
    expect(await orderStatus(chain.orderId)).toBe('APPROVAL_PENDING');
    const again = await recordApproval(chain, 'seven', 'pdf', pdf());
    expect(again.status, again.text).toBe(201);
    let answer = await queue();
    expect(answer.blocked.find((item) => item.key === `approval_evidence_rejected:${rejectedEventId}`), 'the row leaves with the new approval').toBeUndefined();
    expect(answer.items.find((item) => item.key === `approval_evidence_verification:${again.body.approvalEvent.id}`), 'the new one waits for the check').toBeDefined();
    const confirmed = await verify(again.body.approvalEvent.id, 'confirmed', '押印欄にセブン化学の社名と識別子を確認');
    expect(confirmed.status, confirmed.text).toBe(201);
    expect(confirmed.body).toMatchObject({ countsTowardDualApproval: true, dualApproved: true, missingApprovals: [] });
    expect(['DUAL_APPROVED', 'MAKER_PO_READY']).toContain(await orderStatus(chain.orderId));
    answer = await queue();
    expect(answer.items.find((item) => item.subjectId === again.body.approvalEvent.id)).toBeUndefined();
  });

  it('rules unchanged: the same rejected version cannot be cited again without naming it, and staff can never verify', async () => {
    const { chain, rejectedVersionId } = await rejectedSeven();
    const same = await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
      organization: 'seven', decision: 'APPROVE', evidenceSource: 'signed_document', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: `P5-ID-${tag()}`, evidenceDocumentVersionId: rejectedVersionId
    });
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('EVIDENCE_DUPLICATE_REGISTRATION');
    const again = await recordApproval(chain, 'seven', 'pdf', pdf());
    const refused = await post('staff', `/api/artwork-approval-events/${again.body.approvalEvent.id}/verification`, { result: 'confirmed', reasonNote: 'x' });
    expect(refused.status).toBe(403);
  });

  it('a rejected approval on an older revision is not listed (only the current revision decides)', async () => {
    const { chain, rejectedEventId } = await rejectedSeven();
    expect((await queue()).blocked.find((item) => item.key === `approval_evidence_rejected:${rejectedEventId}`)).toBeDefined();
    // The state a finished change review leaves: a second revision of the design (fixture insert — the
    // change-review flow itself is covered by its own tests). The old revision's 却下 no longer decides anything.
    const [current] = await db.select().from(artworkRevisions).where(eq(artworkRevisions.id, chain.revisionId));
    await db.insert(artworkRevisions).values({ ...current!, id: uuidv7(), revisionNo: 2, fileSha256: 'b'.repeat(64), createdAt: new Date() } as any);
    expect((await queue()).blocked.find((item) => item.key === `approval_evidence_rejected:${rejectedEventId}`)).toBeUndefined();
  });
});

// ===================================================================== N4(b)
describe('N4(b) (2026-11-23): a mail from another domain is recorded but waits for the representative like a PDF', () => {
  it('core: only a compared, differing domain holds the approval', () => {
    expect(senderDomainRequiresManualVerification({ status: 'mismatch', fromAddress: 'a@x.example', fromDomain: 'x.example', registeredDomain: 'y.example' })).toBe(true);
    for (const status of ['match', 'from_missing', 'multiple_from', 'no_registered_domain', 'not_email'] as const) {
      expect(senderDomainRequiresManualVerification({ status, fromAddress: null, fromDomain: null, registeredDomain: null }), status).toBe(false);
    }
    expect(senderDomainRequiresManualVerification(null)).toBe(false);
  });

  it('a customer-domain mail in the セブン化学 slot: 201 (never refused), pending, not counted, with the reason; the order does not complete', async () => {
    const chain = await orderAtApproval();
    expect((await recordApproval(chain, 'customer', 'eml', approvalEml('boss@customer-p5.example'))).body.countsTowardDualApproval).toBe(true);
    const foreign = await recordApproval(chain, 'seven', 'eml', approvalEml('boss@customer-p5.example'));
    expect(foreign.status, foreign.text).toBe(201);
    expect(foreign.body).toMatchObject({
      evidenceIdentifierStatus: 'pending_manual_verification',
      countsTowardDualApproval: false,
      dualApproved: false,
      senderDomainCheck: { status: 'mismatch', fromDomain: 'customer-p5.example', registeredDomain: 'seven-p5.example' },
      warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH' }],
      manualCheckReason: { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: '差出人のドメインが登録先と違います' }
    });
    const [stored] = await db.select({ status: artworkApprovalEvents.evidenceIdentifierStatus }).from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, foreign.body.approvalEvent.id));
    expect(stored!.status).toBe('pending_manual_verification');
    expect(await orderStatus(chain.orderId)).toBe('APPROVAL_PENDING');
  });

  it('the gate and the queue say why it waits (「差出人のドメインが登録先と違います」), and it stays confirmable', async () => {
    const chain = await orderAtApproval();
    const foreign = await recordApproval(chain, 'customer', 'eml', approvalEml('someone@evil-p5.example'));
    const pending = (await gateOf('admin', chain.orderId)).pendingManualVerifications
      .find((entry: { approvalEventId: string }) => entry.approvalEventId === foreign.body.approvalEvent.id);
    expect(pending).toMatchObject({
      confirmable: true, recordedAsPending: true,
      manualCheckReason: { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: '差出人のドメインが登録先と違います' },
      senderVerdict: { code: 'mismatch' }
    });
    const item = (await queue()).items.find((row) => row.key === `approval_evidence_verification:${foreign.body.approvalEvent.id}`);
    expect(item, 'mismatch mail missing from the check queue').toBeDefined();
    expect(item).toMatchObject({
      reason: { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: '差出人のドメインが登録先と違います' },
      detail: { confirmable: true, manualCheckReason: { message: '差出人のドメインが登録先と違います' } }
    });
  });

  it('the representative\'s 「確認」 counts it: both approvals → 校了', async () => {
    const chain = await orderAtApproval();
    const foreign = await recordApproval(chain, 'customer', 'eml', approvalEml('someone@evil-p5.example'));
    expect((await recordApproval(chain, 'seven', 'eml', approvalEml('po@seven-p5.example'))).body.countsTowardDualApproval).toBe(true);
    expect(await orderStatus(chain.orderId)).toBe('APPROVAL_PENDING');
    const confirmed = await verify(foreign.body.approvalEvent.id, 'confirmed', '顧客の担当者が私用アドレスから送ったことを電話で確認');
    expect(confirmed.status, confirmed.text).toBe(201);
    expect(confirmed.body).toMatchObject({ countsTowardDualApproval: true, dualApproved: true });
  });

  it('unchanged: a matching mail counts at once; an unreadable From and an unregistered contact still only warn / say so', async () => {
    const chain = await orderAtApproval();
    const match = await recordApproval(chain, 'customer', 'eml', approvalEml('boss@mail.customer-p5.example'));
    expect(match.body).toMatchObject({ evidenceIdentifierStatus: 'verified_in_document', countsTowardDualApproval: true, manualCheckReason: null });
    const twoFrom = approvalEml('po@seven-p5.example').replace('From: 承認者 <po@seven-p5.example>', 'From: 承認者 <po@seven-p5.example>\r\nFrom: 別人 <x@evil-p5.example>');
    const unverifiable = await recordApproval(chain, 'seven', 'eml', twoFrom);
    expect(unverifiable.status, unverifiable.text).toBe(201);
    expect(unverifiable.body).toMatchObject({ countsTowardDualApproval: true, senderDomainCheck: { status: 'multiple_from' }, manualCheckReason: null });
    const chainB = await orderAtApproval(ids.projectB);
    const unregistered = await recordApproval(chainB, 'customer', 'eml', approvalEml('boss@anywhere-p5.example'));
    expect(unregistered.body).toMatchObject({ countsTowardDualApproval: true, senderDomainCheck: { status: 'no_registered_domain' }, manualCheckReason: null });
  });

  it('a REVOKE citing a foreign mail is not held (it never counts toward an approval anyway)', async () => {
    const chain = await orderAtApproval();
    const doc = await uploadEvidence(chain, 'customer', 'eml', approvalEml('someone@evil-p5.example'));
    const revoke = await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
      organization: 'customer', decision: 'REVOKE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: `P5-ID-${tag()}`, evidenceDocumentVersionId: doc.version.id
    });
    expect(revoke.status, revoke.text).toBe(201);
    expect(revoke.body).toMatchObject({ evidenceIdentifierStatus: 'not_applicable', manualCheckReason: null });
  });
});

// ===================================================================== R5
describe('R5: 取引先の連絡先 — the representative sets the customer / セブン化学 contact address (audited)', () => {
  it('GET lists the customers and セブン化学 (no maker, no deleted account) with their address and projects', async () => {
    const answer = await get('admin', '/api/partner-accounts');
    expect(answer.status, answer.text).toBe(200);
    const listed = answer.body.accounts as Array<Record<string, any>>;
    expect(listed.map((row) => row.id).sort()).toEqual([ids.customer, ids.customerNoMail, ids.seven].sort());
    expect(listed.find((row) => row.id === ids.customer)).toMatchObject({ role: 'end_customer', contactEmail: CUSTOMER_MAIL, projectCodes: ['P5-A'] });
    expect(listed.find((row) => row.id === ids.seven)).toMatchObject({ role: 'seven', contactEmail: SEVEN_MAIL, projectCodes: ['P5-A', 'P5-B'] });
    for (const row of listed) expect(Object.keys(row).sort()).toEqual(['contactEmail', 'externalCode', 'id', 'isActive', 'name', 'projectCodes', 'role', 'updatedAt']);
    expect(answer.text).not.toContain('maker@maker-p5.example');
  });

  it('core: partner_contact:manage is the representative\'s alone — an assigned staff / viewer / auditor never gets it, on any project', () => {
    const actor = (role: 'admin' | 'staff' | 'viewer' | 'auditor') => ({ id: 'u', role, isActive: true, assignedProjectIds: [ids.projectA] });
    expect(canPerform(actor('admin'), 'partner_contact:manage', 'F1')).toEqual({ allowed: true });
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      expect(canPerform(actor(role), 'partner_contact:manage', 'F1', ids.projectA), role).toEqual({ allowed: false, reason: 'ROLE_FORBIDDEN' });
    }
  });

  it('401 without a session; 403 CEO_ONLY to staff, viewer and auditor (GET and PATCH), and nothing changes', async () => {
    expect((await get(null, '/api/partner-accounts')).status).toBe(401);
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      expect((await get(role, '/api/partner-accounts')).body, role).toEqual({ error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' });
      const refused = await patch(role, `/api/partner-accounts/${ids.customer}/contact-email`, { contactEmail: 'x@evil.example' });
      expect(refused.status, role).toBe(403);
    }
    const [row] = await db.select({ contactEmail: accounts.contactEmail }).from(accounts).where(eq(accounts.id, ids.customer));
    expect(row!.contactEmail).toBe(CUSTOMER_MAIL);
  });

  it('PATCH sets it (lower-cased), writes PARTNER_CONTACT_EMAIL_UPDATED before → after, and the next mail is judged by it', async () => {
    const chain = await orderAtApproval(ids.projectB);
    const before = await recordApproval(chain, 'customer', 'eml', approvalEml('boss@customer-b-p5.example'));
    expect(before.body.senderDomainCheck.status).toBe('no_registered_domain');
    const set = await patch('admin', `/api/partner-accounts/${ids.customerNoMail}/contact-email`, { contactEmail: ' Approvals@Customer-B-P5.example ' });
    expect(set.status, set.text).toBe(200);
    expect(set.body).toEqual({ id: ids.customerNoMail, name: '合成P5顧客（連絡先なし）', role: 'end_customer', contactEmail: 'approvals@customer-b-p5.example', changed: true });
    const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'PARTNER_CONTACT_EMAIL_UPDATED'), eq(auditEvents.entityId, ids.customerNoMail)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: ids.admin, entityType: 'account', projectId: null,
      beforeState: { contactEmail: null }, afterState: { contactEmail: 'approvals@customer-b-p5.example' } });
    const chain2 = await orderAtApproval(ids.projectB);
    const judged = await recordApproval(chain2, 'customer', 'eml', approvalEml('boss@customer-b-p5.example'));
    expect(judged.body.senderDomainCheck).toMatchObject({ status: 'match', registeredDomain: 'customer-b-p5.example' });
    // The same value again: 200, changed false, no second audit row.
    const same = await patch('admin', `/api/partner-accounts/${ids.customerNoMail}/contact-email`, { contactEmail: 'approvals@customer-b-p5.example' });
    expect(same.body.changed).toBe(false);
    expect(await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'PARTNER_CONTACT_EMAIL_UPDATED'), eq(auditEvents.entityId, ids.customerNoMail)))).toHaveLength(1);
    // null clears it (audited).
    const cleared = await patch('admin', `/api/partner-accounts/${ids.customerNoMail}/contact-email`, { contactEmail: null });
    expect(cleared.body).toMatchObject({ contactEmail: null, changed: true });
  });

  it('refusals: a malformed address 422, a missing field 422, a maker / deleted / unknown account 404, a bad id 400', async () => {
    for (const bad of ['not-an-email', 'a@b', '<a@b.example>', 'a@b.example, c@d.example', 42, "' OR 1=1--", '<script>alert(1)</script>@x.example', 'a@b.example\r\nBcc: c@d.example', 'x'.repeat(250) + '@a.example']) {
      const refused = await patch('admin', `/api/partner-accounts/${ids.customer}/contact-email`, { contactEmail: bad });
      expect(refused.status, String(bad)).toBe(422);
      expect(refused.body.code, String(bad)).toBe('PARTNER_CONTACT_EMAIL_INVALID');
    }
    expect((await patch('admin', `/api/partner-accounts/${ids.customer}/contact-email`, {})).body.code).toBe('PARTNER_CONTACT_EMAIL_INVALID');
    for (const id of [ids.maker, ids.customerGone, uuidv7()]) {
      const missing = await patch('admin', `/api/partner-accounts/${id}/contact-email`, { contactEmail: 'a@b.example' });
      expect(missing.status, id).toBe(404);
      expect(missing.body.code).toBe('PARTNER_ACCOUNT_NOT_FOUND');
    }
    expect((await patch('admin', '/api/partner-accounts/not-a-uuid/contact-email', { contactEmail: 'a@b.example' })).status).toBe(400);
    const [maker] = await db.select({ contactEmail: accounts.contactEmail }).from(accounts).where(eq(accounts.id, ids.maker));
    expect(maker!.contactEmail).toBe('maker@maker-p5.example');
  });
});

// ===================================================================== R3
describe('R3: 監査履歴 — each decision says what it rests on (basis), never an amount', () => {
  const ACTIONS = 'ARTWORK_APPROVAL_RECORDED,EVIDENCE_MANUAL_VERIFICATION_RECORDED,MAKER_PO_CEO_APPROVED,MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED,MAKER_PO_ACCEPT_EVIDENCE_REGISTERED,DOCUMENT_VERIFICATION_RECORDED,FILM_RECEIPT_ASSUMPTION_RECORDED,FILM_SUPPLY_ORDER_HOLD_RELEASED,FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED,MAKER_PO_CANCELLED,FILM_DELIVERY_CONFIRMED';
  const history = async (role: Role) => {
    const answer = await get(role, `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc&action=${encodeURIComponent(ACTIONS)}`);
    expect(answer.status, answer.text).toBe(200);
    return answer.body.events as Array<Record<string, any>>;
  };

  it('a manual check carries the cited version, its result and the reason (masked for the auditor, absent for the viewer)', async () => {
    const chain = await orderAtApproval();
    const seven = await recordApproval(chain, 'seven', 'pdf', pdf());
    await verify(seven.body.approvalEvent.id, 'rejected', '社名違い（見積 ¥480000 の書類）');
    const rowOf = (events: Array<Record<string, any>>) => events.find((event) => event.action === 'EVIDENCE_MANUAL_VERIFICATION_RECORDED' && event.entityId === seven.body.approvalEvent.id);
    const auditor = rowOf(await history('auditor'));
    expect(auditor?.basis).toEqual({ evidenceDocumentVersionId: seven.versionId, result: 'rejected', reasonNote: `社名違い（見積 ${NOTE_AMOUNT_MASK} の書類）` });
    expect(rowOf(await history('admin'))?.basis.reasonNote).toBe('社名違い（見積 ¥480000 の書類）');
    const viewer = rowOf(await history('viewer'));
    expect(viewer).toBeDefined();
    expect(viewer).not.toHaveProperty('basis');
    // The approval itself keeps its version (now also in basis).
    const approval = (await history('auditor')).find((event) => event.action === 'ARTWORK_APPROVAL_RECORDED' && event.entityId === seven.body.approvalEvent.id);
    expect(approval?.basis).toEqual({ evidenceDocumentVersionId: seven.versionId });
  });

  it('a document check cites the version that was current when it was checked; the 代表承認 names the paper (MPO number), no snapshot / amount', async () => {
    const chain = await orderAtApproval();
    for (const organization of ['customer', 'seven'] as const) {
      const recorded = await recordApproval(chain, organization, 'eml', approvalEml(organization === 'customer' ? 'boss@customer-p5.example' : 'po@seven-p5.example'));
      expect(recorded.body.countsTowardDualApproval, organization).toBe(true);
    }
    const receipt = await uploadEvidence(chain, 'customer', 'pdf', pdf());
    const checked = await post('admin', `/api/documents/${receipt.document.id}/verify`, { verificationStatus: 'verified' });
    expect(checked.status, checked.text).toBe(200);
    const paper = await post('admin', `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po-p5@example.com', amounts: { currency: 'JPY', totalAmount: '480000' }
    });
    expect(paper.status, paper.text).toBe(201);
    const approved = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, paper.body.id));
    expect(approved.status, approved.text).toBe(200);
    const events = await history('auditor');
    const doc = events.find((event) => event.action === 'DOCUMENT_VERIFICATION_RECORDED' && event.entityId === receipt.document.id);
    expect(doc?.basis).toEqual({ evidenceDocumentVersionId: receipt.version.id, result: 'verified' });
    const ceo = events.find((event) => event.action === 'MAKER_PO_CEO_APPROVED' && event.basis?.makerPurchaseOrder?.id === paper.body.id);
    expect(ceo?.basis).toEqual({ evidenceDocumentVersionId: null, makerPurchaseOrder: { id: paper.body.id, displayNumber: expect.stringMatching(/^MPO-\d{4}-\d{4,}$/) } });
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/480000|480,000|totalAmount|snapshotSha256/);
  });

  it('the final acceptance cites the acceptance evidence nested in its stored event; up to 20 action codes are read (納品の確認 included)', async () => {
    const chain = await orderAtApproval();
    const versionId = uuidv7();
    await db.insert(auditEvents).values({
      id: uuidv7(), projectId: ids.projectA, actorUserId: ids.admin, action: 'MAKER_PO_ACCEPT_EVIDENCE_REGISTERED',
      entityType: 'maker_po_event', entityId: uuidv7(), occurredAt: new Date(),
      afterState: { status: 'MAKER_PO_ACCEPTED', event: { id: uuidv7(), evidenceDocumentVersionId: versionId, eventType: 'ACCEPTED' } },
      requestMetadata: { operation: 'maker_po:accept_evidence' }
    } as any);
    await db.insert(auditEvents).values({
      id: uuidv7(), projectId: ids.projectA, actorUserId: ids.admin, action: 'FILM_DELIVERY_CONFIRMED',
      entityType: 'delivery_confirmation', entityId: uuidv7(), occurredAt: new Date(),
      afterState: { evidenceDocumentVersionId: versionId, filmDeliveryId: chain.lineId }, requestMetadata: { operation: 'delivery_confirmation:record' }
    } as any);
    const events = await history('auditor');
    expect(events.find((event) => event.action === 'MAKER_PO_ACCEPT_EVIDENCE_REGISTERED')?.basis).toEqual({ evidenceDocumentVersionId: versionId });
    expect(events.find((event) => event.action === 'FILM_DELIVERY_CONFIRMED')?.basis, 'the 11th code is read').toEqual({ evidenceDocumentVersionId: versionId });
  });

  it('core: the mask hides money-like figures and keeps dates, short numbers and identifiers', () => {
    expect(maskAmountsInNote('金額480,000円と違う')).toBe(`金額${NOTE_AMOUNT_MASK}と違う`);
    expect(maskAmountsInNote('JPY 1200.50')).toBe(NOTE_AMOUNT_MASK);
    expect(maskAmountsInNote('12万円')).toBe(NOTE_AMOUNT_MASK);
    expect(maskAmountsInNote('480000')).toBe(NOTE_AMOUNT_MASK);
    expect(maskAmountsInNote('2026-11-20 受領・版2・3件・REV-NOMID-005')).toBe('2026-11-20 受領・版2・3件・REV-NOMID-005');
    expect(maskAmountsInNote(null)).toBeNull();
    expect(maskAmountsInNote('a'.repeat(600))!.length).toBe(501);
  });
});

// ===================================================================== R8
describe('R8: the 納品の確認 row carries the receipt evidence\'s declared issuer', () => {
  it('detail.evidenceIssuerEntity is the latest staff receipt\'s issuer, and every evidence entry has its own', async () => {
    const chain = await orderAtApproval();
    const delivery = await post('staff', `/api/film-supply-orders/${chain.orderId}/deliveries`, { filmSupplyOrderLineId: chain.lineId, deliveredQuantity: 1000, unit: 'sheets' });
    expect(delivery.status, delivery.text).toBe(201);
    const receipt = await post('staff', `/api/projects/${chain.project}/documents`, {
      documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: `p5-receipt-${tag()}.pdf`, contentType: 'application/pdf',
      contentBase64: b64(pdf()), sevenPurchaseOrderId: chain.sevenPoId, filmSupplyOrderId: chain.orderId
    });
    expect(receipt.status, receipt.text).toBe(201);
    const item = (await queue()).items.find((row) => row.key === `delivery_confirmation:${delivery.body.id}`);
    expect(item, 'delivery row missing').toBeDefined();
    expect(item!.detail.evidenceIssuerEntity).toBe('customer_generated');
    expect(item!.detail.evidence).toEqual([expect.objectContaining({ documentId: receipt.body.document.id, issuerEntity: 'customer_generated' })]);
    expect(allKeys(item)).not.toContain('totalAmount');
  });
});
