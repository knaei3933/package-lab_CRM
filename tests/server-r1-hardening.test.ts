import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  accounts,
  auditEvents,
  createDatabase,
  documentVersions,
  documents,
  projectAssignments,
  projects,
  sevenPurchaseOrders,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp, isBrowserOriginAllowed } from '../apps/api/src/app.js';
import { documentStorageRoot, validateDocumentStorageRoot } from '../apps/api/src/document-storage.js';
import { loadApiEnv } from '../apps/api/src/env.js';
import { loginGuardIdentity, resolveClientAddress } from '../apps/api/src/login-guard.js';
import { hashPassword } from '../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('R1 hardening tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const foreignStaffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const localProjectId = uuidv7();
const foreignProjectId = uuidv7();
const localSevenPoId = uuidv7();
let adminToken = '';
let staffToken = '';
let viewerToken = '';
let foreignStaffToken = '';
let app: ReturnType<typeof createApp>;
let hardeningApp: ReturnType<typeof createApp>;

function cookie(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function requestJson(token: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', ...cookie(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

function base64(text: string) {
  return Buffer.from(text, 'utf8').toString('base64');
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(`${os.tmpdir()}/kanei-r1-hardening-`);
  app = createApp({ db, allowedOrigins: ['http://127.0.0.1:3081'] });
  hardeningApp = createApp({
    db,
    allowedOrigins: ['http://127.0.0.1:3081'],
    trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
    trustedProxyConfigured: true
  });
  const now = new Date();
  await db.execute(`
    truncate table audit_events, delivery_confirmations, film_deliveries, filling_deliveries,
      film_supply_order_lines, filling_order_lines, film_supply_orders, filling_orders,
      seven_purchase_orders, pre_order_references, document_versions, documents,
      artwork_revisions, artwork_approval_events, evidence_manual_verifications,
      maker_po_events, maker_purchase_orders, commission_readiness,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values([
    { id: adminId, username: 'r1_admin', passwordHash: await hashPassword('composite-admin-pass'), displayName: 'R1代表', role: 'admin' },
    { id: staffId, username: 'r1_staff', passwordHash: await hashPassword('composite-staff-pass'), displayName: 'R1担当', role: 'staff' },
    { id: viewerId, username: 'r1_viewer', passwordHash: await hashPassword('composite-viewer-pass'), displayName: 'R1閲覧', role: 'viewer' },
    { id: foreignStaffId, username: 'r1_foreign_staff', passwordHash: await hashPassword('composite-foreign-pass'), displayName: '他案件担当', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: 'R1顧客', role: 'end_customer', externalCode: 'R1-CUST' },
    { id: sevenAccountId, name: 'R1セブン', role: 'seven', externalCode: 'R1-SEVEN' },
    { id: makerAccountId, name: 'R1メーカー', role: 'maker', externalCode: 'R1-MAKER' }
  ]);
  const projectValues = [localProjectId, foreignProjectId].map((id, index) => ({
    id,
    code: index === 0 ? 'R1-LOCAL' : 'R1-FOREIGN',
    name: index === 0 ? 'R1本地案件' : 'R1他案件',
    businessUnit: 'F1' as const,
    route: 'F1' as const,
    leadSource: 'KANEI',
    endCustomerAccountId: customerAccountId,
    sevenAccountId,
    makerAccountId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  }));
  await db.insert(projects).values(projectValues);
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: adminId, projectId: localProjectId },
    { id: uuidv7(now), userId: staffId, projectId: localProjectId },
    { id: uuidv7(now), userId: viewerId, projectId: localProjectId },
    { id: uuidv7(now), userId: foreignStaffId, projectId: foreignProjectId }
  ]);
  for (const userId of [adminId, staffId, viewerId, foreignStaffId]) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(), userId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    if (userId === adminId) adminToken = token;
    if (userId === staffId) staffToken = token;
    if (userId === viewerId) viewerToken = token;
    if (userId === foreignStaffId) foreignStaffToken = token;
  }
});

afterAll(async () => {
  await pool.end();
  await rm(process.env.DOCUMENT_STORAGE_DIR!, { recursive: true, force: true });
});

describe('R1 hardening', () => {
  it('requires an existing writable non-symlink document storage directory at startup', async () => {
    expect(() => documentStorageRoot({} as NodeJS.ProcessEnv)).toThrow(/DOCUMENT_STORAGE_DIR is required/);
    await expect(validateDocumentStorageRoot({ DOCUMENT_STORAGE_DIR: '/definitely/not/here/kanei' }))
      .rejects.toThrow(/does not exist/);

    const realDirectory = await mkdtemp(`${os.tmpdir()}/kanei-storage-target-`);
    const symlinkPath = path.join(await mkdtemp(`${os.tmpdir()}/kanei-storage-check-`), 'linked');
    const filePath = path.join(await mkdtemp(`${os.tmpdir()}/kanei-storage-file-`), 'not-directory');
    await writeFile(filePath, 'not-a-directory', { flag: 'wx' });
    await symlink(realDirectory, symlinkPath);
    try {
      await expect(validateDocumentStorageRoot({ DOCUMENT_STORAGE_DIR: symlinkPath }))
        .rejects.toThrow(/must not be a symlink/);
      await expect(validateDocumentStorageRoot({ DOCUMENT_STORAGE_DIR: filePath }))
        .rejects.toThrow(/must be a directory/);
      await expect(validateDocumentStorageRoot({ DOCUMENT_STORAGE_DIR: realDirectory })).resolves.toBe(realDirectory);
    } finally {
      await rm(symlinkPath, { force: true });
      await rm(realDirectory, { recursive: true, force: true });
      await rm(filePath, { force: true });
    }
  });

  it('defaults bind host to loopback and accepts an explicit operational host from env', () => {
    expect(loadApiEnv({
      DATABASE_URL: databaseUrl,
      API_PORT: '3081'
    }).host).toBe('127.0.0.1');
    expect(loadApiEnv({
      DATABASE_URL: databaseUrl,
      API_PORT: '3081',
      API_HOST: '192.0.2.10'
    }).host).toBe('192.0.2.10');
  });

  it('rejects a browser cross-origin mutation while accepting the configured same origin', async () => {
    const cross = await hardeningApp.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://hostile.example'
      },
      body: JSON.stringify({ username: 'r1_admin', password: 'irrelevant' })
    });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });

    const same = await hardeningApp.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3081',
        'x-forwarded-for': '203.0.113.10'
      },
      body: JSON.stringify({ username: 'r1_admin', password: 'wrong-password' })
    });
    expect(same.status).toBe(401);

    expect(isBrowserOriginAllowed(new Request('http://127.0.0.1:3081/api/health', {
      headers: { origin: 'http://127.0.0.1:3081' }
    }), { allowedOrigins: ['http://127.0.0.1:3081'] })).toBe(true);
    expect(isBrowserOriginAllowed(new Request('http://127.0.0.1:3081/api/health', {
      headers: { origin: 'https://hostile.example' }
    }), { allowedOrigins: ['http://127.0.0.1:3081'] })).toBe(false);
  });

  it('rate limits and locks login by account and IP, audits failures, and does not lock another IP', async () => {
    const login = (ip: string, password: string) => hardeningApp.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3081',
        'x-forwarded-for': ip
      },
      body: JSON.stringify({ username: 'rate_lock_admin', password })
    });

    for (let index = 0; index < 5; index += 1) {
      const failed = await login('203.0.113.50', `wrong-${index}`);
      expect(failed.status).toBe(401);
    }
    const locked = await login('203.0.113.50', 'composite-admin-pass');
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({
      code: 'LOGIN_TEMPORARILY_LOCKED',
      retryAfterSeconds: expect.any(Number)
    });

    const failures = await db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.action, 'LOGIN_FAILED'),
        eq(auditEvents.entityType, 'login_guard')
      ));
    const rateIdentity = loginGuardIdentity('rate_lock_admin', 'unknown');
    const rateFailures = failures.filter((failure) => failure.entityId === rateIdentity);
    expect(rateFailures).toHaveLength(5);
    for (const failure of rateFailures) {
      expect(failure.projectId).toBeNull();
      expect(failure.actorUserId).toBeNull();
      expect(JSON.stringify(failure)).not.toContain('composite-admin-pass');
      expect(JSON.stringify(failure)).not.toContain('r1_admin');
    }

    const otherAccount = await hardeningApp.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3081',
        'x-forwarded-for': '198.51.100.20'
      },
      body: JSON.stringify({ username: 'r1_staff', password: 'composite-staff-pass' })
    });
    expect(otherAccount.status).toBe(201);

    // An untrusted direct peer cannot make a forwarded address credible.
    expect(resolveClientAddress({
      peerAddress: '203.0.113.99',
      forwardedFor: '198.51.100.7',
      trustedCidrs: ['127.0.0.1/32']
    })).toMatchObject({ address: '203.0.113.99', source: 'socket', trustedPeer: false });
    expect(resolveClientAddress({
      peerAddress: '127.0.0.1',
      forwardedFor: '198.51.100.7',
      trustedCidrs: ['127.0.0.1/32']
    })).toMatchObject({ address: '198.51.100.7', source: 'forwarded', trustedPeer: true });
  });

  it('limits one source across usernames and preserves timing for unknown accounts', async () => {
    const trustedRelayLogin = (username: string, ip: string, password = 'not-the-password') => {
      const request = new Request('http://127.0.0.1:3081/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:3081',
          'x-forwarded-for': ip
        },
        body: JSON.stringify({ username, password })
      });
      // This mirrors the trusted Next relay socket: API sees loopback and may
      // believe the relay-provided XFF value.
      return hardeningApp.fetch(request, {
        incoming: { socket: { remoteAddress: '127.0.0.1' } }
      });
    };

    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await trustedRelayLogin(`ip_rotation_user_${index}`, '203.0.113.70');
      statuses.push(response.status);
    }
    expect(statuses.filter(status => status === 401)).toHaveLength(10);
    expect(statuses.filter(status => status === 429)).toHaveLength(1);

    // Username rotation cannot escape the source lock.
    const rotated = await trustedRelayLogin('another_rotated_user', '203.0.113.70');
    expect(rotated.status).toBe(429);
    expect(await rotated.json()).toMatchObject({ code: 'LOGIN_TEMPORARILY_LOCKED' });

    // A different source is not delayed by the same source's failures.
    const otherSource = await trustedRelayLogin('ip_rotation_user_0', '198.51.100.80');
    expect(otherSource.status).toBe(401);

    // Unknown and known records both execute the same scrypt helper.
    const appSource = await readFile(path.resolve(process.cwd(), 'apps/api/src/app.ts'), 'utf8');
    expect(appSource).toContain('UNKNOWN_ACCOUNT_PASSWORD_HASH');
    expect(appSource).toContain("await verifyPassword(body.password, UNKNOWN_ACCOUNT_PASSWORD_HASH)");
  });

  it('survives parallel guesses with one atomic lock decision', async () => {
    const responses = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      hardeningApp.request('/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:3081',
          'x-forwarded-for': '198.51.100.70'
        },
        body: JSON.stringify({ username: 'parallel_lock_admin', password: `wrong-${index}` })
      })
    ));
    const statuses = responses.map(response => response.status).sort();
    // The identity lock may close after either the identity count (5) or the
    // shared source count (10), but no more than five guesses can be recorded.
    expect(statuses.every(status => status === 401 || status === 429)).toBe(true);
    expect(statuses.filter(status => status === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter(status => status === 429).length).toBeGreaterThanOrEqual(25);
    const [auditCount] = await db.select({
      count: sql<number>`count(*)::int`
    }).from(auditEvents).where(and(
      eq(auditEvents.action, 'LOGIN_FAILED'),
      sql`${auditEvents.requestMetadata} ->> 'remoteAddress' = '198.51.100.70'`
    ));
    expect(Number(auditCount?.count ?? 0)).toBeLessThanOrEqual(5);
  });

  it('logs document views and downloads, authorizes project membership and role, and never exposes hash or storage metadata', async () => {
    const poNow = new Date();
    await db.insert(sevenPurchaseOrders).values({
      id: localSevenPoId,
      projectId: localProjectId,
      poNumber: 'SEVEN-R1-DOCUMENT-001',
      officialRegisteredAt: poNow,
      promotedAt: poNow,
      promotedByUserId: staffId,
      verificationStatus: 'verified' as const,
      verifiedAt: poNow,
      verifiedByUserId: staffId,
      verificationNote: 'R1文書テスト',
      createdByUserId: staffId,
      createdAt: poNow,
      updatedAt: poNow
    });

    const localUpload = await requestJson(staffToken, 'POST', `/api/projects/${localProjectId}/documents`, {
      documentType: 'seven_po',
      issuerEntity: 'seven',
      filename: 'r1-document.txt',
      contentType: 'text/plain',
      contentBase64: base64('private local document bytes\n')
    });
    expect(localUpload.status).toBe(201);
    const localDocument = localUpload.body as { document: { id: string }; version: { id: string; storagePath: string; sha256: string } };

    const foreignUpload = await requestJson(foreignStaffToken, 'POST', `/api/projects/${foreignProjectId}/documents`, {
      documentType: 'seven_po',
      issuerEntity: 'seven',
      filename: 'r1-document.txt',
      contentType: 'text/plain',
      contentBase64: base64('private local document bytes\n')
    });
    expect(foreignUpload.status).toBe(201);
    const foreignDocument = foreignUpload.body as { version: { id: string } };

    const approved = await requestJson(staffToken, 'POST', `/api/projects/${localProjectId}/documents`, {
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      filename: 'r1-viewed-approval.eml',
      contentType: 'message/rfc822',
      sevenPurchaseOrderId: localSevenPoId,
      contentBase64: base64('Message-ID: <r1-viewed-document@example.test>\n')
    });
    expect(approved.status).toBe(201);
    const approvalVersion = (approved.body as { version: { id: string } }).version.id;

    const downloaded = await app.request(`/api/document-versions/${localDocument.version.id}/download`, {
      headers: cookie(staffToken)
    });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).toString('utf8')).toContain('private local document bytes');
    expect(downloaded.headers.get('content-disposition')).toContain('attachment');
    expect(downloaded.headers.get('cache-control')).toBe('no-store');
    expect(downloaded.headers.get('content-disposition')).not.toContain(localDocument.version.storagePath);
    expect(downloaded.headers.get('content-disposition')).not.toContain(localDocument.version.sha256);

    const viewed = await app.request(`/api/document-versions/${approvalVersion}/evidence-message-id`, {
      headers: cookie(staffToken)
    });
    expect(viewed.status).toBe(200);

    const viewerDownload = await requestJson(viewerToken, 'GET', `/api/document-versions/${localDocument.version.id}/download`);
    expect(viewerDownload.status).toBe(403);
    expect(JSON.stringify(viewerDownload.body)).not.toContain(localDocument.version.sha256);
    expect(JSON.stringify(viewerDownload.body)).not.toContain(localDocument.version.storagePath);

    const foreignDownload = await requestJson(foreignStaffToken, 'GET', `/api/document-versions/${localDocument.version.id}/download`);
    expect(foreignDownload.status).toBe(403);
    expect(foreignDownload.body).toEqual({ error: '権限がありません' });

    // An admin without a project assignment remains globally authorized.
    await db.delete(projectAssignments).where(and(
      eq(projectAssignments.userId, adminId),
      eq(projectAssignments.projectId, localProjectId)
    ));
    const adminDownload = await app.request(`/api/document-versions/${localDocument.version.id}/download`, {
      headers: cookie(adminToken)
    });
    expect(adminDownload.status).toBe(200);

    const accessEvents = await db.select().from(auditEvents)
      .where(eq(auditEvents.entityType, 'document_version'));
    const downloadedEvents = accessEvents.filter((event) => event.action === 'DOCUMENT_VERSION_DOWNLOADED');
    const viewedEvents = accessEvents.filter((event) => event.action === 'DOCUMENT_VERSION_VIEWED');
    expect(downloadedEvents).toHaveLength(2);
    expect(viewedEvents).toHaveLength(1);
    for (const event of [...downloadedEvents, ...viewedEvents]) {
      expect(event.actorUserId).toBeDefined();
      expect(JSON.stringify(event)).not.toContain(localDocument.version.storagePath);
      expect(JSON.stringify(event)).not.toContain(localDocument.version.sha256);
    }

    const staffHistory = await requestJson(staffToken, 'GET', `/api/projects/${localProjectId}/audit-history?entityType=document_version&entityId=${localDocument.version.id}`);
    expect(staffHistory.status).toBe(200);
    const staffEvent = (staffHistory.body as { events: Array<{ afterState: Record<string, unknown> | null }> }).events[0]!;
    const downloadEvent = (staffHistory.body as {
      events: Array<{ action: string; afterState: Record<string, unknown> | null }>
    }).events.find((event) => event.action === 'DOCUMENT_VERSION_DOWNLOADED')!;
    expect(downloadEvent.afterState).toMatchObject({
      documentId: localDocument.document.id,
      versionNumber: 1
    });
    expect(downloadEvent.afterState).not.toHaveProperty('sha256');
    expect(downloadEvent.afterState).not.toHaveProperty('storagePath');

    // A database path outside the validated root is rejected before bytes are
    // opened; no path or hash is reflected in the response.
    const hostilePath = '/etc/hosts';
    await db.insert(documentVersions).values({
      id: uuidv7(),
      documentId: localDocument.document.id,
      versionNumber: 2,
      sha256: 'a'.repeat(64),
      byteSize: 4,
      storagePath: hostilePath,
      originalFilename: 'hostile.bin',
      declaredMimeType: 'text/plain',
      detectedMimeType: null,
      sizeCheckPassed: true,
      typeCheckPassed: true,
      createdByUserId: staffId,
      createdAt: new Date()
    });
    const hostile = await requestJson(staffToken, 'GET', `/api/document-versions/${(await db.select().from(documentVersions).where(eq(documentVersions.versionNumber, 2)))[0]?.id}/download`);
    expect(hostile.status).toBe(404);
    expect(JSON.stringify(hostile.body)).not.toContain(hostilePath);
  });
});
