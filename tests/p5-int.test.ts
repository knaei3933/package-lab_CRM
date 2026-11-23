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
import { canPerform, senderDomainRequiresManualVerification } from '@kanei/core';
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

  it('round 2 (H-2): the reason reaches the representative as written; staff and auditor get the 却下 WITHOUT any reasonNote key', async () => {
    const { chain } = await rejectedSeven();
    expect((await gateOf('admin', chain.orderId)).designs[0].seven.manualVerification.reasonNote).toBe(REASON);
    for (const role of ['staff', 'auditor'] as const) {
      const gate = await gateOf(role, chain.orderId);
      expect(gate.designs[0].seven.manualVerification, role).toMatchObject({ result: 'rejected', verifierName: DISPLAY.admin });
      expect(gate.designs[0].seven.manualVerification, role).not.toHaveProperty('reasonNote');
      expect(JSON.stringify(gate), role).not.toContain('押印欄の会社名');
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

  it('round 2 (H-1): an exact match counts at once; two From lines wait with the 「差出人を確認できません」 reason; an unregistered contact still only warns', async () => {
    const chain = await orderAtApproval();
    const match = await recordApproval(chain, 'customer', 'eml', approvalEml('boss@customer-p5.example'));
    expect(match.body).toMatchObject({ evidenceIdentifierStatus: 'verified_in_document', countsTowardDualApproval: true, manualCheckReason: null });
    const twoFrom = approvalEml('po@seven-p5.example').replace('From: 承認者 <po@seven-p5.example>', 'From: 承認者 <po@seven-p5.example>\r\nFrom: 別人 <x@evil-p5.example>');
    const unverifiable = await recordApproval(chain, 'seven', 'eml', twoFrom);
    expect(unverifiable.status, unverifiable.text).toBe(201);
    expect(unverifiable.body).toMatchObject({
      countsTowardDualApproval: false, evidenceIdentifierStatus: 'pending_manual_verification', senderDomainCheck: { status: 'multiple_from' },
      manualCheckReason: { code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: '差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）' }
    });
    const item = (await queue()).items.find((row) => row.key === `approval_evidence_verification:${unverifiable.body.approvalEvent.id}`);
    expect(item?.reason).toEqual({ code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: '差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）' });
    const chainB = await orderAtApproval(ids.projectB);
    const unregistered = await recordApproval(chainB, 'customer', 'eml', approvalEml('boss@anywhere-p5.example'));
    expect(unregistered.body).toMatchObject({ countsTowardDualApproval: true, senderDomainCheck: { status: 'no_registered_domain' }, manualCheckReason: null });
    // Without a registered address an unreadable sender keeps the old meaning too (a warning, counted).
    const noFrom = approvalEml('boss@anywhere-p5.example').replace('From: 承認者 <boss@anywhere-p5.example>\r\n', '');
    const unregisteredNoFrom = await recordApproval(await orderAtApproval(ids.projectB), 'customer', 'eml', noFrom);
    expect(unregisteredNoFrom.body).toMatchObject({ countsTowardDualApproval: true, manualCheckReason: null, warnings: [{ code: 'EVIDENCE_SENDER_UNVERIFIABLE' }] });
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

  it('a manual check carries the cited version and its result; the reason only for the representative (round 2 H-2), no basis for the viewer', async () => {
    const chain = await orderAtApproval();
    const seven = await recordApproval(chain, 'seven', 'pdf', pdf());
    await verify(seven.body.approvalEvent.id, 'rejected', '社名違い（見積 ¥480000 の書類）');
    const rowOf = (events: Array<Record<string, any>>) => events.find((event) => event.action === 'EVIDENCE_MANUAL_VERIFICATION_RECORDED' && event.entityId === seven.body.approvalEvent.id);
    const auditor = rowOf(await history('auditor'));
    expect(auditor?.basis).toEqual({ evidenceDocumentVersionId: seven.versionId, result: 'rejected' });
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

// ===================================================================== round 2 (p5-int review REQUEST_CHANGES)
describe('round 2 H-1: N4(b) is an allowlist — only the exact registered domain counts; every other mail waits (the review\'s 26 cases)', () => {
  const R = 'seven-p5.example';
  const emlOf = (fromLines: string[], stamp = tag(), body = `承認します（${stamp}）`) => [
    ...fromLines, 'To: KANEI <staff@kanei.example>', `Subject: 校正承認 ${stamp}`, 'Date: Mon, 16 Nov 2026 01:00:00 +0000',
    `Message-ID: <approval-${stamp}@mail.example>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', body, ''
  ].join('\r\n');
  // demo-eml/p5-int-review/work/p11-n4.mjs, verbatim (the registered domain is this suite's セブン化学).
  const CASES: Array<[string, string[], 'count' | 'mismatch' | 'unverifiable']> = [
    ['01 match (control)', [`From: 承認者 <po@${R}>`], 'count'],
    ['02 foreign domain', ['From: 承認者 <boss@evil-rev.example>'], 'mismatch'],
    ['03 uppercase match', [`From: PO@${R.toUpperCase()}`], 'count'],
    ['04 real subdomain (exact match only since round 2)', [`From: a@mail.${R}`], 'mismatch'],
    ['05 suffix spoof', [`From: a@${R}.evil-rev.example`], 'mismatch'],
    ['06 prefix spoof', ['From: a@evilseven-p5.example'], 'mismatch'],
    ['07 display-name spoof', [`From: "po@${R}" <boss@evil-rev.example>`], 'unverifiable'],
    ['08 two From headers', [`From: po@${R}`, 'From: boss@evil-rev.example'], 'unverifiable'],
    ['09 Cyrillic look-alike (ѕ)', ['From: boss@ѕeven-p5.example'], 'unverifiable'],
    ['10 punycode domain', ['From: boss@xn--even-p5-q9a.example'], 'mismatch'],
    ['11 no From header', [], 'unverifiable'],
    ['12 comment with registered addr', [`From: boss@evil-rev.example (po@${R})`], 'unverifiable'],
    ['13 quoted local with @', [`From: "po@${R}"@evil-rev.example`], 'unverifiable'],
    ['14 encoded-word display', ['From: =?UTF-8?B?44K744OW44Oz5YyW5a2m?= <boss@evil-rev.example>'], 'mismatch'],
    ['15 From ok + Sender foreign', [`From: po@${R}`, 'Sender: boss@evil-rev.example'], 'count'],
    ['16 folded From header', ['From:', ' boss@evil-rev.example'], 'unverifiable'],
    ['17 lowercase header name', ['from: boss@evil-rev.example'], 'mismatch'],
    ['18 IP literal', ['From: boss@[203.0.113.5]'], 'mismatch'],
    ['19 group syntax empty', ['From: undisclosed-recipients:;'], 'unverifiable'],
    ['20 From with no domain', ['From: boss'], 'unverifiable'],
    ['21 fullwidth @ (＠)', [`From: boss＠${R}`], 'unverifiable'],
    ['22 trailing dot registered', [`From: po@${R}.`], 'count'],
    ['23 from in body only', [], 'unverifiable'],
    ['24 Reply-To registered, From foreign', ['From: boss@evil-rev.example', `Reply-To: po@${R}`], 'mismatch'],
    ['25 UTF-8 local, foreign domain', ['From: 承認@evil-rev.example'], 'mismatch'],
    ['26 angle-less + trailing text', [`From: boss@evil-rev.example <po@${R}>`], 'unverifiable']
  ];
  const REASONS = {
    mismatch: { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: '差出人のドメインが登録先と違います' },
    unverifiable: { code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: '差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）' }
  } as const;
  async function recordFile(chain: Chain, filename: string, contentType: string, content: string, identifier = `P5-ID-${tag()}`) {
    const uploaded = await post('staff', `/api/projects/${chain.project}/documents`, {
      documentType: 'approval_evidence', issuerEntity: 'seven', filename, contentType, contentBase64: b64(content),
      sevenPurchaseOrderId: chain.sevenPoId, filmSupplyOrderId: chain.orderId, designKey: 'label-front'
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    return await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
      organization: 'seven', decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: identifier, evidenceDocumentVersionId: uploaded.body.version.id
    });
  }

  it.each(CASES)('%s → %s', async (name, fromLines, expected) => {
    const chain = await orderAtApproval();
    let content = emlOf(fromLines);
    if (name.startsWith('23')) content = content.replace('承認します', `From: po@${R}\r\n承認します`);
    const recorded = await recordFile(chain, `n4-${name.slice(0, 2)}.eml`, 'message/rfc822', content);
    expect(recorded.status, recorded.text).toBe(201);
    const gate = await gateOf('staff', chain.orderId);
    if (expected === 'count') {
      expect(recorded.body, name).toMatchObject({ countsTowardDualApproval: true, evidenceIdentifierStatus: 'verified_in_document', manualCheckReason: null, senderDomainCheck: { status: 'match' } });
      expect(gate.designs[0].seven.valid, name).toBe(true);
    } else {
      expect(recorded.body, name).toMatchObject({ countsTowardDualApproval: false, evidenceIdentifierStatus: 'pending_manual_verification', manualCheckReason: REASONS[expected] });
      expect(gate.designs[0].seven, name).toMatchObject({ valid: false, pendingEvidenceIdentifier: true });
      const item = (await queue()).items.find((row) => row.key === `approval_evidence_verification:${recorded.body.approvalEvent.id}`);
      expect(item?.reason, name).toEqual(REASONS[expected]);
    }
  });

  it('a mail stripped of From AND Message-ID is still a mail (declared .eml, or only its To/Subject/Date): it waits', async () => {
    const headersOnly = (id: string) => ['To: KANEI <staff@kanei.example>', 'Subject: 校正承認', 'Date: Mon, 16 Nov 2026 01:00:00 +0000', '', `承認します ${id}`, ''].join('\r\n');
    for (const [filename, contentType] of [['bare.eml', 'message/rfc822'], ['bare.txt', 'text/plain']] as const) {
      const id = `P5-BARE-${tag()}`;
      const recorded = await recordFile(await orderAtApproval(), filename, contentType, headersOnly(id), id);
      expect(recorded.status, recorded.text).toBe(201);
      expect(recorded.body, filename).toMatchObject({ countsTowardDualApproval: false, manualCheckReason: REASONS.unverifiable, senderDomainCheck: { status: 'from_missing' } });
    }
  });

  it('a file declared as a mail (message/rfc822 or *.eml) whose header block cannot be read waits too', async () => {
    for (const [filename, contentType] of [['broken.eml', 'text/plain'], ['broken.bin', 'message/rfc822']] as const) {
      const id = `P5-BROKEN-${tag()}`;
      const recorded = await recordFile(await orderAtApproval(), filename, contentType, `承認します ${id}\n（ヘッダーなし）\n`, id);
      expect(recorded.status, recorded.text).toBe(201);
      expect(recorded.body, filename).toMatchObject({ countsTowardDualApproval: false, manualCheckReason: REASONS.unverifiable, senderDomainCheck: { status: 'from_missing' } });
    }
  });

  it('unchanged: a plain text evidence that is not a mail (identifier line) is not judged by the sender rule', async () => {
    const id = `MSG-P5-${tag()}`;
    const recorded = await recordFile(await orderAtApproval(), 'approval-note.txt', 'text/plain', `p5 approval\nidentifier: ${id}\n`, id);
    expect(recorded.body).toMatchObject({ countsTowardDualApproval: true, senderDomainCheck: { status: 'not_email' }, manualCheckReason: null });
  });

  it('core: only `match` with a registered domain passes; the decision is not a list of bad patterns', () => {
    const check = (status: string, registeredDomain: string | null = R) => ({ status, fromAddress: null, fromDomain: null, registeredDomain }) as any;
    expect(senderDomainRequiresManualVerification(check('match'))).toBe(false);
    for (const status of ['mismatch', 'from_missing', 'multiple_from', 'anything-new']) expect(senderDomainRequiresManualVerification(check(status)), status).toBe(true);
    expect(senderDomainRequiresManualVerification(check('from_missing', null))).toBe(false);
    expect(senderDomainRequiresManualVerification(check('no_registered_domain', null))).toBe(false);
    expect(senderDomainRequiresManualVerification(check('not_email'))).toBe(false);
    expect(senderDomainRequiresManualVerification(null)).toBe(false);
  });
});

describe('round 2 H-2: the 却下 reason never reaches staff / viewer / auditor — the review\'s 30 texts, every path', () => {
  // demo-eml/p5-int-review/work/p13-mask.mjs, verbatim.
  const NOTES = [
    '見積 480,000円 と違う', '¥480000', '480000', '金額480000', '４８００００円', '48万円', '48万', '四十八万円', '四十八万', '480 000',
    '480,000/本', '480000/ロット', '2026-480000', '480000-', '単価12.5万', '12.5万円', 'USD480', '480k', '0.48M', '480千円',
    '税込 52万8千', '1,234', '1.234.567', '4 8 0 0 0 0', '¥ 4 8 0', '480.000', '4,800', '48,0000', '総額は見積書の通り（480 thousand yen）', '五百万円'
  ];
  /** Every value under a reasonNote key, anywhere in a JSON answer. */
  const reasonValues = (value: unknown, out: unknown[] = []): unknown[] => {
    if (Array.isArray(value)) value.forEach((entry) => reasonValues(entry, out));
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { if (key === 'reasonNote') out.push(entry); reasonValues(entry, out); }
    return out;
  };

  it('each of the 30 is the representative\'s alone (gate, audit history, queue), and nobody else gets a reasonNote key or the text', async () => {
    const chain = await orderAtApproval();
    const seven = await recordApproval(chain, 'seven', 'pdf', pdf());
    const eventId = seven.body.approvalEvent.id as string;
    for (const note of NOTES) {
      const rejected = await verify(eventId, 'rejected', note);
      expect(rejected.status, `${note}: ${rejected.text}`).toBe(201);
      expect((await gateOf('admin', chain.orderId)).designs[0].seven.manualVerification.reasonNote, note).toBe(note);
      for (const role of ['staff', 'auditor'] as const) {
        const answer = await get(role, `/api/film-supply-orders/${chain.orderId}/approval-gate`);
        expect(reasonValues(answer.body), `${role} gate ${note}`).toEqual([]);
        expect(answer.text, `${role} gate ${note}`).not.toContain(note);
      }
    }
    const url = `/api/projects/${ids.projectA}/audit-history?limit=500&action=EVIDENCE_MANUAL_VERIFICATION_RECORDED`;
    const adminNotes = reasonValues((await get('admin', url)).body);
    for (const note of NOTES) expect(adminNotes, note).toContain(note);
    for (const role of ['staff', 'auditor', 'viewer'] as const) {
      const answer = await get(role, url);
      expect(answer.status, role).toBe(200);
      expect(reasonValues(answer.body), role).toEqual([]);
      for (const note of NOTES) if (/[^0-9a-f-]/.test(note)) expect(answer.text, `${role} ${note}`).not.toContain(note);
    }
    // The queue is the representative's: its 却下 row carries the latest text (admin only — 403 for the others).
    const row = (await queue()).blocked.find((item) => item.key === `approval_evidence_rejected:${eventId}`);
    expect(row?.detail.rejection.reasonNote).toBe(NOTES.at(-1));
    for (const role of ['staff', 'auditor', 'viewer'] as const) expect((await get(role, '/api/representative-queue')).status, role).toBe(403);
  });
});

describe('round 2 M-1: the same paper sent again after a 却下 says so to the representative', () => {
  it('same bytes uploaded again → 「same_content」 with that 却下 (gate and queue); the same version cited again → 「same_version」', async () => {
    const chain = await orderAtApproval();
    const content = pdf();
    const first = await recordApproval(chain, 'seven', 'pdf', content);
    await verify(first.body.approvalEvent.id, 'rejected', '社名がセブン化学ではない');
    const again = await recordApproval(chain, 'seven', 'pdf', content);
    expect(again.status, again.text).toBe(201);
    const entry = (await gateOf('admin', chain.orderId)).pendingManualVerifications.find((item: { approvalEventId: string }) => item.approvalEventId === again.body.approvalEvent.id);
    expect(entry.previouslyRejected).toEqual({ approvalEventId: first.body.approvalEvent.id, matchedOn: 'same_content', verifierName: DISPLAY.admin, rejectedAt: expect.any(String), reasonNote: '社名がセブン化学ではない' });
    const item = (await queue()).items.find((row) => row.key === `approval_evidence_verification:${again.body.approvalEvent.id}`);
    expect(item?.detail.previouslyRejected).toMatchObject({ approvalEventId: first.body.approvalEvent.id, matchedOn: 'same_content', reasonNote: '社名がセブン化学ではない' });
    // The rejected version itself, named explicitly (supersedesEventId), is the same paper too.
    await verify(again.body.approvalEvent.id, 'rejected', '同じ書類');
    const cited = await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
      organization: 'seven', decision: 'APPROVE', evidenceSource: 'signed_document', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: `P5-ID-${tag()}`, evidenceDocumentVersionId: first.versionId, supersedesEventId: again.body.approvalEvent.id
    });
    expect(cited.status, cited.text).toBe(201);
    const citedEntry = (await gateOf('admin', chain.orderId)).pendingManualVerifications.find((item: { approvalEventId: string }) => item.approvalEventId === cited.body.approvalEvent.id);
    // The latest earlier 却下 of the same paper is named: the re-upload (same bytes → same_content, its own reason).
    expect(citedEntry.previouslyRejected).toMatchObject({ approvalEventId: again.body.approvalEvent.id, matchedOn: 'same_content', reasonNote: '同じ書類' });
    // Only the version itself, with no later 却下 in between, reads same_version.
    const chain2 = await orderAtApproval();
    const one = await recordApproval(chain2, 'seven', 'pdf', pdf());
    await verify(one.body.approvalEvent.id, 'rejected', '一回目');
    const reCited = await post('staff', `/api/artwork-revisions/${chain2.revisionId}/approvals`, {
      organization: 'seven', decision: 'APPROVE', evidenceSource: 'signed_document', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: `P5-ID-${tag()}`, evidenceDocumentVersionId: one.versionId, supersedesEventId: one.body.approvalEvent.id
    });
    expect(reCited.status, reCited.text).toBe(201);
    const reEntry = (await gateOf('admin', chain2.orderId)).pendingManualVerifications.find((item: { approvalEventId: string }) => item.approvalEventId === reCited.body.approvalEvent.id);
    expect(reEntry.previouslyRejected).toMatchObject({ approvalEventId: one.body.approvalEvent.id, matchedOn: 'same_version', reasonNote: '一回目' });
  });

  it('a different paper carries no such line', async () => {
    const chain = await orderAtApproval();
    const first = await recordApproval(chain, 'seven', 'pdf', pdf());
    await verify(first.body.approvalEvent.id, 'rejected', 'x');
    const other = await recordApproval(chain, 'seven', 'pdf', pdf());
    const entry = (await gateOf('admin', chain.orderId)).pendingManualVerifications.find((item: { approvalEventId: string }) => item.approvalEventId === other.body.approvalEvent.id);
    expect(entry.previouslyRejected).toBeNull();
    expect((await queue()).items.find((row) => row.key === `approval_evidence_verification:${other.body.approvalEvent.id}`)?.detail.previouslyRejected).toBeNull();
  });
});

describe('round 2 M-2: a contact address change is in the 監査履歴 of the projects that use the account', () => {
  it('admin and the assigned auditor read PARTNER_CONTACT_EMAIL_UPDATED (before → after); staff and viewer do not; another project does not', async () => {
    const set = await patch('admin', `/api/partner-accounts/${ids.seven}/contact-email`, { contactEmail: 'PO@seven-p5.example' });
    expect(set.status, set.text).toBe(200);
    const url = (project: string) => `/api/projects/${project}/audit-history?limit=500&order=desc&action=PARTNER_CONTACT_EMAIL_UPDATED`;
    // The address only changed case (normalized to the same value) → no row; change it for real and back.
    await patch('admin', `/api/partner-accounts/${ids.seven}/contact-email`, { contactEmail: 'po2@seven-p5.example' });
    await patch('admin', `/api/partner-accounts/${ids.seven}/contact-email`, { contactEmail: SEVEN_MAIL });
    const auditor = (await get('auditor', url(ids.projectA))).body.events as Array<Record<string, any>>;
    const rows = auditor.filter((event) => event.entityId === ids.seven);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toMatchObject({ action: 'PARTNER_CONTACT_EMAIL_UPDATED', beforeState: { contactEmail: 'po2@seven-p5.example' }, afterState: { contactEmail: SEVEN_MAIL }, actor: { id: ids.admin } });
    expect((await get('admin', url(ids.projectA))).body.events.some((event: { entityId: string }) => event.entityId === ids.seven)).toBe(true);
    for (const role of ['staff', 'viewer'] as const) {
      expect((await get(role, url(ids.projectA))).body.events, role).toEqual([]);
    }
    // projectB uses the same セブン化学; the customer of projectA is not projectB's.
    const customerChange = await patch('admin', `/api/partner-accounts/${ids.customer}/contact-email`, { contactEmail: 'approvals2@customer-p5.example' });
    expect(customerChange.status).toBe(200);
    await patch('admin', `/api/partner-accounts/${ids.customer}/contact-email`, { contactEmail: CUSTOMER_MAIL });
    const bRows = (await get('admin', url(ids.projectB))).body.events as Array<{ entityId: string }>;
    expect(bRows.some((event) => event.entityId === ids.customer)).toBe(false);
    expect(bRows.some((event) => event.entityId === ids.seven)).toBe(true);
  });
});

describe('round 2 L-1 / L-2: a 却下 is not flipped to 確認, and a replaced approval is not checked', () => {
  it('L-1: 確認 after 却下 on the same event → 422 EVIDENCE_ALREADY_REJECTED, nothing written, order unmoved; a second 却下 is still possible', async () => {
    const chain = await orderAtApproval();
    expect((await recordApproval(chain, 'customer', 'eml', approvalEml('boss@customer-p5.example'))).body.countsTowardDualApproval).toBe(true);
    const seven = await recordApproval(chain, 'seven', 'pdf', pdf());
    expect((await verify(seven.body.approvalEvent.id, 'rejected', '社名違い')).status).toBe(201);
    const flipped = await verify(seven.body.approvalEvent.id, 'confirmed', '気が変わった');
    expect(flipped.status, flipped.text).toBe(422);
    expect(flipped.body.code).toBe('EVIDENCE_ALREADY_REJECTED');
    expect(await orderStatus(chain.orderId)).toBe('APPROVAL_PENDING');
    const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'EVIDENCE_MANUAL_VERIFICATION_RECORDED'), eq(auditEvents.entityId, seven.body.approvalEvent.id)));
    expect(rows).toHaveLength(1);
    expect((await verify(seven.body.approvalEvent.id, 'rejected', '理由を書き直す')).status).toBe(201);
  });

  it('L-2: a check of a replaced (older) approval → 422 EVIDENCE_VERIFICATION_TARGET_SUPERSEDED; the latest one is checkable', async () => {
    const chain = await orderAtApproval();
    const first = await recordApproval(chain, 'seven', 'pdf', pdf());
    const second = await recordApproval(chain, 'seven', 'pdf', pdf());
    for (const result of ['confirmed', 'rejected'] as const) {
      const refused = await verify(first.body.approvalEvent.id, result, '古い方');
      expect(refused.status, refused.text).toBe(422);
      expect(refused.body.code).toBe('EVIDENCE_VERIFICATION_TARGET_SUPERSEDED');
    }
    expect((await verify(second.body.approvalEvent.id, 'confirmed', '最新を確認')).status).toBe(201);
  });
});

describe('round 2 L-3 / L-5: no-store on every partner answer; the gaps the review\'s survivors showed', () => {
  it('L-3: 401 and 403 of /api/partner-accounts are private, no-store too', async () => {
    for (const [role, status] of [[null, 401], ['staff', 403], ['auditor', 403], ['admin', 200]] as const) {
      const response = await app.request('/api/partner-accounts', { headers: role ? { cookie: `${SESSION_COOKIE}=${tokens[role]}` } : {} });
      expect(response.status, String(role)).toBe(status);
      expect(response.headers.get('cache-control'), String(role)).toBe('private, no-store');
    }
  });

  it('L-5 (Y7): a 却下 on a cancelled or deleted order is not a stuck row', async () => {
    for (const change of [{ status: 'CANCELLED' }, { deletedAt: new Date() }] as const) {
      const chain = await orderAtApproval();
      const seven = await recordApproval(chain, 'seven', 'pdf', pdf());
      await verify(seven.body.approvalEvent.id, 'rejected', 'x');
      const key = `approval_evidence_rejected:${seven.body.approvalEvent.id}`;
      expect((await queue()).blocked.find((item) => item.key === key)).toBeDefined();
      await db.update(filmSupplyOrders).set(change as any).where(eq(filmSupplyOrders.id, chain.orderId));
      expect((await queue()).blocked.find((item) => item.key === key), JSON.stringify(change)).toBeUndefined();
    }
  });

  it('L-5 (Y12): an empty string clears the address like null (ERROR_CODES.md contract), audited', async () => {
    const cleared = await patch('admin', `/api/partner-accounts/${ids.customerNoMail}/contact-email`, { contactEmail: '   ' });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.contactEmail).toBeNull();
    const [row] = await db.select({ contactEmail: accounts.contactEmail }).from(accounts).where(eq(accounts.id, ids.customerNoMail));
    expect(row!.contactEmail).toBeNull();
  });
});
