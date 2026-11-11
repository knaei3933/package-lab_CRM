import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  auditEvents,
  createDatabase,
  documentVersions,
  documents,
  filmSupplyOrders,
  preOrderReferences,
  projectAssignments,
  projects,
  sevenPurchaseOrders,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectIdA = uuidv7();
const projectIdB = uuidv7();
let staffToken = '';
let storageRoot = '';

function cookieHeader(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

function jsonPost(token: string, body: unknown) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookieHeader(token) },
    body: JSON.stringify(body)
  } as const;
}

function toBase64(text: string) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function sha256OfBytes(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchCounts() {
  const result = await db.execute(sql`
    select
      (select count(*) from documents)::int as documents,
      (select count(*) from document_versions)::int as document_versions,
      (select count(*) from pre_order_references)::int as pre_orders,
      (select count(*) from seven_purchase_orders)::int as seven_pos,
      (select count(*) from film_supply_orders)::int as film_orders,
      (select count(*) from audit_events)::int as audit_events
  `);
  return result.rows[0] as {
    documents: number;
    document_versions: number;
    pre_orders: number;
    seven_pos: number;
    film_orders: number;
    audit_events: number;
  };
}

interface UploadOverrides {
  documentType?: string;
  issuerEntity?: string;
  filename?: string;
  contentType?: string;
  contentBase64?: string;
  sevenPurchaseOrderId?: string;
  preOrderReferenceId?: string;
  note?: string;
  originalReceivedAt?: string;
}

function uploadBody(_projectId: string, overrides: UploadOverrides = {}) {
  return {
    documentType: 'film_quote_kanei',
    issuerEntity: 'kanei',
    filename: 'quote-kanei.txt',
    contentType: 'text/plain',
    contentBase64: toBase64('composite kanei quote\n'),
    ...overrides
  };
}

async function createPo(
  app: ReturnType<typeof createApp>,
  projectId: string,
  poNumber: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string }> {
  const response = await app.request(
    `/api/projects/${projectId}/seven-purchase-orders`,
    jsonPost(staffToken, { poNumber, ...extra })
  );
  expect(response.status).toBe(201);
  return await response.json();
}

/** A complete human record of the seven checklist items (design section 5.10). */
function fullChecklist(overrides: Record<string, unknown> = {}) {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業',
    documentNumberRecorded: true,
    documentNumber: 'PO-2026-1111-01',
    issueDateRecorded: true,
    issueDate: '2026-11-11',
    sendingChannelRecorded: true,
    sendingChannel: '専用ポータル',
    pastTransactionCompared: true,
    pastTransactionNote: '過去3件の発注書と様式が一致',
    quoteCompared: true,
    quoteMatchesPo: true,
    quoteComparisonNote: '見積と仕様・数量・金額が一致',
    tamperHints: '',
    uncertain: false,
    confirmationReplyRecorded: false,
    confirmationReplyNote: '',
    verificationNote: '合成チェックリスト記録',
    ...overrides
  };
}

async function verifyChecklist(app: ReturnType<typeof createApp>, poId: string, overrides: Record<string, unknown> = {}) {
  return await app.request(
    `/api/seven-purchase-orders/${poId}/verification-checklist`,
    jsonPost(staffToken, fullChecklist(overrides))
  );
}

beforeAll(async () => {
  // Hermetic private storage folder for this run (design section 5.4).
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m2-docs-'));
  storageRoot = process.env.DOCUMENT_STORAGE_DIR;

  await db.execute(sql`
    truncate table audit_events, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_m2_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者M2', role: 'admin' },
    { id: staffId, username: 'staff_m2_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M2', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成M2エンドカスタマー', role: 'end_customer', externalCode: 'TEST-M2-CUST' },
    { id: sevenAccountId, name: '合成M2セブン', role: 'seven', externalCode: 'TEST-M2-SEVEN' },
    { id: makerAccountId, name: '合成M2メーカー', role: 'maker', externalCode: 'TEST-M2-MAKER' }
  ]);
  await db.insert(projects).values([projectIdA, projectIdB].map((id, index) => ({
    id,
    code: index === 0 ? 'TEST-M2-PROJECT-A' : 'TEST-M2-PROJECT-B',
    name: '合成M2案件',
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
  })));
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId: projectIdA },
    { id: uuidv7(now), userId: staffId, projectId: projectIdB }
  ]);
  staffToken = await (async () => {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({ id: uuidv7(), userId: staffId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    return token;
  })();
});

afterAll(async () => {
  await pool.end();
});

describe('M2 document intake and PO precedence', () => {
  it('T-04 rejects official artwork and supply-order registration without a verified PO, persisting nothing', async () => {
    const app = createApp({ db });
    const po = await createPo(app, projectIdA, 'SEVEN-M2-T04-1');
    const before = await fetchCounts();

    const artworkWithoutPo = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        documentType: 'proof',
        issuerEntity: 'maker',
        filename: 'artwork-t04.txt',
        contentBase64: toBase64('composite artwork\n')
      }))
    );
    expect(artworkWithoutPo.status).toBe(422);
    expect(await artworkWithoutPo.json()).toMatchObject({ code: 'SEVEN_PO_REQUIRED' });

    const artworkWithUnregisteredPo = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        documentType: 'proof',
        issuerEntity: 'maker',
        filename: 'artwork-t04.txt',
        sevenPurchaseOrderId: po.id
      }))
    );
    expect(artworkWithUnregisteredPo.status).toBe(422);
    expect(await artworkWithUnregisteredPo.json()).toMatchObject({ code: 'OFFICIAL_REGISTRATION_REQUIRED' });

    const supplyOrder = await app.request(
      `/api/seven-purchase-orders/${po.id}/supply-orders`,
      jsonPost(staffToken, { code: 'TEST-M2-T04-SUPPLY' })
    );
    expect(supplyOrder.status).toBe(422);
    expect(await supplyOrder.json()).toMatchObject({ code: 'OFFICIAL_REGISTRATION_REQUIRED' });

    expect(await fetchCounts()).toEqual(before);
  });

  it('T-05 rejects registration against a PO whose verification_status is unverified, persisting nothing', async () => {
    const app = createApp({ db });
    const po = await createPo(app, projectIdA, 'SEVEN-M2-T05-1', { officialRegisteredAt: '2026-11-06T00:00:00.000Z' });
    const [row] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, po.id));
    expect(row?.officialRegisteredAt).not.toBeNull();
    expect(row?.verificationStatus).toBe('unverified');

    const before = await fetchCounts();

    const artwork = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        documentType: 'proof',
        issuerEntity: 'maker',
        filename: 'artwork-t05.txt',
        sevenPurchaseOrderId: po.id
      }))
    );
    expect(artwork.status).toBe(422);
    expect(await artwork.json()).toMatchObject({ code: 'SEVEN_PO_NOT_VERIFIED' });

    const supplyOrder = await app.request(
      `/api/seven-purchase-orders/${po.id}/supply-orders`,
      jsonPost(staffToken, { code: 'TEST-M2-T05-SUPPLY' })
    );
    expect(supplyOrder.status).toBe(422);
    expect(await supplyOrder.json()).toMatchObject({ code: 'SEVEN_PO_NOT_VERIFIED' });

    expect(await fetchCounts()).toEqual(before);
  });

  it('T-18 the checklist cannot verify authenticity from metadata alone; a human record is stored', async () => {
    const app = createApp({ db });
    const po = await createPo(app, projectIdA, 'SEVEN-M2-T18-1', { officialRegisteredAt: '2026-11-06T00:00:00.000Z' });
    const checklistUrl = `/api/seven-purchase-orders/${po.id}/verification-checklist`;

    // Metadata (issuer, document number, issue date, sending channel) without
    // the human comparisons is rejected.
    const metadataOnly = await app.request(checklistUrl, jsonPost(staffToken, {
      issuerNameRecorded: true,
      issuerName: '合成セブン化学事業',
      documentNumberRecorded: true,
      documentNumber: 'PO-2026-1111-01',
      issueDateRecorded: true,
      issueDate: '2026-11-11',
      sendingChannelRecorded: true,
      sendingChannel: '専用ポータル',
      uncertain: false
    }));
    expect(metadataOnly.status).toBe(422);
    const metadataBody = await metadataOnly.json();
    expect(metadataBody.code).toBe('CHECKLIST_INCOMPLETE');
    expect(metadataBody.missing).toContain('past-transaction comparison');
    expect(metadataBody.missing).toContain('quote comparison');

    const [afterMetadata] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, po.id));
    expect(afterMetadata?.verificationStatus).toBe('unverified');
    expect(afterMetadata?.verifiedAt).toBeNull();
    expect(afterMetadata?.verifiedByUserId).toBeNull();

    const before = await fetchCounts();

    // Item 7 is conditional: uncertainty demands a recorded confirmation reply.
    const uncertain = await app.request(checklistUrl, jsonPost(staffToken, fullChecklist({
      uncertain: true,
      confirmationReplyRecorded: false
    })));
    expect(uncertain.status).toBe(422);
    expect(await uncertain.json()).toMatchObject({ code: 'CONFIRMATION_REPLY_REQUIRED' });
    expect(await fetchCounts()).toEqual(before);

    const verified = await verifyChecklist(app, po.id, {
      tamperHints: '改ざん迹象なし（参考メモ）',
      verificationNote: '合成チェックリスト記録T18'
    });
    expect(verified.status).toBe(200);
    const verifiedBody = await verified.json();
    expect(verifiedBody.verificationStatus).toBe('verified');
    expect(verifiedBody.verifiedByUserId).toBe(staffId);
    expect(verifiedBody.verifiedAt).not.toBeNull();
    expect(verifiedBody.verificationNote).toBe('合成チェックリスト記録T18');
    expect(verifiedBody.reviewPending).toBe(false);
    expect(verifiedBody.authenticityChecklist.tamperHints).toBe('改ざん迹象なし（参考メモ）');
    expect(verifiedBody.authenticityChecklist.pastTransactionCompared).toBe(true);

    const after = await fetchCounts();
    expect(after.audit_events).toBe(before.audit_events + 1);
    expect(after.seven_pos).toBe(before.seven_pos);
  });

  it('T-19 a quote-vs-PO mismatch keeps the gate closed with a review-pending flag', async () => {
    const app = createApp({ db });
    const po = await createPo(app, projectIdA, 'SEVEN-M2-T19-1', { officialRegisteredAt: '2026-11-06T00:00:00.000Z' });

    const mismatch = await verifyChecklist(app, po.id, {
      quoteMatchesPo: false,
      quoteComparisonNote: '金額が見積より120,000円大きい'
    });
    expect(mismatch.status).toBe(200);
    const mismatchBody = await mismatch.json();
    expect(mismatchBody.verificationStatus).toBe('mismatch');
    expect(mismatchBody.reviewPending).toBe(true);
    expect(mismatchBody.reviewNote).toBe('金額が見積より120,000円大きい');

    const before = await fetchCounts();

    const artwork = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        documentType: 'proof',
        issuerEntity: 'maker',
        filename: 'artwork-t19.txt',
        sevenPurchaseOrderId: po.id
      }))
    );
    expect(artwork.status).toBe(422);
    expect(await artwork.json()).toMatchObject({ code: 'PO_REVIEW_PENDING' });

    const supplyOrder = await app.request(
      `/api/seven-purchase-orders/${po.id}/supply-orders`,
      jsonPost(staffToken, { code: 'TEST-M2-T19-SUPPLY' })
    );
    expect(supplyOrder.status).toBe(422);
    expect(await supplyOrder.json()).toMatchObject({ code: 'PO_REVIEW_PENDING' });

    expect(await fetchCounts()).toEqual(before);
  });

  it('T-26 the same bytes under another project create their own document sharing one physical file', async () => {
    const app = createApp({ db });
    const content = 'composite seven filling quote T26\n';

    const first = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, {
        documentType: 'filling_quote_seven',
        issuerEntity: 'seven',
        filename: 'quote-seven-t26.txt',
        contentType: 'text/plain',
        contentBase64: toBase64(content)
      })
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await app.request(
      `/api/projects/${projectIdB}/documents`,
      jsonPost(staffToken, {
        documentType: 'filling_quote_seven',
        issuerEntity: 'seven',
        filename: 'quote-seven-t26.txt',
        contentType: 'text/plain',
        contentBase64: toBase64(content)
      })
    );
    expect(second.status).toBe(201);
    const secondBody = await second.json();

    // Separate logical documents, one physical file.
    expect(secondBody.document.id).not.toBe(firstBody.document.id);
    expect(secondBody.document.projectId).toBe(projectIdB);
    expect(secondBody.version.id).not.toBe(firstBody.version.id);
    expect(secondBody.version.sha256).toBe(firstBody.version.sha256);
    expect(secondBody.version.sha256).toBe(sha256OfBytes(Buffer.from(content, 'utf8')));
    expect(secondBody.version.storagePath).toBe(firstBody.version.storagePath);

    // The storage path is server-generated and never the client filename.
    expect(secondBody.version.storagePath.startsWith(storageRoot)).toBe(true);
    expect(secondBody.version.storagePath.endsWith('.bin')).toBe(true);
    expect(secondBody.version.storagePath).not.toContain('quote-seven-t26');

    const stored = await readFile(secondBody.version.storagePath);
    expect(stored.toString('utf8')).toBe(content);
    await stat(firstBody.version.storagePath);

    const versions = await db.select().from(documentVersions)
      .where(eq(documentVersions.sha256, firstBody.version.sha256));
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((version) => version.storagePath)))
      .toEqual(new Set([firstBody.version.storagePath]));

    const documentRows = await db.select().from(documents)
      .where(and(
        eq(documents.documentType, 'filling_quote_seven'),
        eq(documents.originalFilename, 'quote-seven-t26.txt')
      ));
    expect(documentRows.map((row) => row.projectId).sort()).toEqual([projectIdA, projectIdB].sort());
  });

  it('T-27 an idempotent re-upload returns the same record and creates no new events, approvals, or orders', async () => {
    const app = createApp({ db });
    const body = {
      documentType: 'seven_po',
      issuerEntity: 'seven',
      filename: 'po-scan-t27.txt',
      contentType: 'text/plain',
      contentBase64: toBase64('composite seven PO scan T27\n'),
      originalReceivedAt: '2026-11-10T00:00:00.000Z'
    };

    const first = await app.request(`/api/projects/${projectIdA}/documents`, jsonPost(staffToken, body));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.document.preOrderReferenceId).not.toBeNull();

    const before = await fetchCounts();

    const second = await app.request(`/api/projects/${projectIdA}/documents`, jsonPost(staffToken, body));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.idempotent).toBe(true);
    expect(secondBody.document.id).toBe(firstBody.document.id);
    expect(secondBody.version.id).toBe(firstBody.version.id);
    expect(secondBody.version.sha256).toBe(firstBody.version.sha256);

    // Same documents, versions, references, purchase orders, supply orders and
    // audit events: nothing new.
    expect(await fetchCounts()).toEqual(before);
  });

  it('a PO document uploaded before a verified PO becomes an immutable pre-order reference with append-only versions', async () => {
    const app = createApp({ db });
    const upload = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, {
        documentType: 'seven_po',
        issuerEntity: 'seven',
        filename: 'po-scan-t07.txt',
        contentType: 'text/plain',
        contentBase64: toBase64('composite seven PO scan T07\n'),
        originalReceivedAt: '2026-11-09T00:00:00.000Z'
      })
    );
    expect(upload.status).toBe(201);
    const uploadJson = await upload.json();
    const referenceId = uploadJson.document.preOrderReferenceId;
    expect(referenceId).not.toBeNull();

    const [reference] = await db.select().from(preOrderReferences).where(eq(preOrderReferences.id, referenceId));
    expect(reference?.originalReceivedAt?.toISOString()).toBe('2026-11-09T00:00:00.000Z');

    // original_received_at is immutable reference data.
    await expect(db.update(preOrderReferences)
      .set({ originalReceivedAt: new Date('2026-12-01T00:00:00.000Z') })
      .where(eq(preOrderReferences.id, referenceId))).rejects.toThrow();
    await expect(db.delete(preOrderReferences)
      .where(eq(preOrderReferences.id, referenceId))).rejects.toThrow();

    // Recorded bytes are append-only.
    const versionId = uploadJson.version.id;
    await expect(db.update(documentVersions)
      .set({ sha256: 'a'.repeat(64) })
      .where(eq(documentVersions.id, versionId))).rejects.toThrow();
    await expect(db.delete(documentVersions)
      .where(eq(documentVersions.id, versionId))).rejects.toThrow();
  });

  it('promote-official stamps the official registration only after the linked PO passed the checklist', async () => {
    const app = createApp({ db });
    const upload = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, {
        documentType: 'seven_po',
        issuerEntity: 'seven',
        filename: 'po-scan-t08.txt',
        contentType: 'text/plain',
        contentBase64: toBase64('composite seven PO scan T08\n'),
        originalReceivedAt: '2026-11-09T00:00:00.000Z'
      })
    );
    expect(upload.status).toBe(201);
    const uploadJson = await upload.json();
    const referenceId = uploadJson.document.preOrderReferenceId as string;

    const promoted = await app.request(
      `/api/pre-order-references/${referenceId}/promote`,
      jsonPost(staffToken, { poNumber: 'SEVEN-M2-T08-1' })
    );
    expect(promoted.status).toBe(201);
    const po = await promoted.json();

    const before = await fetchCounts();
    const rejected = await app.request(
      `/api/pre-order-references/${referenceId}/promote-official`,
      jsonPost(staffToken, {})
    );
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: 'SEVEN_PO_NOT_VERIFIED' });
    expect(await fetchCounts()).toEqual(before);

    const verified = await verifyChecklist(app, po.id, { verificationNote: '合成チェックリスト記録T08' });
    expect(verified.status).toBe(200);

    const official = await app.request(
      `/api/pre-order-references/${referenceId}/promote-official`,
      jsonPost(staffToken, { officialRegisteredAt: '2026-11-11T00:00:00.000Z' })
    );
    expect(official.status).toBe(200);
    const officialBody = await official.json();
    expect(officialBody.promotedAt).not.toBeNull();
    expect(officialBody.promotedByUserId).toBe(staffId);

    const [row] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, po.id));
    expect(row?.officialRegisteredAt?.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(row?.promotedAt).not.toBeNull();
    expect(row?.promotedByUserId).toBe(staffId);

    const [audit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'PRE_ORDER_PROMOTED_OFFICIAL'),
      eq(auditEvents.entityId, po.id)
    ));
    expect(audit).toBeDefined();
  });

  it('after verification the film transition still reads official_registered_at only, and a fully verified PO opens the gates', async () => {
    const app = createApp({ db });
    const po = await createPo(app, projectIdA, 'SEVEN-M2-T09-1');
    const verified = await verifyChecklist(app, po.id, {});
    expect(verified.status).toBe(200);

    // Verified but not officially registered: the artwork gate fails on the
    // date axis, because official_registered_at is the only date it reads.
    const artworkBeforeRegistration = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        documentType: 'proof',
        issuerEntity: 'maker',
        filename: 'artwork-t09.txt',
        sevenPurchaseOrderId: po.id
      }))
    );
    expect(artworkBeforeRegistration.status).toBe(422);
    expect(await artworkBeforeRegistration.json()).toMatchObject({ code: 'OFFICIAL_REGISTRATION_REQUIRED' });

    // T-06 at the endpoint level: the SEVEN_PO_VERIFIED transition cannot be
    // satisfied by checklist verification in place of the missing date.
    const filmOrder = await app.request(
      `/api/projects/${projectIdA}/film-supply-orders`,
      jsonPost(staffToken, {
        code: 'TEST-M2-T09-FILM',
        sevenPurchaseOrderId: po.id,
        lines: [{ lineNumber: 1, description: '合成フィルム', orderedQuantity: 500, unit: 'rolls' }]
      })
    );
    expect(filmOrder.status).toBe(201);
    const transition = await app.request(
      `/api/film-supply-orders/${(await filmOrder.json()).id}/transitions`,
      jsonPost(staffToken, { to: 'SEVEN_PO_VERIFIED' })
    );
    expect(transition.status).toBe(422);
    expect(await transition.json()).toMatchObject({ code: 'OFFICIAL_REGISTRATION_REQUIRED' });

    const registered = await app.request(
      `/api/seven-purchase-orders/${po.id}/register-official`,
      jsonPost(staffToken, { officialRegisteredAt: '2026-11-11T00:00:00.000Z' })
    );
    expect(registered.status).toBe(200);

    const artwork = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        documentType: 'proof',
        issuerEntity: 'maker',
        filename: 'artwork-t09.txt',
        sevenPurchaseOrderId: po.id
      }))
    );
    expect(artwork.status).toBe(201);
    const artworkJson = await artwork.json();
    expect(artworkJson.document.sevenPurchaseOrderId).toBe(po.id);
    expect(artworkJson.document.verificationStatus).toBe('unverified');

    const supplyOrder = await app.request(
      `/api/seven-purchase-orders/${po.id}/supply-orders`,
      jsonPost(staffToken, {
        code: 'TEST-M2-T09-SUPPLY',
        lines: [{ lineNumber: 1, description: '合成フィルム', orderedQuantity: 500, unit: 'rolls' }]
      })
    );
    expect(supplyOrder.status).toBe(201);
    const supplyJson = await supplyOrder.json();
    expect(supplyJson.sevenPurchaseOrderId).toBe(po.id);
    expect(supplyJson.status).toBe('DRAFT');
    expect(supplyJson.lines).toHaveLength(1);
    expect(supplyJson.lines[0].unit).toBe('rolls');

    const [filmOrderRow] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.sevenPurchaseOrderId, po.id));
    expect(filmOrderRow).toBeDefined();
  });

  it('uploads failing server size/type checks persist nothing; multipart intake computes the same digest', async () => {
    const app = createApp({ db });
    const before = await fetchCounts();

    const badType = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        filename: 'archive-t10.bin',
        contentType: 'application/zip',
        contentBase64: toBase64('zip-ish bytes')
      }))
    );
    expect(badType.status).toBe(422);
    expect(await badType.json()).toMatchObject({ code: 'DOCUMENT_TYPE_REJECTED' });

    const contentMismatch = await app.request(
      `/api/projects/${projectIdA}/documents`,
      jsonPost(staffToken, uploadBody(projectIdA, {
        filename: 'mismatch-t10.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]).toString('base64')
      }))
    );
    expect(contentMismatch.status).toBe(422);
    expect(await contentMismatch.json()).toMatchObject({ code: 'DOCUMENT_CONTENT_MISMATCH' });

    const previousMax = process.env.DOCUMENT_MAX_BYTES;
    process.env.DOCUMENT_MAX_BYTES = '4';
    try {
      const tooLarge = await app.request(
        `/api/projects/${projectIdA}/documents`,
        jsonPost(staffToken, uploadBody(projectIdA, {
          filename: 'large-t10.txt',
          contentBase64: toBase64('12345678')
        }))
      );
      expect(tooLarge.status).toBe(422);
      expect(await tooLarge.json()).toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    } finally {
      if (previousMax === undefined) delete process.env.DOCUMENT_MAX_BYTES;
      else process.env.DOCUMENT_MAX_BYTES = previousMax;
    }

    expect(await fetchCounts()).toEqual(before);

    const bytes = Buffer.from('multipart composite quote\n', 'utf8');
    const form = new FormData();
    form.set('documentType', 'film_quote_kanei');
    form.set('issuerEntity', 'kanei');
    form.set('file', new File([bytes], 'multipart-quote-t10.txt', { type: 'text/plain' }));
    const multipart = await app.request(`/api/projects/${projectIdB}/documents`, {
      method: 'POST',
      headers: cookieHeader(staffToken),
      body: form
    });
    expect(multipart.status).toBe(201);
    const multipartBody = await multipart.json();
    expect(multipartBody.version.sha256).toBe(sha256OfBytes(bytes));
    expect(multipartBody.version.declaredMimeType).toBe('text/plain');
    expect(multipartBody.version.detectedMimeType).toBeNull();
    expect(multipartBody.version.byteSize).toBe(bytes.length);
    expect(multipartBody.document.originalFilename).toBe('multipart-quote-t10.txt');
    expect(multipartBody.version.storagePath).not.toContain('multipart-quote-t10.txt');
  });

  it('a human document verification is recorded separately from the content hash', async () => {
    const app = createApp({ db });
    const upload = await app.request(
      `/api/projects/${projectIdB}/documents`,
      jsonPost(staffToken, uploadBody(projectIdB, {
        filename: 'quote-kanei-t11.txt',
        contentBase64: toBase64('composite kanei quote T11\n')
      }))
    );
    expect(upload.status).toBe(201);
    const documentId = (await upload.json()).document.id as string;

    const rejected = await app.request(
      `/api/documents/${documentId}/verify`,
      jsonPost(staffToken, { verificationStatus: 'verified-by-machine' })
    );
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: 'INVALID_VERIFICATION_STATUS' });

    const verified = await app.request(
      `/api/documents/${documentId}/verify`,
      jsonPost(staffToken, { verificationStatus: 'verified', verificationNote: '原本と照合済み' })
    );
    expect(verified.status).toBe(200);
    const verifiedBody = await verified.json();
    expect(verifiedBody.verificationStatus).toBe('verified');
    expect(verifiedBody.verifiedByUserId).toBe(staffId);
    expect(verifiedBody.verifiedAt).not.toBeNull();
    expect(verifiedBody.verificationNote).toBe('原本と照合済み');

    const versions = await db.select().from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.sha256).toBe(sha256OfBytes(Buffer.from('composite kanei quote T11\n', 'utf8')));
  });
});
