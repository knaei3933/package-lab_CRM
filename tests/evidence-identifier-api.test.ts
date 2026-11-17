import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  accounts,
  artworkRevisions,
  createDatabase,
  documents,
  documentVersions,
  filmSupplyOrders,
  projectAssignments,
  projects,
  sessions,
  sevenPurchaseOrders,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';

const { db, pool } = createDatabase(process.env.DATABASE_URL!);
const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
const sevenPoId = uuidv7();
const orderId = uuidv7();
const proofVersionId = uuidv7();
const proofDocumentId = uuidv7();
const emlDocumentId = uuidv7();
const emlVersionId = uuidv7();
const textVersionId = uuidv7();
const textDocumentId = uuidv7();
const revisionId = uuidv7();
const MESSAGE_ID = '<approval-0001@Mail.Example.test>';
const PARENT_ID = '<parent-0000@Mail.Example.test>';

let adminToken = '';
let staffToken = '';
let viewerToken = '';
let app: ReturnType<typeof createApp>;

function cookie(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function getAs(token: string, url: string) {
  const response = await app.request(url, { method: 'GET', headers: cookie(token) });
  return { status: response.status, body: await response.json() };
}

async function postAs(token: string, url: string, body: unknown) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie(token) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'kanei-evidence-g6-'));
  await mkdir(path.join(storageRoot, 'documents'), { recursive: true, mode: 0o700 });
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, artwork_revisions, artwork_approval_events, documents,
      document_versions, pre_order_references, seven_purchase_orders, film_supply_orders,
      film_supply_order_lines, film_deliveries, filling_orders, filling_order_lines,
      filling_deliveries, commission_readiness, delivery_confirmations,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'evidence_g6_admin', passwordHash: 'test-hash', displayName: '代表', role: 'admin' },
    { id: staffId, username: 'evidence_g6_staff', passwordHash: 'test-hash', displayName: '担当', role: 'staff' },
    { id: viewerId, username: 'evidence_g6_viewer', passwordHash: 'test-hash', displayName: '閲覧', role: 'viewer' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '顧客', role: 'end_customer', externalCode: 'G6-CUST' },
    { id: sevenAccountId, name: 'セブン', role: 'seven', externalCode: 'G6-SEVEN' },
    { id: makerAccountId, name: 'メーカー', role: 'maker', externalCode: 'G6-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'G6-PROJECT',
    name: 'Evidence G6',
    businessUnit: 'F1' as const,
    route: 'F1' as const,
    leadSource: 'KANEI',
    status: 'DRAFT' as const,
    endCustomerAccountId: customerAccountId,
    sevenAccountId,
    makerAccountId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: staffId, projectId },
    { id: uuidv7(), userId: viewerId, projectId }
  ]);
  await db.insert(sevenPurchaseOrders).values({
    id: sevenPoId,
    projectId,
    poNumber: 'G6-SEVEN-PO',
    officialRegisteredAt: now,
    verificationStatus: 'verified' as const,
    verifiedByUserId: staffId,
    verifiedAt: now,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(filmSupplyOrders).values({
    id: orderId,
    projectId,
    code: 'FSO-G6-API',
    status: 'APPROVAL_PENDING' as const,
    sevenPurchaseOrderId: sevenPoId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });

  const eml = [
    'From: Approver <approver@mail.example.test>',
    'To: KANEI <staff@kanei.example>',
    'Subject: approval',
    'Date: Tue, 17 Nov 2026 09:00:00 +0900',
    `Message-ID: ${MESSAGE_ID}`,
    `In-Reply-To: ${PARENT_ID}`,
    `References: ${PARENT_ID}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `OK. quoted Message-ID: ${PARENT_ID}`,
    ''
  ].join('\r\n');
  const emlBytes = Buffer.from(eml, 'utf8');
  const emlPath = path.join(storageRoot, 'documents', 'approval.eml.bin');
  await writeFile(emlPath, emlBytes, { mode: 0o600 });
  const textBytes = Buffer.from('identifier SIGNBLOCK-0001\n', 'utf8');
  const textPath = path.join(storageRoot, 'documents', 'approval.txt.bin');
  await writeFile(textPath, textBytes, { mode: 0o600 });
  const proofBytes = Buffer.from('proof bytes\n', 'utf8');
  const proofPath = path.join(storageRoot, 'documents', 'proof.bin');
  await writeFile(proofPath, proofBytes, { mode: 0o600 });

  const baseVersion = (input: {
    id: string;
    documentId: string;
    versionNumber: number;
    path: string;
    bytes: Buffer;
    mime: string;
  }) => ({
    id: input.id,
    documentId: input.documentId,
    versionNumber: input.versionNumber,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    byteSize: input.bytes.length,
    storagePath: input.path,
    originalFilename: `${input.id}.bin`,
    declaredMimeType: input.mime,
    detectedMimeType: input.mime === 'message/rfc822' ? null : null,
    sizeCheckPassed: true,
    typeCheckPassed: true,
    createdByUserId: staffId,
    createdAt: now
  });
  await db.insert(documents).values([
    {
      id: proofDocumentId,
      projectId,
      documentType: 'proof' as const,
      issuerEntity: 'kanei' as const,
      originalFilename: 'proof.bin',
      sevenPurchaseOrderId: sevenPoId,
      filmSupplyOrderId: orderId,
      designKey: 'label-front',
      createdByUserId: staffId,
      createdAt: now,
      updatedAt: now
    },
    {
      id: emlDocumentId,
      projectId,
      documentType: 'approval_evidence' as const,
      issuerEntity: 'customer_generated' as const,
      originalFilename: 'approval.eml',
      sevenPurchaseOrderId: sevenPoId,
      filmSupplyOrderId: orderId,
      designKey: 'label-front',
      createdByUserId: staffId,
      createdAt: now,
      updatedAt: now
    },
    {
      id: textDocumentId,
      projectId,
      documentType: 'approval_evidence' as const,
      issuerEntity: 'seven' as const,
      originalFilename: 'approval.txt',
      sevenPurchaseOrderId: sevenPoId,
      filmSupplyOrderId: orderId,
      designKey: 'label-front',
      createdByUserId: staffId,
      createdAt: now,
      updatedAt: now
    }
  ]);
  await db.insert(documentVersions).values([
    baseVersion({ id: proofVersionId, documentId: proofDocumentId, versionNumber: 1, path: proofPath, bytes: proofBytes, mime: 'text/plain' }),
    baseVersion({ id: emlVersionId, documentId: emlDocumentId, versionNumber: 1, path: emlPath, bytes: emlBytes, mime: 'message/rfc822' }),
    baseVersion({ id: textVersionId, documentId: textDocumentId, versionNumber: 1, path: textPath, bytes: textBytes, mime: 'text/plain' })
  ]);
  await db.insert(artworkRevisions).values({
    id: revisionId,
    filmSupplyOrderId: orderId,
    designKey: 'label-front',
    revisionNo: 1,
    fileDocumentVersionId: proofVersionId,
    createdByUserId: staffId,
    createdAt: now
  });

  for (const [userId, setter] of [
    [adminId, (value: string) => { adminToken = value; }],
    [staffId, (value: string) => { staffToken = value; }],
    [viewerId, (value: string) => { viewerToken = value; }]
  ] as const) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(),
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    setter(token);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('stored EML evidence identifier (G6)', () => {
  it('extracts only the own Message-ID for assigned staff', async () => {
    const result = await getAs(staffToken, `/api/document-versions/${emlVersionId}/evidence-message-id`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ evidenceIdentifier: MESSAGE_ID, source: 'stored_eml_message_id' });
  });

  it('refuses viewer and unassigned-project access before reading storage', async () => {
    const viewer = await getAs(viewerToken, `/api/document-versions/${emlVersionId}/evidence-message-id`);
    expect(viewer.status).toBe(403);
    expect(viewer.body).toMatchObject({ error: '権限がありません' });
    const anonymous = await app.request(
      `/api/document-versions/${emlVersionId}/evidence-message-id`,
      { method: 'GET' }
    );
    expect(anonymous.status).toBe(401);
  });

  it('keeps manual input for non-EML and returns an explicit extraction failure', async () => {
    const result = await getAs(staffToken, `/api/document-versions/${textVersionId}/evidence-message-id`);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ code: 'EVIDENCE_IDENTIFIER_NOT_EXTRACTABLE' });
  });

  it('server-side approval replaces client text with the stored mail own Message-ID', async () => {
    const approval = await postAs(staffToken, `/api/artwork-revisions/${revisionId}/approvals`, {
      organization: 'customer',
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-17T09:00:00.000Z',
      evidenceIdentifier: PARENT_ID,
      evidenceDocumentVersionId: emlVersionId
    });
    expect(approval.status).toBe(201);
    expect(approval.body).toMatchObject({
      approvalEvent: { evidenceIdentifier: MESSAGE_ID, evidenceIdentifierStatus: 'verified_in_document' },
      countsTowardDualApproval: true
    });
  });
});
