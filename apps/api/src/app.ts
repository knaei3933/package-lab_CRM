import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  canPerform,
  evaluateSevenPoVerificationGate,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  toQuantityString,
  transitionFilmSupplyOrder,
  validateProjectRoute,
  validateQuantity,
  validateUnit,
  type FilmSupplyOrderState,
  type MeasureUnit,
  type UnitDomain
} from '@kanei/core';
import {
  accounts,
  auditEvents,
  commissionReadiness,
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

  return app;
}
