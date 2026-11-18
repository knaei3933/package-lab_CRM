import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  auditEvents,
  createDatabase,
  filmSupplyOrders,
  projectAssignments,
  projects,
  sevenPurchaseOrders,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/password.js';
import { hashToken, issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();

let adminToken = '';
let staffToken = '';
let viewerToken = '';
let app: ReturnType<typeof createApp>;
let poId = '';
let heldOrderId = '';

async function createSession(userId: string) {
  const now = new Date();
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({
    id: uuidv7(now),
    userId,
    tokenHash,
    expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000)
  });
  return token;
}

function cookieHeader(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function postAs(token: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookieHeader(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-approved-rules-'));
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_purchase_orders, artwork_revisions,
      artwork_approval_events, evidence_manual_verifications, documents, document_versions,
      pre_order_references, seven_purchase_orders, film_supply_orders, film_supply_order_lines,
      film_deliveries, filling_orders, filling_order_lines, filling_deliveries,
      commission_readiness, delivery_confirmations, project_assignments, projects, sessions,
      accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'approved_admin_test', passwordHash: await hashPassword('approved-admin-pass'), displayName: '代表者', role: 'admin' },
    { id: staffId, username: 'approved_staff_test', passwordHash: await hashPassword('approved-staff-pass'), displayName: '担当者', role: 'staff' },
    { id: viewerId, username: 'approved_viewer_test', passwordHash: await hashPassword('approved-viewer-pass'), displayName: '閲覧者', role: 'viewer' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成顧客', role: 'end_customer', externalCode: 'APPROVED-CUST' },
    { id: sevenAccountId, name: '合成セブン', role: 'seven', externalCode: 'APPROVED-SEVEN' },
    { id: makerAccountId, name: '合成メーカー', role: 'maker', externalCode: 'APPROVED-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'APPROVED-RULES',
    name: '承認済みサーバー規則テスト',
    businessUnit: 'F1',
    route: 'F1',
    leadSource: 'KANEI',
    status: 'DRAFT',
    endCustomerAccountId: customerAccountId,
    sevenAccountId,
    makerAccountId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId },
    { id: uuidv7(now), userId: viewerId, projectId }
  ]);
  adminToken = await createSession(adminId);
  staffToken = await createSession(staffId);
  viewerToken = await createSession(viewerId);
  const created = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: 'PO-APPROVED-FIRST',
    originalReceivedAt: '2026-11-18T00:00:00.000Z'
  });
  expect(created.status).toBe(201);
  poId = (created.body as { id: string }).id;

  // A synthetic hold event preserves the exact immediate-origin contract used
  // by production transitions; this avoids building the full maker chain here.
  const holdAt = new Date();
  heldOrderId = uuidv7(holdAt);
  await db.insert(filmSupplyOrders).values({
    id: heldOrderId,
    projectId,
    code: 'FSO-APPROVED-HOLD',
    status: 'ON_HOLD',
    paymentTerms: 'prepaid',
    holdReason: 'test hold',
    createdByUserId: adminId,
    createdAt: holdAt,
    updatedAt: holdAt,
    deletedAt: null
  });
  await db.insert(auditEvents).values({
    id: uuidv7(holdAt),
    projectId,
    actorUserId: staffId,
    action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
    entityType: 'film_supply_order',
    entityId: heldOrderId,
    beforeState: { status: 'APPROVED_FOR_MANUAL_SEND' },
    afterState: { status: 'ON_HOLD' },
    occurredAt: holdAt,
    requestMetadata: { operation: 'film_order:transition' }
  });
});

afterAll(async () => {
  await pool.end();
});

describe('official registration date overwrite rule', () => {
  it('staff records the first date, viewer cannot, and staff cannot overwrite it', async () => {
    const viewerFirst = await postAs(viewerToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-11-18T00:00:00.000Z'
    });
    expect(viewerFirst.status).toBe(403);

    const staffFirst = await postAs(staffToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-11-18T00:00:00.000Z'
    });
    expect(staffFirst.status).toBe(200);

    const staffOverwrite = await postAs(staffToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-01-01T00:00:00.000Z'
    });
    expect(staffOverwrite.status).toBe(403);
    const [afterStaffRefusal] = await db.select().from(sevenPurchaseOrders)
      .where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    expect(afterStaffRefusal?.officialRegisteredAt?.toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });

  it('admin overwrite succeeds and the audit event carries both date values', async () => {
    const overwritten = await postAs(adminToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-01-01T00:00:00.000Z'
    });
    expect(overwritten.status).toBe(200);

    const [row] = await db.select({ officialRegisteredAt: sevenPurchaseOrders.officialRegisteredAt })
      .from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    expect(row?.officialRegisteredAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    const [event] = await db.select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, poId))
      .orderBy(sql`${auditEvents.occurredAt} desc`)
      .limit(1);
    expect(event?.action).toBe('SEVEN_PO_OFFICIALLY_REGISTERED');
    expect(event?.beforeState).toMatchObject({
      officialRegisteredAt: '2026-11-18T00:00:00.000Z'
    });
    expect(event?.afterState).toMatchObject({
      officialRegisteredAt: '2026-01-01T00:00:00.000Z'
    });
  });
});

describe('staff approval evidence selection contract', () => {
  it('exposes document type and artwork binding, but not raw upload snapshots', () => {
    const row = {
      id: 'audit-1',
      action: 'DOCUMENT_VERSION_UPLOADED',
      entityType: 'document_version',
      entityId: 'version-1',
      beforeState: null,
      afterState: {
        id: 'version-1',
        documentId: 'secret-document-id',
        documentType: 'approval_evidence',
        filmSupplyOrderId: 'order-1',
        designKey: 'label-front',
        sha256: 'secret-hash',
        storagePath: '/secret/path',
        byteSize: 1234
      },
      occurredAt: new Date('2026-11-18T00:00:00.000Z'),
      requestMetadata: { operation: 'document:create', documentId: 'secret-document-id' },
      actor: { id: staffId, displayName: '担当者', role: 'staff' }
    };

    const staffViews = buildAuditViewForRole('staff', [row]);
    expect(staffViews).toHaveLength(1);
    const staffView = staffViews[0]!;
    expect(staffView.afterState).toEqual({
      id: 'version-1',
      documentType: 'approval_evidence',
      filmSupplyOrderId: 'order-1',
      designKey: 'label-front'
    });
    expect(staffView.requestMetadata).toEqual({ operation: 'document:create' });

    expect(buildAuditViewForRole('viewer', [row])[0]).not.toHaveProperty('afterState');
  });
});

describe('hold release and production-chain guard', () => {
  it('blocks a pre-acceptance hold from reaching production for every role', async () => {
    const staffAttempt = await postAs(staffToken, `/api/film-supply-orders/${heldOrderId}/transitions`, {
      to: 'FILM_IN_PRODUCTION'
    });
    expect(staffAttempt.status).toBe(422);
    expect(staffAttempt.body).toMatchObject({ code: 'INVALID_TRANSITION' });

    const adminAttempt = await postAs(adminToken, `/api/film-supply-orders/${heldOrderId}/transitions`, {
      to: 'FILM_IN_PRODUCTION'
    });
    expect(adminAttempt.status).toBe(422);
    expect(adminAttempt.body).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('makes hold release admin-only, requires a reason, and returns exactly to the held origin', async () => {
    const staffRelease = await postAs(staffToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {
      reason: 'staff cannot release'
    });
    expect(staffRelease.status).toBe(403);
    const viewerRelease = await postAs(viewerToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {
      reason: 'viewer cannot release'
    });
    expect(viewerRelease.status).toBe(403);

    const missingReason = await postAs(adminToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {});
    expect(missingReason.status).toBe(422);
    expect(missingReason.body).toMatchObject({ code: 'HOLD_RELEASE_REASON_REQUIRED' });

    const released = await postAs(adminToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {
      reason: 'root cause resolved'
    });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ status: 'APPROVED_FOR_MANUAL_SEND', holdReason: null });

    const [event] = await db.select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'FILM_SUPPLY_ORDER_HOLD_RELEASED'))
      .orderBy(sql`${auditEvents.occurredAt} desc`)
      .limit(1);
    expect(event?.entityId).toBe(heldOrderId);
    expect(event?.beforeState).toMatchObject({ status: 'ON_HOLD', holdReason: 'test hold' });
    expect(event?.afterState).toMatchObject({ status: 'APPROVED_FOR_MANUAL_SEND', holdReason: null });
    expect(event?.requestMetadata).toMatchObject({ operation: 'film_order:release_hold', reason: 'root cause resolved' });
  });
});
