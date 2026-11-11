import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  canPerform,
  deriveOrderApprovalGate,
  evaluateApprovalEvidenceBinding,
  evaluateRevisionRegistrationGate,
  evaluateSevenPoChecklist,
  evaluateSevenPoPrecedenceGate,
  evaluateSevenPoVerificationGate,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  hasApprovalHistoryForDesign,
  isExceptionFilmSupplyOrderState,
  isOfficialArtifactDocumentType,
  isTerminalFilmSupplyOrderState,
  shouldAdvanceToDualApproved,
  toQuantityString,
  transitionFilmSupplyOrder,
  validateApprovalDecision,
  validateApprovalEvidenceSource,
  validateApprovalOrganization,
  validateDocumentType,
  validateIssuerEntity,
  validateProjectRoute,
  validateQuantity,
  validateUnit,
  type ApprovalEventView,
  type ApprovalOrganization,
  type ArtworkRevisionView,
  type DocumentType,
  type FilmSupplyOrderState,
  type IssuerEntity,
  type MeasureUnit,
  type UnitDomain
} from '@kanei/core';
import {
  accounts,
  artworkApprovalEvents,
  artworkRevisions,
  auditEvents,
  commissionReadiness,
  documentVersions,
  documents,
  filmDeliveries,
  filmSupplyOrderLines,
  filmSupplyOrders,
  fillingDeliveries,
  fillingOrderLines,
  fillingOrders,
  preOrderReferences,
  projects,
  sevenPurchaseOrders,
  sessions,
  users
} from '@kanei/db/schema';
import { uuidv7 } from '@kanei/db';
import { getSessionUser, issueToken, readSessionToken, toActor, type AppDatabase } from './auth.js';
import {
  documentStorageRoot,
  evaluateDocumentContent,
  writeStoredFile,
  type DocumentContentCheck
} from './document-storage.js';
import { hashPassword, verifyPassword } from './password.js';

export interface AppOptions {
  db: AppDatabase;
  secureCookies?: boolean;
}

interface AuthContext {
  Variables: { user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>> };
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const ALL_FILM_SUPPLY_ORDER_STATES: readonly string[] = [
  ...FILM_SUPPLY_ORDER_STATES,
  ...FILM_SUPPLY_ORDER_EXCEPTION_STATES
];

interface OrderLineInput {
  lineNumber: number;
  description: string;
  orderedQuantity: string;
  unit: MeasureUnit;
}

type OrderLineValidation =
  | { ok: true; line: OrderLineInput }
  | { ok: false; code: string; message: string };

/**
 * Validates one order line against the unit vocabulary of its domain. Unit
 * validation runs first so a cross-domain unit is reported as
 * UNIT_DOMAIN_MISMATCH even when other fields are also invalid.
 */
function validateOrderLineInput(domain: UnitDomain, raw: any): OrderLineValidation {
  const unitCheck = validateUnit(raw?.unit, domain);
  if (!unitCheck.ok) return { ok: false, code: unitCheck.code, message: unitCheck.message };

  const quantityCheck = validateQuantity(raw?.orderedQuantity);
  if (!quantityCheck.ok) return { ok: false, code: quantityCheck.code, message: quantityCheck.message };

  if (typeof raw?.lineNumber !== 'number' || !Number.isInteger(raw.lineNumber) || raw.lineNumber <= 0) {
    return { ok: false, code: 'INVALID_LINE_NUMBER', message: 'lineNumber must be a positive integer' };
  }
  if (typeof raw?.description !== 'string' || raw.description.length === 0) {
    return { ok: false, code: 'DESCRIPTION_REQUIRED', message: 'description is required' };
  }
  return {
    ok: true,
    line: {
      lineNumber: raw.lineNumber,
      description: raw.description,
      orderedQuantity: toQuantityString(quantityCheck.quantity),
      unit: unitCheck.unit
    }
  };
}

function parseOptionalDate(value: unknown): { ok: true; date: Date | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, date: null };
  if (typeof value !== 'string') return { ok: false };
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, date };
}

function parseRequiredDate(value: unknown): { ok: true; date: Date } | { ok: false } {
  if (typeof value !== 'string') return { ok: false };
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, date };
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createApp({ db, secureCookies = false }: AppOptions) {
  const app = new Hono<AuthContext>();

  app.get('/api/health', (context) => context.json({ status: 'ok', app: 'api', port: 3081 }));

  app.post('/api/auth/login', async (context) => {
    const body = await context.req.json().catch(() => null) as {
      username?: unknown;
      password?: unknown;
    } | null;
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      return context.json({ error: 'ユーザー名とパスワードが必要です' }, 400);
    }

    const [user] = await db.select().from(users).where(eq(users.username, body.username)).limit(1);
    if (!user || !user.isActive || user.deletedAt || !(await verifyPassword(body.password, user.passwordHash))) {
      return context.json({ error: '認証情報が正しくありません' }, 401);
    }

    const { token, tokenHash } = issueToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.insert(sessions).values({ id: uuidv7(), userId: user.id, tokenHash, expiresAt });
    setCookie(context, 'kanei_mvp_session', token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: secureCookies,
      path: '/',
      expires: expiresAt
    });
    return context.json({ id: user.id, role: user.role, displayName: user.displayName }, 201);
  });

  app.post('/api/auth/logout', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (user) {
      const token = readSessionToken(context.req.raw);
      if (token) {
        await db.update(sessions).set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      }
    }
    deleteCookie(context, 'kanei_mvp_session', { path: '/' });
    return context.json({ status: 'logged_out' }, 200);
  });

  app.get('/api/me', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    return context.json({ id: user.id, role: user.role, assignedProjectIds: user.assignedProjectIds });
  });

  app.post('/api/projects', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);

    const decision = canPerform(toActor(user), 'project:create', 'F1');
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const routeCheck = validateProjectRoute(body?.route);
    if (!routeCheck.ok) {
      return context.json({ error: 'M0ではF1案件のみ作成できます', code: routeCheck.code }, 422);
    }
    if (
      typeof body?.code !== 'string' || body.code.length === 0 ||
      typeof body?.name !== 'string' || body.name.length === 0 ||
      typeof body?.endCustomerAccountId !== 'string' ||
      typeof body?.sevenAccountId !== 'string' ||
      typeof body?.makerAccountId !== 'string'
    ) {
      return context.json({ error: '必須項目が不足しています' }, 422);
    }

    const accountIds = Array.from(new Set([
      body.endCustomerAccountId,
      body.sevenAccountId,
      body.makerAccountId
    ]));
    if (accountIds.length !== 3) return context.json({ error: '3種類の取引先が必要です' }, 422);

    const rows = await db.select().from(accounts).where(inArray(accounts.id, accountIds));
    if (rows.length !== 3 || rows.some((row) => !row.isActive || row.deletedAt)) {
      return context.json({ error: '取引先が無効です' }, 422);
    }
    const roleById = new Map(rows.map((row) => [row.id, row.role] as const));
    const validRoles = roleById.get(body.endCustomerAccountId) === 'end_customer'
      && roleById.get(body.sevenAccountId) === 'seven'
      && roleById.get(body.makerAccountId) === 'maker';
    if (!validRoles) return context.json({ error: '取引先役割が正しくありません' }, 422);

    const projectId = uuidv7();
    const now = new Date();
    const project = {
      id: projectId,
      code: body.code,
      name: body.name,
      businessUnit: 'F1' as const,
      route: routeCheck.route,
      leadSource: 'KANEI',
      status: 'DRAFT' as const,
      endCustomerAccountId: body.endCustomerAccountId,
      sevenAccountId: body.sevenAccountId,
      makerAccountId: body.makerAccountId,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now
    };

    await db.transaction(async (tx) => {
      await tx.insert(projects).values(project);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'PROJECT_CREATED',
        entityType: 'project',
        entityId: projectId,
        afterState: project,
        occurredAt: now,
        requestMetadata: { businessUnit: 'F1', route: 'F1', operation: 'project:create' }
      });
    });

    return context.json(project, 201);
  });

  app.get('/api/projects/:projectId', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    const decision = canPerform(toActor(user), 'project:read', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);
    return context.json(project);
  });

  app.patch('/api/projects/:projectId', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');

    const body = await context.req.json().catch(() => null) as any;
    if (Object.hasOwn(body ?? {}, 'route') || Object.hasOwn(body ?? {}, 'businessUnit')) {
      return context.json({ error: 'M0ではルート変更は禁止されています', code: 'ROUTE_IMMUTABLE' }, 422);
    }

    const decision = canPerform(toActor(user), 'project:update', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (typeof body?.name !== 'string' || body.name.length === 0) {
      return context.json({ error: '更新項目が無効です' }, 422);
    }

    const [current] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!current || current.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);
    const updated = { name: body.name, updatedAt: new Date() };
    await db.transaction(async (tx) => {
      await tx.update(projects).set(updated).where(eq(projects.id, projectId));
      await tx.insert(auditEvents).values({
        id: uuidv7(updated.updatedAt),
        actorUserId: user.id,
        action: 'PROJECT_UPDATED',
        entityType: 'project',
        entityId: projectId,
        beforeState: current,
        afterState: { ...current, ...updated },
        occurredAt: updated.updatedAt
      });
    });
    return context.json({ ...current, ...updated });
  });

  app.post('/api/ceo-approvals', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const decision = canPerform(toActor(user), 'ceo_approve', 'F1');
    if (!decision.allowed) {
      return context.json({ error: '代表者のみ承認できます' }, 403);
    }
    return context.json({ status: 'M2_RESERVED' }, 202);
  });

  // ---------------------------------------------------------------- M1: seven
  // purchase orders and pre-order references (design section 5.6)
  app.post('/api/projects/:projectId/seven-purchase-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    const decision = canPerform(toActor(user), 'seven_po:create', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.poNumber !== 'string' || body.poNumber.length === 0) {
      return context.json({ error: '発注番号が必要です', code: 'PO_NUMBER_REQUIRED' }, 422);
    }
    const receivedAt = parseOptionalDate(body?.originalReceivedAt);
    if (!receivedAt.ok) return context.json({ error: '原本受領日が不正です', code: 'INVALID_DATE' }, 422);
    const registeredAt = parseOptionalDate(body?.officialRegisteredAt);
    if (!registeredAt.ok) return context.json({ error: '公式登録日が不正です', code: 'INVALID_DATE' }, 422);

    if (typeof body?.preOrderReferenceId === 'string') {
      const [reference] = await db.select().from(preOrderReferences)
        .where(and(eq(preOrderReferences.id, body.preOrderReferenceId), eq(preOrderReferences.projectId, projectId)))
        .limit(1);
      if (!reference) return context.json({ error: '先行発注参照が見つかりません', code: 'PRE_ORDER_REFERENCE_NOT_FOUND' }, 422);
    }

    const now = new Date();
    const poId = uuidv7(now);
    const purchaseOrder = {
      id: poId,
      projectId,
      poNumber: body.poNumber,
      preOrderReferenceId: typeof body?.preOrderReferenceId === 'string' ? body.preOrderReferenceId : null,
      originalReceivedAt: receivedAt.date,
      officialRegisteredAt: registeredAt.date,
      promotedAt: null,
      promotedByUserId: null,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.insert(sevenPurchaseOrders).values(purchaseOrder);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'SEVEN_PO_CREATED',
        entityType: 'seven_purchase_order',
        entityId: poId,
        afterState: purchaseOrder,
        occurredAt: now,
        requestMetadata: { operation: 'seven_po:create' }
      });
    });
    return context.json(purchaseOrder, 201);
  });

  app.post('/api/seven-purchase-orders/:poId/register-official', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');

    const [current] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    if (!current) return context.json({ error: 'セブン発注書が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'seven_po:register', 'F1', current.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const registeredAt = parseRequiredDate(body?.officialRegisteredAt);
    if (!registeredAt.ok) return context.json({ error: '公式登録日が必要です', code: 'OFFICIAL_REGISTRATION_REQUIRED' }, 422);

    const updated = { officialRegisteredAt: registeredAt.date, updatedAt: new Date() };
    await db.transaction(async (tx) => {
      await tx.update(sevenPurchaseOrders).set(updated).where(eq(sevenPurchaseOrders.id, poId));
      await tx.insert(auditEvents).values({
        id: uuidv7(updated.updatedAt),
        actorUserId: user.id,
        action: 'SEVEN_PO_OFFICIALLY_REGISTERED',
        entityType: 'seven_purchase_order',
        entityId: poId,
        beforeState: current,
        afterState: { ...current, ...updated },
        occurredAt: updated.updatedAt,
        requestMetadata: { operation: 'seven_po:register' }
      });
    });
    return context.json({ ...current, ...updated });
  });

  app.post('/api/projects/:projectId/pre-order-references', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    const decision = canPerform(toActor(user), 'pre_order:create', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.referenceCode !== 'string' || body.referenceCode.length === 0) {
      return context.json({ error: '参照コードが必要です', code: 'REFERENCE_CODE_REQUIRED' }, 422);
    }
    const receivedAt = parseOptionalDate(body?.originalReceivedAt);
    if (!receivedAt.ok) return context.json({ error: '原本受領日が不正です', code: 'INVALID_DATE' }, 422);

    const now = new Date();
    const referenceId = uuidv7(now);
    const reference = {
      id: referenceId,
      projectId,
      referenceCode: body.referenceCode,
      note: optionalText(body?.note),
      originalReceivedAt: receivedAt.date,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.insert(preOrderReferences).values(reference);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'PRE_ORDER_REFERENCE_CREATED',
        entityType: 'pre_order_reference',
        entityId: referenceId,
        afterState: reference,
        occurredAt: now,
        requestMetadata: { operation: 'pre_order:create' }
      });
    });
    return context.json(reference, 201);
  });

  app.post('/api/pre-order-references/:preOrderId/promote', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const preOrderId = context.req.param('preOrderId');

    const [reference] = await db.select().from(preOrderReferences).where(eq(preOrderReferences.id, preOrderId)).limit(1);
    if (!reference) return context.json({ error: '先行発注参照が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'pre_order:promote', 'F1', reference.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.poNumber !== 'string' || body.poNumber.length === 0) {
      return context.json({ error: '発注番号が必要です', code: 'PO_NUMBER_REQUIRED' }, 422);
    }
    const receivedAt = parseOptionalDate(body?.originalReceivedAt);
    if (!receivedAt.ok) return context.json({ error: '原本受領日が不正です', code: 'INVALID_DATE' }, 422);
    const registeredAt = parseOptionalDate(body?.officialRegisteredAt);
    if (!registeredAt.ok) return context.json({ error: '公式登録日が不正です', code: 'INVALID_DATE' }, 422);

    const now = new Date();
    const poId = uuidv7(now);
    const purchaseOrder = {
      id: poId,
      projectId: reference.projectId,
      poNumber: body.poNumber,
      preOrderReferenceId: reference.id,
      originalReceivedAt: receivedAt.date ?? reference.originalReceivedAt,
      officialRegisteredAt: registeredAt.date,
      promotedAt: now,
      promotedByUserId: user.id,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.insert(sevenPurchaseOrders).values(purchaseOrder);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'PRE_ORDER_PROMOTED',
        entityType: 'seven_purchase_order',
        entityId: poId,
        afterState: { ...purchaseOrder, promotedFromPreOrderId: reference.id },
        occurredAt: now,
        requestMetadata: { operation: 'pre_order:promote' }
      });
    });
    return context.json(purchaseOrder, 201);
  });

  // --------------------------------------------- M1: film supply orders (design
  // sections 5 and 6.1). Units are film vocabulary only.
  app.post('/api/projects/:projectId/film-supply-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    const decision = canPerform(toActor(user), 'film_order:create', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.code !== 'string' || body.code.length === 0) {
      return context.json({ error: '発注コードが必要です', code: 'ORDER_CODE_REQUIRED' }, 422);
    }
    const rawLines = Array.isArray(body?.lines) ? body.lines : [];
    const lines: OrderLineInput[] = [];
    for (const rawLine of rawLines) {
      const lineCheck = validateOrderLineInput('film', rawLine);
      if (!lineCheck.ok) return context.json({ error: lineCheck.message, code: lineCheck.code }, 422);
      lines.push(lineCheck.line);
    }

    let sevenPurchaseOrderId: string | null = null;
    if (typeof body?.sevenPurchaseOrderId === 'string') {
      const [po] = await db.select().from(sevenPurchaseOrders)
        .where(and(eq(sevenPurchaseOrders.id, body.sevenPurchaseOrderId), eq(sevenPurchaseOrders.projectId, projectId)))
        .limit(1);
      if (!po) return context.json({ error: 'セブン発注書が見つかりません', code: 'SEVEN_PO_NOT_FOUND' }, 422);
      sevenPurchaseOrderId = po.id;
    }

    const now = new Date();
    const orderId = uuidv7(now);
    const order = {
      id: orderId,
      projectId,
      code: body.code,
      status: 'DRAFT' as const,
      sevenPurchaseOrderId,
      holdReason: null,
      exceptionNote: null,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    await db.transaction(async (tx) => {
      await tx.insert(filmSupplyOrders).values(order);
      if (lines.length > 0) {
        await tx.insert(filmSupplyOrderLines).values(lines.map((line) => ({
          id: uuidv7(now),
          filmSupplyOrderId: orderId,
          lineNumber: line.lineNumber,
          description: line.description,
          orderedQuantity: line.orderedQuantity,
          unit: line.unit
        })));
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILM_SUPPLY_ORDER_CREATED',
        entityType: 'film_supply_order',
        entityId: orderId,
        afterState: { ...order, lineCount: lines.length },
        occurredAt: now,
        requestMetadata: { operation: 'film_order:create' }
      });
    });

    const createdLines = await db.select().from(filmSupplyOrderLines)
      .where(eq(filmSupplyOrderLines.filmSupplyOrderId, orderId));
    return context.json({ ...order, lines: createdLines }, 201);
  });

  app.post('/api/film-supply-orders/:orderId/lines', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order_line:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const lineCheck = validateOrderLineInput('film', body);
    if (!lineCheck.ok) return context.json({ error: lineCheck.message, code: lineCheck.code }, 422);

    const now = new Date();
    const lineId = uuidv7(now);
    const line = {
      id: lineId,
      filmSupplyOrderId: orderId,
      lineNumber: lineCheck.line.lineNumber,
      description: lineCheck.line.description,
      orderedQuantity: lineCheck.line.orderedQuantity,
      unit: lineCheck.line.unit
    };
    await db.transaction(async (tx) => {
      await tx.insert(filmSupplyOrderLines).values(line);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILM_SUPPLY_ORDER_LINE_CREATED',
        entityType: 'film_supply_order_line',
        entityId: lineId,
        afterState: line,
        occurredAt: now,
        requestMetadata: { operation: 'film_order_line:create', filmSupplyOrderId: orderId }
      });
    });
    return context.json(line, 201);
  });

  app.post('/api/film-supply-orders/:orderId/deliveries', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_delivery:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const unitCheck = validateUnit(body?.unit, 'film');
    if (!unitCheck.ok) return context.json({ error: unitCheck.message, code: unitCheck.code }, 422);
    const quantityCheck = validateQuantity(body?.deliveredQuantity);
    if (!quantityCheck.ok) return context.json({ error: quantityCheck.message, code: quantityCheck.code }, 422);
    if (typeof body?.filmSupplyOrderLineId !== 'string' || body.filmSupplyOrderLineId.length === 0) {
      return context.json({ error: '明細IDが必要です', code: 'FILM_ORDER_LINE_REQUIRED' }, 422);
    }
    const deliveredAt = parseOptionalDate(body?.deliveredAt);
    if (!deliveredAt.ok) return context.json({ error: '納期日が不正です', code: 'INVALID_DATE' }, 422);
    if (body?.deliverySequence !== undefined
      && (typeof body.deliverySequence !== 'number' || !Number.isInteger(body.deliverySequence) || body.deliverySequence <= 0)) {
      return context.json({ error: '納品連番は正の整数です', code: 'INVALID_DELIVERY_SEQUENCE' }, 422);
    }

    const [line] = await db.select().from(filmSupplyOrderLines)
      .where(and(
        eq(filmSupplyOrderLines.id, body.filmSupplyOrderLineId),
        eq(filmSupplyOrderLines.filmSupplyOrderId, orderId)
      )).limit(1);
    if (!line) return context.json({ error: '明細が見つかりません', code: 'FILM_ORDER_LINE_NOT_FOUND' }, 422);

    const [existing] = await db.select({ maxSequence: sql<number>`coalesce(max(${filmDeliveries.deliverySequence}), 0)` })
      .from(filmDeliveries)
      .where(eq(filmDeliveries.filmSupplyOrderLineId, line.id));
    const sequence = body?.deliverySequence ?? (existing?.maxSequence ?? 0) + 1;
    if (body?.deliverySequence !== undefined) {
      const [clash] = await db.select({ id: filmDeliveries.id })
        .from(filmDeliveries)
        .where(and(
          eq(filmDeliveries.filmSupplyOrderLineId, line.id),
          eq(filmDeliveries.deliverySequence, sequence)
        )).limit(1);
      if (clash) {
        return context.json({ error: '納品連番が重複しています', code: 'DELIVERY_SEQUENCE_EXISTS' }, 422);
      }
    }

    const now = new Date();
    const deliveryId = uuidv7(now);
    const delivery = {
      id: deliveryId,
      filmSupplyOrderId: orderId,
      filmSupplyOrderLineId: line.id,
      unit: unitCheck.unit,
      deliveredQuantity: toQuantityString(quantityCheck.quantity),
      deliverySequence: sequence,
      deliveredAt: deliveredAt.date ?? now,
      carrierReference: optionalText(body?.carrierReference),
      note: optionalText(body?.note),
      createdAt: now
    };

    await db.transaction(async (tx) => {
      await tx.insert(filmDeliveries).values(delivery);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILM_DELIVERY_RECORDED',
        entityType: 'film_delivery',
        entityId: deliveryId,
        afterState: delivery,
        occurredAt: now,
        requestMetadata: { operation: 'film_delivery:create', filmSupplyOrderId: orderId }
      });
    });

    const [created] = await db.select().from(filmDeliveries).where(eq(filmDeliveries.id, deliveryId)).limit(1);
    return context.json(created ?? delivery, 201);
  });

  app.post('/api/film-supply-orders/:orderId/transitions', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order:transition', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.to !== 'string' || !ALL_FILM_SUPPLY_ORDER_STATES.includes(body.to)) {
      return context.json({ error: '遷移先状態が不正です', code: 'UNKNOWN_STATE' }, 422);
    }
    const target = body.to as FilmSupplyOrderState;
    const transition = transitionFilmSupplyOrder(order.status, target);
    if (!transition.ok) {
      return context.json({ error: '許可されていない状態遷移です', code: 'INVALID_TRANSITION', from: order.status, to: target }, 422);
    }

    if (target === 'SEVEN_PO_VERIFIED') {
      if (!order.sevenPurchaseOrderId) {
        return context.json({ error: 'セブン発注書の紐付けが必要です', code: 'SEVEN_PO_REQUIRED' }, 422);
      }
      const [po] = await db.select().from(sevenPurchaseOrders)
        .where(eq(sevenPurchaseOrders.id, order.sevenPurchaseOrderId)).limit(1);
      if (!po) return context.json({ error: 'セブン発注書が見つかりません', code: 'SEVEN_PO_NOT_FOUND' }, 422);
      // Date separation rule: this gate reads official_registered_at only.
      const gate = evaluateSevenPoVerificationGate(po);
      if (!gate.ok) {
        return context.json({ error: gate.message, code: gate.code }, 422);
      }
    }

    // M3: leaving the approval chain for maker ordering requires the derived
    // dual-approval gate to be open right now, not just a status that was set
    // when both approvals existed (T-13). A revocation closes it again.
    if (target === 'MAKER_PO_READY') {
      const approvalContext = await loadApprovalContext(orderId);
      const approvalGate = deriveOrderApprovalGate(approvalContext.revisions, approvalContext.events);
      if (!approvalGate.dualApproved) {
        return context.json({
          error: '全デザインの両組織承認が必要です',
          code: 'DUAL_APPROVAL_REQUIRED',
          missingApprovals: approvalGate.missingApprovals
        }, 422);
      }
    }

    const now = new Date();
    const updated = { status: target, updatedAt: now };
    await db.transaction(async (tx) => {
      await tx.update(filmSupplyOrders).set(updated).where(eq(filmSupplyOrders.id, orderId));
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
        entityType: 'film_supply_order',
        entityId: orderId,
        beforeState: { status: order.status },
        afterState: { status: target },
        occurredAt: now,
        requestMetadata: { operation: 'film_order:transition' }
      });
    });
    return context.json({ ...order, ...updated });
  });

  // ------------------------------------------------ M1: filling orders (design
  // section 5). Units are filling vocabulary only.
  app.post('/api/projects/:projectId/filling-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    const decision = canPerform(toActor(user), 'filling_order:create', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.code !== 'string' || body.code.length === 0) {
      return context.json({ error: '発注コードが必要です', code: 'ORDER_CODE_REQUIRED' }, 422);
    }
    const rawLines = Array.isArray(body?.lines) ? body.lines : [];
    const lines: OrderLineInput[] = [];
    for (const rawLine of rawLines) {
      const lineCheck = validateOrderLineInput('filling', rawLine);
      if (!lineCheck.ok) return context.json({ error: lineCheck.message, code: lineCheck.code }, 422);
      lines.push(lineCheck.line);
    }

    const now = new Date();
    const orderId = uuidv7(now);
    const order = {
      id: orderId,
      projectId,
      code: body.code,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    await db.transaction(async (tx) => {
      await tx.insert(fillingOrders).values(order);
      if (lines.length > 0) {
        await tx.insert(fillingOrderLines).values(lines.map((line) => ({
          id: uuidv7(now),
          fillingOrderId: orderId,
          lineNumber: line.lineNumber,
          description: line.description,
          orderedQuantity: line.orderedQuantity,
          unit: line.unit
        })));
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILLING_ORDER_CREATED',
        entityType: 'filling_order',
        entityId: orderId,
        afterState: { ...order, lineCount: lines.length },
        occurredAt: now,
        requestMetadata: { operation: 'filling_order:create' }
      });
    });

    const createdLines = await db.select().from(fillingOrderLines)
      .where(eq(fillingOrderLines.fillingOrderId, orderId));
    return context.json({ ...order, lines: createdLines }, 201);
  });

  app.post('/api/filling-orders/:orderId/lines', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(fillingOrders).where(eq(fillingOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: '充填発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'filling_order_line:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const lineCheck = validateOrderLineInput('filling', body);
    if (!lineCheck.ok) return context.json({ error: lineCheck.message, code: lineCheck.code }, 422);

    const now = new Date();
    const lineId = uuidv7(now);
    const line = {
      id: lineId,
      fillingOrderId: orderId,
      lineNumber: lineCheck.line.lineNumber,
      description: lineCheck.line.description,
      orderedQuantity: lineCheck.line.orderedQuantity,
      unit: lineCheck.line.unit
    };
    await db.transaction(async (tx) => {
      await tx.insert(fillingOrderLines).values(line);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILLING_ORDER_LINE_CREATED',
        entityType: 'filling_order_line',
        entityId: lineId,
        afterState: line,
        occurredAt: now,
        requestMetadata: { operation: 'filling_order_line:create', fillingOrderId: orderId }
      });
    });
    return context.json(line, 201);
  });

  app.post('/api/filling-orders/:orderId/deliveries', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(fillingOrders).where(eq(fillingOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: '充填発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'filling_delivery:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const unitCheck = validateUnit(body?.unit, 'filling');
    if (!unitCheck.ok) return context.json({ error: unitCheck.message, code: unitCheck.code }, 422);
    const quantityCheck = validateQuantity(body?.deliveredQuantity);
    if (!quantityCheck.ok) return context.json({ error: quantityCheck.message, code: quantityCheck.code }, 422);
    if (typeof body?.fillingOrderLineId !== 'string' || body.fillingOrderLineId.length === 0) {
      return context.json({ error: '明細IDが必要です', code: 'FILLING_ORDER_LINE_REQUIRED' }, 422);
    }
    const deliveredAt = parseOptionalDate(body?.deliveredAt);
    if (!deliveredAt.ok) return context.json({ error: '納期日が不正です', code: 'INVALID_DATE' }, 422);
    if (body?.deliverySequence !== undefined
      && (typeof body.deliverySequence !== 'number' || !Number.isInteger(body.deliverySequence) || body.deliverySequence <= 0)) {
      return context.json({ error: '納品連番は正の整数です', code: 'INVALID_DELIVERY_SEQUENCE' }, 422);
    }

    const [line] = await db.select().from(fillingOrderLines)
      .where(and(
        eq(fillingOrderLines.id, body.fillingOrderLineId),
        eq(fillingOrderLines.fillingOrderId, orderId)
      )).limit(1);
    if (!line) return context.json({ error: '明細が見つかりません', code: 'FILLING_ORDER_LINE_NOT_FOUND' }, 422);

    const [existing] = await db.select({ maxSequence: sql<number>`coalesce(max(${fillingDeliveries.deliverySequence}), 0)` })
      .from(fillingDeliveries)
      .where(eq(fillingDeliveries.fillingOrderLineId, line.id));
    const sequence = body?.deliverySequence ?? (existing?.maxSequence ?? 0) + 1;
    if (body?.deliverySequence !== undefined) {
      const [clash] = await db.select({ id: fillingDeliveries.id })
        .from(fillingDeliveries)
        .where(and(
          eq(fillingDeliveries.fillingOrderLineId, line.id),
          eq(fillingDeliveries.deliverySequence, sequence)
        )).limit(1);
      if (clash) {
        return context.json({ error: '納品連番が重複しています', code: 'DELIVERY_SEQUENCE_EXISTS' }, 422);
      }
    }

    const now = new Date();
    const deliveryId = uuidv7(now);
    const delivery = {
      id: deliveryId,
      fillingOrderId: orderId,
      fillingOrderLineId: line.id,
      unit: unitCheck.unit,
      deliveredQuantity: toQuantityString(quantityCheck.quantity),
      deliverySequence: sequence,
      deliveredAt: deliveredAt.date ?? now,
      carrierReference: optionalText(body?.carrierReference),
      note: optionalText(body?.note),
      createdAt: now
    };

    await db.transaction(async (tx) => {
      await tx.insert(fillingDeliveries).values(delivery);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILLING_DELIVERY_RECORDED',
        entityType: 'filling_delivery',
        entityId: deliveryId,
        afterState: delivery,
        occurredAt: now,
        requestMetadata: { operation: 'filling_delivery:create', fillingOrderId: orderId }
      });
    });

    const [created] = await db.select().from(fillingDeliveries).where(eq(fillingDeliveries.id, deliveryId)).limit(1);
    return context.json(created ?? delivery, 201);
  });

  // Commission readiness is written only here, never as a side effect of a
  // delivery (T-14).
  app.post('/api/projects/:projectId/commission-readiness', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    const decision = canPerform(toActor(user), 'commission_readiness:evaluate', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);

    const now = new Date();

    // Each evaluation carries its observations forward instead of re-deriving
    // them from scratch: the stored row is the project's evaluation record, and
    // the evidence window opens at the previous evaluation's evaluatedAt (at the
    // first evaluation it opens now, so deliveries recorded before evaluation
    // began are never claimed by this project). A delivery recorded inside the
    // window sets its own flag, and a recorded flag never regresses.
    const [previousReadiness] = await db.select()
      .from(commissionReadiness)
      .where(eq(commissionReadiness.projectId, projectId))
      .limit(1);
    const evidenceAnchor = previousReadiness?.evaluatedAt ?? now;

    const [filmDeliveryRow] = await db.select({ id: filmDeliveries.id })
      .from(filmDeliveries)
      .where(gt(filmDeliveries.createdAt, evidenceAnchor))
      .limit(1);
    const [fillingDeliveryRow] = await db.select({ id: fillingDeliveries.id })
      .from(fillingDeliveries)
      .where(gt(fillingDeliveries.createdAt, evidenceAnchor))
      .limit(1);
    const [registeredPo] = await db.select({ id: sevenPurchaseOrders.id })
      .from(sevenPurchaseOrders)
      .where(and(eq(sevenPurchaseOrders.projectId, projectId), isNotNull(sevenPurchaseOrders.officialRegisteredAt)))
      .limit(1);

    const filmDeliveryRecorded = previousReadiness?.filmDeliveryRecorded || filmDeliveryRow !== undefined;
    const fillingDeliveryRecorded = previousReadiness?.fillingDeliveryRecorded || fillingDeliveryRow !== undefined;
    const sevenPoOfficiallyRegistered = registeredPo !== undefined;
    const isReady = filmDeliveryRecorded && fillingDeliveryRecorded && sevenPoOfficiallyRegistered;
    const readinessId = uuidv7(now);
    const readiness = {
      filmDeliveryRecorded,
      fillingDeliveryRecorded,
      sevenPoOfficiallyRegistered,
      isReady,
      readyAt: isReady ? now : null,
      evaluatedAt: now,
      evaluatedByUserId: user.id,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.insert(commissionReadiness)
        .values({ id: readinessId, projectId, ...readiness })
        .onConflictDoUpdate({ target: commissionReadiness.projectId, set: readiness });
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'COMMISSION_READINESS_EVALUATED',
        entityType: 'commission_readiness',
        entityId: projectId,
        afterState: { projectId, ...readiness },
        occurredAt: now,
        requestMetadata: { operation: 'commission_readiness:evaluate' }
      });
    });

    const [row] = await db.select().from(commissionReadiness).where(eq(commissionReadiness.projectId, projectId)).limit(1);
    return context.json(row ?? { id: readinessId, projectId, ...readiness }, 201);
  });

  // ------------------------------------------------- M2: document intake (design
  // section 5.4). The server computes the digest, generates the storage path and
  // records size/type check results; the client filename is display metadata.
  interface DocumentUploadInput {
    documentType: DocumentType;
    issuerEntity: IssuerEntity;
    filename: string;
    contentType: unknown;
    bytes: Buffer;
    note: string | null;
    preOrderReferenceId: string | null;
    sevenPurchaseOrderId: string | null;
    filmSupplyOrderId: string | null;
    designKey: string | null;
    originalReceivedAt: Date | null;
  }

  type UploadPayloadResult =
    | { ok: true; input: DocumentUploadInput }
    | { ok: false; code: string; message: string };

  async function readDocumentUpload(context: any): Promise<UploadPayloadResult> {
    const contentTypeHeader = context.req.header('content-type') ?? '';
    let raw: Record<string, unknown>;
    let bytes: Buffer;
    let filename: unknown;

    if (contentTypeHeader.includes('multipart/form-data')) {
      const body = await context.req.parseBody().catch(() => null) as Record<string, unknown> | null;
      if (!body) return { ok: false, code: 'INVALID_UPLOAD_PAYLOAD', message: 'multipart payload could not be read' };
      const file = body.file;
      if (!(file instanceof File)) {
        return { ok: false, code: 'DOCUMENT_FILE_REQUIRED', message: 'a file part named "file" is required' };
      }
      bytes = Buffer.from(await file.arrayBuffer());
      filename = typeof body.filename === 'string' && body.filename.length > 0 ? body.filename : file.name;
      raw = body;
    } else {
      const body = await context.req.json().catch(() => null) as any;
      if (!body) return { ok: false, code: 'INVALID_UPLOAD_PAYLOAD', message: 'request body must be JSON or multipart' };
      if (typeof body?.contentBase64 !== 'string') {
        return { ok: false, code: 'DOCUMENT_CONTENT_REQUIRED', message: 'contentBase64 is required' };
      }
      bytes = Buffer.from(body.contentBase64, 'base64');
      filename = body?.filename;
      raw = body;
    }

    if (typeof filename !== 'string' || filename.length === 0) {
      return { ok: false, code: 'DOCUMENT_FILENAME_REQUIRED', message: 'filename is required (display metadata only)' };
    }
    const typeCheck = validateDocumentType(raw.documentType);
    if (!typeCheck.ok) return { ok: false, code: typeCheck.code, message: typeCheck.message };
    const issuerCheck = validateIssuerEntity(raw.issuerEntity);
    if (!issuerCheck.ok) return { ok: false, code: issuerCheck.code, message: issuerCheck.message };

    const contentType = raw.contentType ?? (raw.file instanceof File ? raw.file.type : undefined);
    const receivedAt = parseOptionalDate(raw.originalReceivedAt);
    if (!receivedAt.ok) return { ok: false, code: 'INVALID_DATE', message: '原本受領日が不正です' };

    return {
      ok: true,
      input: {
        documentType: typeCheck.documentType,
        issuerEntity: issuerCheck.issuerEntity,
        filename,
        contentType,
        bytes,
        note: optionalText(raw.note),
        preOrderReferenceId: typeof raw.preOrderReferenceId === 'string' ? raw.preOrderReferenceId : null,
        sevenPurchaseOrderId: typeof raw.sevenPurchaseOrderId === 'string' ? raw.sevenPurchaseOrderId : null,
        filmSupplyOrderId: typeof raw.filmSupplyOrderId === 'string' && raw.filmSupplyOrderId.length > 0
          ? raw.filmSupplyOrderId
          : null,
        designKey: optionalText(raw.designKey),
        originalReceivedAt: receivedAt.date
      }
    };
  }

  app.post('/api/projects/:projectId/documents', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    const decision = canPerform(toActor(user), 'document:create', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);

    const payload = await readDocumentUpload(context);
    if (!payload.ok) return context.json({ error: payload.message, code: payload.code }, 422);
    const input = payload.input;

    // Size and type checks run before anything is persisted, so a rejected
    // upload leaves no rows and no file.
    const contentCheck: DocumentContentCheck = evaluateDocumentContent(input.bytes, input.contentType);
    if (!contentCheck.ok) return context.json({ error: contentCheck.message, code: contentCheck.code }, 422);

    // M3 artwork binding: a document may declare which film supply order and
    // design it belongs to. Approval evidence must carry this binding (T-35),
    // so it is validated once at intake and trusted everywhere else.
    let artworkBindingOrderId: string | null = null;
    if (input.filmSupplyOrderId) {
      const [boundOrder] = await db.select().from(filmSupplyOrders)
        .where(eq(filmSupplyOrders.id, input.filmSupplyOrderId)).limit(1);
      if (!boundOrder || boundOrder.deletedAt || boundOrder.projectId !== projectId) {
        return context.json({
          error: '紐付け対象のフィルム発注がこの案件に見つかりません',
          code: 'FILM_SUPPLY_ORDER_PROJECT_MISMATCH'
        }, 422);
      }
      if (!input.designKey) {
        return context.json({ error: '発注に紐付ける場合はデザインキーが必要です', code: 'DESIGN_KEY_REQUIRED' }, 422);
      }
      artworkBindingOrderId = boundOrder.id;
    }

    // A logical document is (project, type, issuer, filename). Re-uploading the
    // same bytes to it resolves to the existing version and writes nothing (T-27).
    const [existingDocument] = await db.select().from(documents).where(and(
      eq(documents.projectId, projectId),
      eq(documents.documentType, input.documentType),
      eq(documents.issuerEntity, input.issuerEntity),
      eq(documents.originalFilename, input.filename)
    )).limit(1);
    if (existingDocument) {
      const bindingConflict = (existingDocument.filmSupplyOrderId ?? null) !== artworkBindingOrderId
        || (existingDocument.designKey ?? null) !== input.designKey;
      if (bindingConflict) {
        return context.json({ error: '既存の書類は別のアートワーク紐付けを持っています', code: 'DOCUMENT_BINDING_CONFLICT' }, 422);
      }
      const [existingVersion] = await db.select().from(documentVersions).where(and(
        eq(documentVersions.documentId, existingDocument.id),
        eq(documentVersions.sha256, contentCheck.sha256)
      )).limit(1);
      if (existingVersion) {
        return context.json({ document: existingDocument, version: existingVersion, idempotent: true }, 200);
      }
    }

    // Precedence gate (T-04, T-05): official artifacts are downstream of a
    // purchase order that is officially registered AND checklist-verified.
    let linkedPo: typeof sevenPurchaseOrders.$inferSelect | null = null;
    if (input.sevenPurchaseOrderId) {
      const [po] = await db.select().from(sevenPurchaseOrders)
        .where(eq(sevenPurchaseOrders.id, input.sevenPurchaseOrderId)).limit(1);
      if (!po || po.projectId !== projectId) {
        return context.json({ error: 'セブン発注書がこの案件に見つかりません', code: 'SEVEN_PO_PROJECT_MISMATCH' }, 422);
      }
      linkedPo = po;
    }
    if (isOfficialArtifactDocumentType(input.documentType)) {
      if (!linkedPo) {
        return context.json({ error: '検証済みのセブン発注書の紐付けが必要です', code: 'SEVEN_PO_REQUIRED' }, 422);
      }
      const gate = evaluateSevenPoPrecedenceGate(linkedPo);
      if (!gate.ok) return context.json({ error: gate.message, code: gate.code }, 422);
    }

    // Pre-order reference flow: a PO document arriving before a verified PO
    // becomes an append-only pre_order_references row.
    let preOrderReferenceId: string | null = null;
    let newReference: typeof preOrderReferences.$inferInsert | null = null;
    if (input.documentType === 'seven_po') {
      if (input.preOrderReferenceId) {
        const [reference] = await db.select().from(preOrderReferences).where(and(
          eq(preOrderReferences.id, input.preOrderReferenceId),
          eq(preOrderReferences.projectId, projectId)
        )).limit(1);
        if (!reference) {
          return context.json({ error: '先行発注参照が見つかりません', code: 'PRE_ORDER_REFERENCE_NOT_FOUND' }, 422);
        }
        preOrderReferenceId = reference.id;
      } else {
        const now = new Date();
        const referenceId = uuidv7(now);
        newReference = {
          id: referenceId,
          projectId,
          referenceCode: `PRE-${now.getTime().toString(36).toUpperCase()}-${randomHex(4)}`,
          note: input.note ?? `先行発注参照（${input.filename}）`,
          originalReceivedAt: input.originalReceivedAt ?? now,
          createdByUserId: user.id,
          createdAt: now,
          updatedAt: now
        };
        preOrderReferenceId = referenceId;
      }
    }

    // Identical bytes always keep referencing the same physical file (T-26).
    const storageRoot = documentStorageRoot();
    const [sharedVersion] = await db.select({ storagePath: documentVersions.storagePath })
      .from(documentVersions)
      .where(eq(documentVersions.sha256, contentCheck.sha256))
      .orderBy(desc(documentVersions.createdAt))
      .limit(1);
    const storagePath = await resolveStoragePath(storageRoot, contentCheck.sha256, input.bytes, sharedVersion?.storagePath);

    const now = new Date();
    const documentId = existingDocument?.id ?? uuidv7(now);
    let versionNumber = 1;
    if (existingDocument) {
      const [maxRow] = await db.select({ maxVersion: sql<number>`coalesce(max(${documentVersions.versionNumber}), 0)` })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, existingDocument.id));
      versionNumber = (maxRow?.maxVersion ?? 0) + 1;
    }
    const newDocument: typeof documents.$inferInsert | null = existingDocument ? null : {
      id: documentId,
      projectId,
      documentType: input.documentType,
      issuerEntity: input.issuerEntity,
      originalFilename: input.filename,
      note: input.note,
      preOrderReferenceId,
      sevenPurchaseOrderId: linkedPo?.id ?? null,
      filmSupplyOrderId: artworkBindingOrderId,
      designKey: artworkBindingOrderId ? input.designKey : null,
      verificationStatus: 'unverified',
      verifiedByUserId: null,
      verifiedAt: null,
      verificationNote: null,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now
    };
    const versionRow = {
      id: uuidv7(now),
      documentId,
      versionNumber,
      sha256: contentCheck.sha256,
      byteSize: contentCheck.byteSize,
      storagePath,
      originalFilename: input.filename,
      declaredMimeType: contentCheck.declaredMimeType,
      detectedMimeType: contentCheck.detectedMimeType,
      sizeCheckPassed: contentCheck.sizeCheckPassed,
      typeCheckPassed: contentCheck.typeCheckPassed,
      createdByUserId: user.id,
      createdAt: now
    };

    await db.transaction(async (tx) => {
      if (newReference) {
        await tx.insert(preOrderReferences).values(newReference);
        await tx.insert(auditEvents).values({
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'PRE_ORDER_REFERENCE_CREATED',
          entityType: 'pre_order_reference',
          entityId: newReference.id,
          afterState: newReference,
          occurredAt: now,
          requestMetadata: { operation: 'document:create', documentType: input.documentType }
        });
      }
      if (newDocument) {
        await tx.insert(documents).values(newDocument);
        await tx.insert(auditEvents).values({
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'DOCUMENT_CREATED',
          entityType: 'document',
          entityId: documentId,
          afterState: newDocument,
          occurredAt: now,
          requestMetadata: { operation: 'document:create' }
        });
      }
      await tx.insert(documentVersions).values(versionRow);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'DOCUMENT_VERSION_UPLOADED',
        entityType: 'document_version',
        entityId: versionRow.id,
        afterState: versionRow,
        occurredAt: now,
        requestMetadata: { operation: 'document:create', documentId }
      });
    });

    return context.json(
      { document: newDocument ?? existingDocument, version: versionRow, idempotent: false },
      newDocument ? 201 : 200
    );
  });

  app.post('/api/documents/:documentId/verify', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const documentId = context.req.param('documentId');

    const [current] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
    if (!current) return context.json({ error: '書類が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'document:verify', 'F1', current.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const status = body?.verificationStatus;
    if (status !== 'verified' && status !== 'mismatch') {
      return context.json({
        error: 'verificationStatus は verified または mismatch です',
        code: 'INVALID_VERIFICATION_STATUS'
      }, 422);
    }

    const now = new Date();
    const updated = {
      verificationStatus: status,
      verifiedByUserId: user.id,
      verifiedAt: now,
      verificationNote: optionalText(body?.verificationNote),
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.update(documents).set(updated).where(eq(documents.id, documentId));
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'DOCUMENT_VERIFICATION_RECORDED',
        entityType: 'document',
        entityId: documentId,
        beforeState: {
          verificationStatus: current.verificationStatus,
          verifiedAt: current.verifiedAt,
          verifiedByUserId: current.verifiedByUserId
        },
        afterState: { ...current, ...updated },
        occurredAt: now,
        requestMetadata: { operation: 'document:verify' }
      });
    });
    return context.json({ ...current, ...updated });
  });

  // --------------------------- M2: seven PO authenticity checklist (design
  // section 5.10). verificationStatus is only ever written here, from a human
  // record of all required items; estimating authenticity from metadata is
  // impossible by construction.
  app.post('/api/seven-purchase-orders/:poId/verification-checklist', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');

    const [current] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    if (!current) return context.json({ error: 'セブン発注書が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'seven_po:verify', 'F1', current.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const evaluation = evaluateSevenPoChecklist(body);
    if (!evaluation.ok) {
      return context.json({
        error: evaluation.message,
        code: evaluation.code,
        missing: evaluation.missing
      }, 422);
    }

    const now = new Date();
    const updated = {
      verificationStatus: evaluation.status,
      verifiedByUserId: user.id,
      verifiedAt: now,
      verificationNote: evaluation.checklist.verificationNote,
      authenticityChecklist: evaluation.checklist,
      reviewPending: evaluation.reviewPending,
      reviewNote: evaluation.reviewPending
        ? evaluation.checklist.quoteComparisonNote ?? '見積と発注書の突合結果に不一致があります'
        : null,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.update(sevenPurchaseOrders).set(updated).where(eq(sevenPurchaseOrders.id, poId));
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'SEVEN_PO_VERIFICATION_RECORDED',
        entityType: 'seven_purchase_order',
        entityId: poId,
        beforeState: {
          verificationStatus: current.verificationStatus,
          verifiedAt: current.verifiedAt,
          verifiedByUserId: current.verifiedByUserId,
          reviewPending: current.reviewPending
        },
        afterState: { ...current, ...updated },
        occurredAt: now,
        requestMetadata: { operation: 'seven_po:verify' }
      });
    });
    return context.json({ ...current, ...updated });
  });

  // Official registration of a pre-order reference: stamps official_registered_at
  // together with promoted_at/promoted_by, but only once the linked seven
  // purchase order passed the authenticity checklist.
  app.post('/api/pre-order-references/:preOrderId/promote-official', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const preOrderId = context.req.param('preOrderId');

    const [reference] = await db.select().from(preOrderReferences).where(eq(preOrderReferences.id, preOrderId)).limit(1);
    if (!reference) return context.json({ error: '先行発注参照が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'pre_order:promote', 'F1', reference.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [po] = await db.select().from(sevenPurchaseOrders)
      .where(eq(sevenPurchaseOrders.preOrderReferenceId, reference.id))
      .orderBy(desc(sevenPurchaseOrders.createdAt))
      .limit(1);
    if (!po) {
      return context.json({ error: 'この参照に紐づくセブン発注書がありません', code: 'SEVEN_PO_NOT_LINKED' }, 422);
    }
    if (po.reviewPending) {
      return context.json({ error: '見積と発注書の突合レビューが未解決です', code: 'PO_REVIEW_PENDING' }, 422);
    }
    if (po.verificationStatus !== 'verified') {
      return context.json({ error: 'セブン発注書の真正性確認が完了していません', code: 'SEVEN_PO_NOT_VERIFIED' }, 422);
    }

    const body = await context.req.json().catch(() => null) as any;
    const registeredAt = parseOptionalDate(body?.officialRegisteredAt);
    if (!registeredAt.ok) return context.json({ error: '公式登録日が不正です', code: 'INVALID_DATE' }, 422);

    const now = new Date();
    const updated = {
      officialRegisteredAt: registeredAt.date ?? now,
      promotedAt: now,
      promotedByUserId: user.id,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.update(sevenPurchaseOrders).set(updated).where(eq(sevenPurchaseOrders.id, po.id));
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'PRE_ORDER_PROMOTED_OFFICIAL',
        entityType: 'seven_purchase_order',
        entityId: po.id,
        beforeState: {
          officialRegisteredAt: po.officialRegisteredAt,
          promotedAt: po.promotedAt,
          promotedByUserId: po.promotedByUserId
        },
        afterState: { ...po, ...updated },
        occurredAt: now,
        requestMetadata: { operation: 'pre_order:promote_official', preOrderReferenceId: reference.id }
      });
    });
    return context.json({ ...po, ...updated });
  });

  // Supply-order registration against a seven purchase order (T-04, T-05):
  // the precedence gate is evaluated before anything is written.
  app.post('/api/seven-purchase-orders/:poId/supply-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');

    const [po] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    if (!po) return context.json({ error: 'セブン発注書が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'supply_order:create', 'F1', po.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const gate = evaluateSevenPoPrecedenceGate(po);
    if (!gate.ok) return context.json({ error: gate.message, code: gate.code }, 422);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.code !== 'string' || body.code.length === 0) {
      return context.json({ error: '発注コードが必要です', code: 'ORDER_CODE_REQUIRED' }, 422);
    }
    const rawLines = Array.isArray(body?.lines) ? body.lines : [];
    const lines: OrderLineInput[] = [];
    for (const rawLine of rawLines) {
      const lineCheck = validateOrderLineInput('film', rawLine);
      if (!lineCheck.ok) return context.json({ error: lineCheck.message, code: lineCheck.code }, 422);
      lines.push(lineCheck.line);
    }

    const now = new Date();
    const orderId = uuidv7(now);
    const order = {
      id: orderId,
      projectId: po.projectId,
      code: body.code,
      status: 'DRAFT' as const,
      sevenPurchaseOrderId: po.id,
      holdReason: null,
      exceptionNote: null,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    await db.transaction(async (tx) => {
      await tx.insert(filmSupplyOrders).values(order);
      if (lines.length > 0) {
        await tx.insert(filmSupplyOrderLines).values(lines.map((line) => ({
          id: uuidv7(now),
          filmSupplyOrderId: orderId,
          lineNumber: line.lineNumber,
          description: line.description,
          orderedQuantity: line.orderedQuantity,
          unit: line.unit
        })));
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILM_SUPPLY_ORDER_CREATED',
        entityType: 'film_supply_order',
        entityId: orderId,
        afterState: { ...order, lineCount: lines.length, registeredFromSevenPoId: po.id },
        occurredAt: now,
        requestMetadata: { operation: 'supply_order:create', sevenPurchaseOrderId: po.id }
      });
    });

    const createdLines = await db.select().from(filmSupplyOrderLines)
      .where(eq(filmSupplyOrderLines.filmSupplyOrderId, orderId));
    return context.json({ ...order, lines: createdLines }, 201);
  });

  // --------------------------- M3: proof revisions and dual approval (design
  // sections 5.7 and 6.1). Approvals are external facts recorded by an internal
  // user; the dual-approval gate is derived from the append-only event log and
  // is never stored on the order.
  async function loadApprovalContext(orderId: string): Promise<{
    revisions: ArtworkRevisionView[];
    events: ApprovalEventView[];
  }> {
    const revisionRows = await db.select({
      id: artworkRevisions.id,
      filmSupplyOrderId: artworkRevisions.filmSupplyOrderId,
      designKey: artworkRevisions.designKey,
      revisionNo: artworkRevisions.revisionNo,
      fileSha256: documentVersions.sha256,
      lotMarking: artworkRevisions.lotMarking
    }).from(artworkRevisions)
      .innerJoin(documentVersions, eq(documentVersions.id, artworkRevisions.fileDocumentVersionId))
      .where(eq(artworkRevisions.filmSupplyOrderId, orderId));

    const revisionIds = revisionRows.map((row) => row.id);
    const eventRows = revisionIds.length === 0
      ? [] as ApprovalEventView[]
      : await db.select({
        id: artworkApprovalEvents.id,
        artworkRevisionId: artworkApprovalEvents.artworkRevisionId,
        organization: artworkApprovalEvents.organization,
        decision: artworkApprovalEvents.decision,
        approvedFileSha256: artworkApprovalEvents.approvedFileSha256,
        recordedAt: artworkApprovalEvents.recordedAt,
        eventTime: artworkApprovalEvents.eventTime,
        supersedesEventId: artworkApprovalEvents.supersedesEventId
      }).from(artworkApprovalEvents)
        .where(inArray(artworkApprovalEvents.artworkRevisionId, revisionIds));

    return { revisions: revisionRows, events: eventRows };
  }

  app.post('/api/film-supply-orders/:orderId/artwork-revisions', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'artwork_revision:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    // Artwork only exists downstream of a verified purchase order.
    const registrationGate = evaluateRevisionRegistrationGate(order.status);
    if (!registrationGate.ok) return context.json({ error: registrationGate.message, code: registrationGate.code }, 422);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.designKey !== 'string' || body.designKey.trim().length === 0) {
      return context.json({ error: 'デザインキーが必要です', code: 'DESIGN_KEY_REQUIRED' }, 422);
    }
    const designKey = body.designKey.trim();
    if (typeof body?.fileDocumentVersionId !== 'string' || body.fileDocumentVersionId.length === 0) {
      return context.json({ error: '版ファイルの指定が必要です', code: 'FILE_DOCUMENT_VERSION_REQUIRED' }, 422);
    }
    if (body?.revisionNo !== undefined
      && (typeof body.revisionNo !== 'number' || !Number.isInteger(body.revisionNo) || body.revisionNo <= 0)) {
      return context.json({ error: '版番号は正の整数です', code: 'INVALID_REVISION_NUMBER' }, 422);
    }

    const [fileVersion] = await db.select({
      versionId: documentVersions.id,
      sha256: documentVersions.sha256,
      projectId: documents.projectId,
      documentType: documents.documentType,
      boundOrderId: documents.filmSupplyOrderId,
      boundDesignKey: documents.designKey
    }).from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, body.fileDocumentVersionId)).limit(1);
    if (!fileVersion || fileVersion.projectId !== order.projectId) {
      return context.json({ error: '版ファイルがこの案件に見つかりません', code: 'FILE_DOCUMENT_PROJECT_MISMATCH' }, 422);
    }
    if (fileVersion.documentType !== 'proof') {
      return context.json({ error: '版ファイルは proof 書類である必要があります', code: 'FILE_DOCUMENT_TYPE_INVALID' }, 422);
    }
    if (fileVersion.boundOrderId !== null && fileVersion.boundOrderId !== orderId) {
      return context.json({ error: '版ファイルは別の発注に紐付いています', code: 'FILE_DOCUMENT_ORDER_MISMATCH' }, 422);
    }
    if (fileVersion.boundDesignKey !== null && fileVersion.boundDesignKey !== designKey) {
      return context.json({ error: '版ファイルは別のデザインに紐付いています', code: 'FILE_DOCUMENT_DESIGN_MISMATCH' }, 422);
    }

    const [maxRow] = await db.select({ maxRevision: sql<number>`coalesce(max(${artworkRevisions.revisionNo}), 0)` })
      .from(artworkRevisions)
      .where(and(eq(artworkRevisions.filmSupplyOrderId, orderId), eq(artworkRevisions.designKey, designKey)));
    const revisionNo = body?.revisionNo ?? (maxRow?.maxRevision ?? 0) + 1;
    const [revisionClash] = await db.select({ id: artworkRevisions.id }).from(artworkRevisions)
      .where(and(
        eq(artworkRevisions.filmSupplyOrderId, orderId),
        eq(artworkRevisions.designKey, designKey),
        eq(artworkRevisions.revisionNo, revisionNo)
      )).limit(1);
    if (revisionClash) return context.json({ error: '版番号が重複しています', code: 'REVISION_NUMBER_EXISTS' }, 422);

    // A design that already went through approval loses its approvals when a
    // new revision lands: the gate re-opens and the order enters change review
    // (T-11). Approvals stay readable as audit history.
    const approvalContext = await loadApprovalContext(orderId);
    const invalidatedApprovals = hasApprovalHistoryForDesign(approvalContext.revisions, approvalContext.events, designKey);
    const entersChangeReview = invalidatedApprovals
      && order.status !== 'CHANGE_REVIEW'
      && !isExceptionFilmSupplyOrderState(order.status)
      && !isTerminalFilmSupplyOrderState(order.status);
    const statusAfter = entersChangeReview ? 'CHANGE_REVIEW' as const : order.status;

    const now = new Date();
    const revisionId = uuidv7(now);
    const revision = {
      id: revisionId,
      filmSupplyOrderId: orderId,
      designKey,
      revisionNo,
      fileDocumentVersionId: fileVersion.versionId,
      lotMarking: optionalText(body?.lotMarking),
      note: optionalText(body?.note),
      createdByUserId: user.id,
      createdAt: now
    };

    await db.transaction(async (tx) => {
      await tx.insert(artworkRevisions).values(revision);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'ARTWORK_REVISION_REGISTERED',
        entityType: 'artwork_revision',
        entityId: revisionId,
        afterState: { ...revision, invalidatedApprovals },
        occurredAt: now,
        requestMetadata: { operation: 'artwork_revision:create', filmSupplyOrderId: orderId, designKey }
      });
      if (entersChangeReview) {
        await tx.update(filmSupplyOrders).set({ status: statusAfter, updatedAt: now }).where(eq(filmSupplyOrders.id, orderId));
        await tx.insert(auditEvents).values({
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
          entityType: 'film_supply_order',
          entityId: orderId,
          beforeState: { status: order.status },
          afterState: { status: statusAfter },
          occurredAt: now,
          requestMetadata: { operation: 'artwork_revision:create', reason: 'new_revision_invalidates_approvals', designKey }
        });
      }
    });

    return context.json({ ...revision, status: statusAfter, invalidatedApprovals }, 201);
  });

  app.post('/api/artwork-revisions/:revisionId/approvals', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const revisionId = context.req.param('revisionId');

    const [revision] = await db.select({
      id: artworkRevisions.id,
      filmSupplyOrderId: artworkRevisions.filmSupplyOrderId,
      designKey: artworkRevisions.designKey,
      revisionNo: artworkRevisions.revisionNo,
      fileSha256: documentVersions.sha256
    }).from(artworkRevisions)
      .innerJoin(documentVersions, eq(documentVersions.id, artworkRevisions.fileDocumentVersionId))
      .where(eq(artworkRevisions.id, revisionId)).limit(1);
    if (!revision) return context.json({ error: '版が見つかりません' }, 404);

    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, revision.filmSupplyOrderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'artwork_approval:record', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const organizationCheck = validateApprovalOrganization(body?.organization);
    if (!organizationCheck.ok) return context.json({ error: organizationCheck.message, code: organizationCheck.code }, 422);
    const decisionCheck = validateApprovalDecision(body?.decision);
    if (!decisionCheck.ok) return context.json({ error: decisionCheck.message, code: decisionCheck.code }, 422);
    const sourceCheck = validateApprovalEvidenceSource(body?.evidenceSource);
    if (!sourceCheck.ok) return context.json({ error: sourceCheck.message, code: sourceCheck.code }, 422);
    if (typeof body?.evidenceDocumentVersionId !== 'string' || body.evidenceDocumentVersionId.length === 0) {
      return context.json({ error: '承認証跡の書類バージョンが必要です', code: 'EVIDENCE_DOCUMENT_VERSION_REQUIRED' }, 422);
    }
    const eventTime = parseRequiredDate(body?.eventTime);
    if (!eventTime.ok) {
      return context.json({ error: '承認日時（外部イベント時刻）が必要です', code: 'EVENT_TIME_REQUIRED' }, 422);
    }
    const organization: ApprovalOrganization = organizationCheck.value;

    const [evidence] = await db.select({
      versionId: documentVersions.id,
      projectId: documents.projectId,
      documentType: documents.documentType,
      filmSupplyOrderId: documents.filmSupplyOrderId,
      designKey: documents.designKey
    }).from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, body.evidenceDocumentVersionId)).limit(1);
    if (!evidence) {
      return context.json({ error: '承認証跡の書類バージョンが見つかりません', code: 'EVIDENCE_DOCUMENT_VERSION_NOT_FOUND' }, 422);
    }

    // Evidence must belong to exactly this order, this design and this company
    // (T-35): an approval can never rest on another order's paperwork.
    const binding = evaluateApprovalEvidenceBinding({
      evidenceDocument: {
        projectId: evidence.projectId,
        documentType: evidence.documentType,
        filmSupplyOrderId: evidence.filmSupplyOrderId,
        designKey: evidence.designKey
      },
      order: { id: order.id, projectId: order.projectId },
      revision: { designKey: revision.designKey }
    });
    if (!binding.ok) return context.json({ error: binding.message, code: binding.code }, 422);

    const approvalContext = await loadApprovalContext(order.id);
    let supersedesEventId: string | null = null;
    if (typeof body?.supersedesEventId === 'string') {
      const target = approvalContext.events.find((event) =>
        event.id === body.supersedesEventId
        && event.artworkRevisionId === revision.id
        && event.organization === organization
      );
      if (!target) {
        return context.json({ error: '置き換え対象の承認イベントがこの版に見つかりません', code: 'SUPERSEDED_EVENT_MISMATCH' }, 422);
      }
      supersedesEventId = target.id;
    } else {
      // Default linkage: a new event supersedes the organization's latest event
      // on this revision, if one exists.
      const revisionGate = deriveOrderApprovalGate(approvalContext.revisions, approvalContext.events).designs
        .find((design) => design.currentRevisionId === revision.id);
      supersedesEventId = revisionGate?.[organization].latestEventId ?? null;
    }

    const now = new Date();
    const eventId = uuidv7(now);
    const approvalEvent = {
      id: eventId,
      artworkRevisionId: revision.id,
      organization,
      decision: decisionCheck.value,
      externalApproverName: optionalText(body?.externalApproverName),
      externalApproverOrg: optionalText(body?.externalApproverOrg),
      recordedByUserId: user.id,
      evidenceDocumentVersionId: evidence.versionId,
      evidenceSource: sourceCheck.value,
      approvedFileSha256: revision.fileSha256,
      eventTime: eventTime.date,
      recordedAt: now,
      supersedesEventId
    };
    const gateAfter = deriveOrderApprovalGate(
      approvalContext.revisions,
      [...approvalContext.events, approvalEvent]
    );
    const advancesToDualApproved = decisionCheck.value === 'APPROVE'
      && shouldAdvanceToDualApproved(gateAfter, order.status);

    await db.transaction(async (tx) => {
      await tx.insert(artworkApprovalEvents).values(approvalEvent);
      await tx.insert(auditEvents).values({
        id: uuidv7(now),
        actorUserId: user.id,
        action: decisionCheck.value === 'APPROVE' ? 'ARTWORK_APPROVAL_RECORDED' : 'ARTWORK_APPROVAL_REVOKED',
        entityType: 'artwork_approval_event',
        entityId: eventId,
        afterState: { ...approvalEvent, designKey: revision.designKey, revisionNo: revision.revisionNo },
        occurredAt: now,
        requestMetadata: { operation: 'artwork_approval:record', filmSupplyOrderId: order.id }
      });
      if (advancesToDualApproved) {
        await tx.update(filmSupplyOrders)
          .set({ status: 'DUAL_APPROVED', updatedAt: now })
          .where(eq(filmSupplyOrders.id, order.id));
        await tx.insert(auditEvents).values({
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
          entityType: 'film_supply_order',
          entityId: order.id,
          beforeState: { status: order.status },
          afterState: { status: 'DUAL_APPROVED' },
          occurredAt: now,
          requestMetadata: { operation: 'artwork_approval:record', reason: 'dual_approval_reached' }
        });
      }
    });

    return context.json({
      approvalEvent,
      orderStatus: advancesToDualApproved ? 'DUAL_APPROVED' : order.status,
      dualApproved: gateAfter.dualApproved,
      missingApprovals: gateAfter.missingApprovals
    }, 201);
  });

  app.get('/api/film-supply-orders/:orderId/approval-gate', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'artwork_approval:read', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const approvalContext = await loadApprovalContext(orderId);
    const gate = deriveOrderApprovalGate(approvalContext.revisions, approvalContext.events);
    return context.json({
      orderId,
      orderStatus: order.status,
      dualApproved: gate.dualApproved,
      requiredDesignKeys: gate.requiredDesignKeys,
      missingApprovals: gate.missingApprovals,
      designs: gate.designs
    });
  });

  return app;
}

/**
 * Reuses the physical file that already holds these bytes when it is present
 * (T-26); otherwise writes them once under a fresh random path.
 */
async function resolveStoragePath(
  storageRoot: string,
  sha256: string,
  bytes: Buffer,
  knownPath?: string
): Promise<string> {
  if (knownPath) {
    try {
      await stat(knownPath);
      return knownPath;
    } catch {
      // The physical file is gone (e.g. storage wiped while the DB survived):
      // fall through and store the bytes again under a new random path.
    }
  }
  const stored = await writeStoredFile(storageRoot, sha256, bytes);
  return stored.storagePath;
}

function randomHex(length: number): string {
  return Array.from(randomBytes(Math.ceil(length / 2)), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
    .toUpperCase();
}
