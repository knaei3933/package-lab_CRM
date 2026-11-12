import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  buildMakerPoSnapshot,
  canPerform,
  computeMakerPoSnapshotSha256,
  deriveOrderApprovalGate,
  evaluateApprovalEvidenceBinding,
  evaluateCommissionReadiness,
  evaluateDeliveryEvidence,
  evaluateFilmReceiptAssumption,
  evaluateMakerPoAcceptEvidence,
  evaluateMakerPoApproval,
  evaluateMakerPoCreationGate,
  evaluateMakerPoSendEvidence,
  evaluateMakerPoSendTransition,
  evaluateRevisionRegistrationGate,
  evaluateSevenPoChecklist,
  evaluateSevenPoPrecedenceGate,
  evaluateSevenPoVerificationGate,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  fillingDeliveryConfirmationState,
  hasApprovalHistoryForDesign,
  isArtworkBoundDocumentType,
  isCommissionCalculationAllowed,
  isExceptionFilmSupplyOrderState,
  isOfficialArtifactDocumentType,
  isTerminalFilmSupplyOrderState,
  japaneseStatusSurface,
  shouldAdvanceToDualApproved,
  toQuantityString,
  transitionFilmSupplyOrder,
  transitionMakerPurchaseOrder,
  validateApprovalDecision,
  validateApprovalEvidenceSource,
  validateApprovalOrganization,
  validateDocumentType,
  validateIssuerEntity,
  validateMakerPoStatus,
  validateProjectRoute,
  validateQuantity,
  validateUnit,
  type ApprovalEventView,
  type ApprovalOrganization,
  type ArtworkRevisionView,
  type DocumentType,
  type FilmSupplyOrderState,
  type IssuerEntity,
  type MakerPoEvidenceDocument,
  type MakerPoSnapshot,
  type MakerPoSnapshotArtworkFile,
  type MeasureUnit,
  type UnitDomain
} from '@kanei/core';
import {
  accounts,
  artworkApprovalEvents,
  artworkRevisions,
  auditEvents,
  commissionReadiness,
  deliveryConfirmations,
  documentVersions,
  documents,
  filmDeliveries,
  filmSupplyOrderLines,
  filmSupplyOrders,
  fillingDeliveries,
  fillingOrderLines,
  fillingOrders,
  makerPoEvents,
  makerPurchaseOrders,
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

/** Database executor that can read: the pool or one open transaction. */
type MakerPoQueryExecutor = Pick<AppDatabase, 'select'>;

/** Database executor that can write audit rows: the pool or one open transaction. */
type AuditEventWriter = Pick<AppDatabase, 'insert'>;

/**
 * One audit_events row: what happened, to which entity, and in which project.
 * The project is not derivable from the entity at read time without one EXISTS
 * per audited entity family, so the caller — which already holds the project it
 * is acting on — states it here and the row carries it (migration 0013).
 */
interface AuditEventInput {
  projectId: string;
  id?: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
  occurredAt: Date;
  requestMetadata?: unknown;
}

function auditEventRow(input: AuditEventInput) {
  return {
    id: input.id ?? uuidv7(input.occurredAt),
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeState: input.beforeState ?? null,
    afterState: input.afterState ?? null,
    occurredAt: input.occurredAt,
    requestMetadata: input.requestMetadata ?? null
  };
}

/** Appends one audit_events row, always stamped with the project it belongs to. */
async function recordAuditEvent(writer: AuditEventWriter, input: AuditEventInput): Promise<void> {
  await writer.insert(auditEvents).values(auditEventRow(input));
}

/**
 * A maker PO transition lost its row-level race (T-25): another transaction
 * moved the PO between the read and the conditional update. The transaction is
 * rolled back and the caller receives 422 MAKER_PO_STATE_CHANGED, so exactly
 * one of two simultaneous transition requests is ever effective.
 */
class MakerPoStateConflict extends Error {}

/**
 * A receipt assumption lost its row-level race: the order moved away from
 * FILM_DELIVERED between the read and the conditional update. The transaction
 * is rolled back and the caller receives 422
 * RECEIPT_ASSUMPTION_STATE_CHANGED, so the assumption is recorded exactly once
 * and only from FILM_DELIVERED.
 */
class ReceiptAssumptionStateConflict extends Error {}

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
      await recordAuditEvent(tx, {
        projectId,
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
      await recordAuditEvent(tx, {
        projectId,
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
      await recordAuditEvent(tx, {
        projectId,
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
      await recordAuditEvent(tx, {
        projectId: current.projectId,
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
      await recordAuditEvent(tx, {
        projectId,
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
      await recordAuditEvent(tx, {
        projectId: reference.projectId,
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
      await recordAuditEvent(tx, {
        projectId,
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
      await recordAuditEvent(tx, {
        projectId: order.projectId,
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
      await recordAuditEvent(tx, {
        projectId: order.projectId,
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

    // M5: assuming a receipt without issue is never a generic transition. It is
    // a manual recording action with a required note and an evidence-free
    // acknowledgment, recorded by its own endpoint so nothing here can move an
    // order into the terminal state implicitly (design sections 5.5 and 13
    // item 1).
    if (target === 'FILM_RECEIPT_ASSUMED_NO_ISSUE') {
      return context.json({
        error: '受領確認（問題なしとみなす）は専用の記録操作でのみ行えます',
        code: 'RECEIPT_ASSUMPTION_ACTION_REQUIRED'
      }, 422);
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
      await recordAuditEvent(tx, {
        projectId: order.projectId,
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

  // --------------------------- M5: film receipt assumption and delivery
  // confirmation (design sections 5.5, 6.1, 6.4 and 13 item 1).
  //
  // FILM_DELIVERED → FILM_RECEIPT_ASSUMED_NO_ISSUE is a MANUAL recording
  // action: the waiting period is not decided by the CEO yet, so nothing in
  // the system schedules, times or derives it. An admin or staff member
  // records it with a required note and an explicit evidence-free
  // acknowledgment, and the audit row is written in the same transaction.
  app.post('/api/film-supply-orders/:orderId/receipt-assumption', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order:assume_receipt', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const assumedAtInput = parseOptionalDate(body?.assumedAt);
    if (!assumedAtInput.ok) {
      return context.json({ error: '受領確認日が不正です', code: 'INVALID_RECEIPT_ASSUMED_AT' }, 422);
    }

    const evaluation = evaluateFilmReceiptAssumption({
      currentStatus: order.status,
      note: body?.note,
      acknowledgeNoEvidence: body?.acknowledgeNoEvidence,
      assumedAt: assumedAtInput.date
    });
    if (!evaluation.ok) {
      return context.json({ error: evaluation.message, code: evaluation.code, from: order.status }, 422);
    }

    const now = new Date();
    const receiptAssumedAt = evaluation.receiptAssumedAt instanceof Date
      ? evaluation.receiptAssumedAt
      : new Date(evaluation.receiptAssumedAt);
    const receiptAssumedNote = (body?.note as string).trim();
    try {
      const auditId = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, orderId)).limit(1).for('update');
        if (!current || current.status !== order.status) throw new ReceiptAssumptionStateConflict();

        const updated = await tx.update(filmSupplyOrders).set({
          status: evaluation.to,
          receiptAssumedAt,
          receiptAssumedByUserId: user.id,
          receiptAssumedNote,
          updatedAt: now
        }).where(and(
          eq(filmSupplyOrders.id, orderId),
          eq(filmSupplyOrders.status, order.status)
        )).returning({ id: filmSupplyOrders.id });
        if (updated.length === 0) throw new ReceiptAssumptionStateConflict();

        const auditRow = {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_RECEIPT_ASSUMPTION_RECORDED',
          entityType: 'film_supply_order',
          entityId: orderId,
          beforeState: { status: order.status, receiptAssumedAt: current.receiptAssumedAt },
          afterState: {
            status: evaluation.to,
            receiptAssumedAt,
            receiptAssumedNote,
            evidenceFreeAcknowledgment: true
          },
          occurredAt: now,
          requestMetadata: { operation: 'film_order:assume_receipt', evidenceFreeAcknowledgment: true }
        };
        await recordAuditEvent(tx, auditRow);
        return auditRow.id;
      });
      return context.json({
        orderId,
        status: evaluation.to,
        previousStatus: order.status,
        receiptAssumedAt,
        receiptAssumedNote,
        receiptAssumedByUserId: user.id,
        evidenceFreeAcknowledgment: true,
        auditEventId: auditId
      }, 200);
    } catch (error) {
      if (error instanceof ReceiptAssumptionStateConflict) {
        return context.json({ error: 'フィルム発注の状態が既に変わっています', code: 'RECEIPT_ASSUMPTION_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  // Delivery confirmation: binding one verified evidence document version to
  // one delivery row. Deliveries are append-only, so the confirmation is its
  // own append-only row; until it exists the delivery stays
  // PENDING_CONFIRMATION and commission readiness cannot escalate (T-36).
  interface DeliveryConfirmationTarget {
    kind: 'film' | 'filling';
    deliveryId: string;
    orderId: string;
    projectId: string;
    orderDeletedAt: Date | null;
  }

  async function loadDeliveryConfirmationTarget(
    kind: 'film' | 'filling',
    deliveryId: string
  ): Promise<DeliveryConfirmationTarget | null> {
    if (kind === 'film') {
      const [row] = await db.select({
        deliveryId: filmDeliveries.id,
        orderId: filmSupplyOrders.id,
        projectId: filmSupplyOrders.projectId,
        orderDeletedAt: filmSupplyOrders.deletedAt
      }).from(filmDeliveries)
        .innerJoin(filmSupplyOrders, eq(filmSupplyOrders.id, filmDeliveries.filmSupplyOrderId))
        .where(eq(filmDeliveries.id, deliveryId)).limit(1);
      return row ? { kind, ...row } : null;
    }
    const [row] = await db.select({
      deliveryId: fillingDeliveries.id,
      orderId: fillingOrders.id,
      projectId: fillingOrders.projectId,
      orderDeletedAt: fillingOrders.deletedAt
    }).from(fillingDeliveries)
      .innerJoin(fillingOrders, eq(fillingOrders.id, fillingDeliveries.fillingOrderId))
      .where(eq(fillingDeliveries.id, deliveryId)).limit(1);
    return row ? { kind, ...row } : null;
  }

  async function handleDeliveryConfirmationRequest(
    context: any,
    kind: 'film' | 'filling'
  ): Promise<Response> {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const deliveryId = context.req.param('deliveryId');

    const target = await loadDeliveryConfirmationTarget(kind, deliveryId);
    if (!target || target.orderDeletedAt) return context.json({ error: '納品行が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'delivery_confirmation:record', 'F1', target.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const [existing] = await db.select({ id: deliveryConfirmations.id })
      .from(deliveryConfirmations)
      .where(kind === 'film'
        ? eq(deliveryConfirmations.filmDeliveryId, deliveryId)
        : eq(deliveryConfirmations.fillingDeliveryId, deliveryId))
      .limit(1);
    if (existing) {
      return context.json({ error: 'この納品行は既に確認済みです', code: 'DELIVERY_ALREADY_CONFIRMED' }, 422);
    }

    const body = await context.req.json().catch(() => null) as any;
    const requestedEvidenceId = typeof body?.evidenceDocumentVersionId === 'string'
      && body.evidenceDocumentVersionId.length > 0
      ? body.evidenceDocumentVersionId as string
      : null;
    const [evidence] = requestedEvidenceId
      ? await db.select({
        versionId: documentVersions.id,
        projectId: documents.projectId,
        documentType: documents.documentType,
        filmSupplyOrderId: documents.filmSupplyOrderId,
        verificationStatus: documents.verificationStatus
      }).from(documentVersions)
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(eq(documentVersions.id, requestedEvidenceId)).limit(1)
      : [];

    const evaluation = evaluateDeliveryEvidence(requestedEvidenceId, {
      order: {
        projectId: target.projectId,
        filmSupplyOrderId: kind === 'film' ? target.orderId : null
      },
      evidenceDocument: evidence ?? null
    });
    if (!evaluation.ok) {
      return context.json({ error: evaluation.message, code: evaluation.code }, 422);
    }

    const now = new Date();
    const confirmationId = uuidv7(now);
    const auditId = uuidv7(now);
    const confirmation = {
      id: confirmationId,
      deliveryKind: kind,
      filmDeliveryId: kind === 'film' ? deliveryId : null,
      fillingDeliveryId: kind === 'filling' ? deliveryId : null,
      evidenceDocumentVersionId: evidence!.versionId,
      confirmedByUserId: user.id,
      confirmedAt: now,
      note: optionalText(body?.note)
    };
    await db.transaction(async (tx) => {
      await tx.insert(deliveryConfirmations).values(confirmation);
      await recordAuditEvent(tx, {
        projectId: target.projectId,
        id: auditId,
        actorUserId: user.id,
        action: kind === 'film' ? 'FILM_DELIVERY_CONFIRMED' : 'FILLING_DELIVERY_CONFIRMED',
        entityType: 'delivery_confirmation',
        entityId: confirmationId,
        afterState: { ...confirmation, projectId: target.projectId, deliveryId },
        occurredAt: now,
        requestMetadata: { operation: 'delivery_confirmation:record', deliveryKind: kind, deliveryId }
      });
    });

    return context.json({
      confirmation,
      delivery: {
        id: deliveryId,
        kind,
        confirmationState: fillingDeliveryConfirmationState(true)
      },
      auditEventId: auditId
    }, 201);
  }

  app.post('/api/film-deliveries/:deliveryId/confirmation', (context) => handleDeliveryConfirmationRequest(context, 'film'));
  app.post('/api/filling-deliveries/:deliveryId/confirmation', (context) => handleDeliveryConfirmationRequest(context, 'filling'));

  // --------------------------- M5: Japanese status surface (design section 8).
  // The labels live in @kanei/core and are served verbatim; the web skeleton
  // renders them without re-spelling anything. Session-gated like every other
  // endpoint; the vocabulary itself is not project-scoped.
  app.get('/api/status-labels', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    return context.json(japaneseStatusSurface());
  });

  // --------------------------- M5: audit history (design section 8 item 6).
  // Read-only listing of audit_events for one project, optionally narrowed to
  // one entity (an order, a document, ...). Every row is stamped with its
  // project when it is written (migration 0013), so the project boundary is a
  // plain filter on that column: no other project's rows can enter the answer,
  // and no per-entity resolver has to be extended when a new audited entity
  // kind appears.
  app.get('/api/projects/:projectId/audit-history', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    // An unknown project is 404 before the assignment check: staff of this
    // company learn nothing about a project that does not exist.
    const [project] = await db.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'audit_history:read', 'F1', projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const query = context.req.query();
    const requestedLimit = Number(query.limit ?? '200');
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 500)
      : 200;
    const entityTypeFilter = typeof query.entityType === 'string' && query.entityType.length > 0
      ? eq(auditEvents.entityType, query.entityType)
      : undefined;
    const entityIdFilter = typeof query.entityId === 'string' && query.entityId.length > 0
      ? eq(auditEvents.entityId, query.entityId)
      : undefined;

    const rows = await db.select({
      id: auditEvents.id,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      beforeState: auditEvents.beforeState,
      afterState: auditEvents.afterState,
      occurredAt: auditEvents.occurredAt,
      requestMetadata: auditEvents.requestMetadata,
      actorId: users.id,
      actorDisplayName: users.displayName,
      actorRole: users.role
    }).from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(eq(auditEvents.projectId, projectId), entityTypeFilter, entityIdFilter))
      .orderBy(auditEvents.occurredAt, auditEvents.id)
      .limit(limit);

    return context.json({
      projectId,
      count: rows.length,
      events: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        beforeState: row.beforeState,
        afterState: row.afterState,
        occurredAt: row.occurredAt,
        requestMetadata: row.requestMetadata,
        actor: row.actorId
          ? { id: row.actorId, displayName: row.actorDisplayName, role: row.actorRole }
          : null
      }))
    });
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
      await recordAuditEvent(tx, {
        projectId,
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
      await recordAuditEvent(tx, {
        projectId: order.projectId,
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
      await recordAuditEvent(tx, {
        projectId: order.projectId,
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
  // delivery (T-14). M5 (T-36): the evaluation is explicit and evidence-gated —
  // deliveries pending confirmation keep the state at MISSING_DATA or
  // PENDING_VERIFICATION, no readiness escalation and no commission calculation
  // ever happens as a side effect of recording a delivery.
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
    // them from scratch: the stored row is the project's evaluation record and
    // a recorded flag never regresses.
    const [previousReadiness] = await db.select()
      .from(commissionReadiness)
      .where(eq(commissionReadiness.projectId, projectId))
      .limit(1);

    const [registeredPo] = await db.select({ id: sevenPurchaseOrders.id })
      .from(sevenPurchaseOrders)
      .where(and(eq(sevenPurchaseOrders.projectId, projectId), isNotNull(sevenPurchaseOrders.officialRegisteredAt)))
      .limit(1);

    // M5 (T-36): a delivery is recorded as soon as its row exists for this
    // project, whether or not any evidence has been bound to it yet. The
    // confirmation check reads every delivery of this project, so a delivery
    // without verified evidence keeps the project at PENDING_VERIFICATION —
    // never READY — no matter when it was recorded. This endpoint is still the
    // only writer of commission_readiness: nothing here touches any other
    // table, and a confirmation row is only ever read.
    const allFilmDeliveries = await db.select({ id: filmDeliveries.id })
      .from(filmDeliveries)
      .innerJoin(filmSupplyOrders, eq(filmSupplyOrders.id, filmDeliveries.filmSupplyOrderId))
      .where(eq(filmSupplyOrders.projectId, projectId));
    const allFillingDeliveries = await db.select({ id: fillingDeliveries.id })
      .from(fillingDeliveries)
      .innerJoin(fillingOrders, eq(fillingOrders.id, fillingDeliveries.fillingOrderId))
      .where(eq(fillingOrders.projectId, projectId));
    const filmDeliveryIds = allFilmDeliveries.map((row) => row.id);
    const fillingDeliveryIds = allFillingDeliveries.map((row) => row.id);
    const filmConfirmationRows = filmDeliveryIds.length === 0
      ? []
      : await db.select({ id: deliveryConfirmations.id })
        .from(deliveryConfirmations)
        .where(inArray(deliveryConfirmations.filmDeliveryId, filmDeliveryIds));
    const fillingConfirmationRows = fillingDeliveryIds.length === 0
      ? []
      : await db.select({ id: deliveryConfirmations.id })
        .from(deliveryConfirmations)
        .where(inArray(deliveryConfirmations.fillingDeliveryId, fillingDeliveryIds));

    const filmDeliveryRecorded = previousReadiness?.filmDeliveryRecorded || allFilmDeliveries.length > 0;
    const fillingDeliveryRecorded = previousReadiness?.fillingDeliveryRecorded || allFillingDeliveries.length > 0;
    const sevenPoOfficiallyRegistered = registeredPo !== undefined;
    const filmDeliveryConfirmed = allFilmDeliveries.length > 0
      && filmConfirmationRows.length === allFilmDeliveries.length;
    const fillingDeliveryConfirmed = allFillingDeliveries.length > 0
      && fillingConfirmationRows.length === allFillingDeliveries.length;

    const evaluation = evaluateCommissionReadiness({
      filmDeliveryRecorded,
      fillingDeliveryRecorded,
      sevenPoOfficiallyRegistered,
      filmDeliveryConfirmed,
      fillingDeliveryConfirmed
    });
    const isReady = evaluation.isReady;
    const readinessId = uuidv7(now);
    const readiness = {
      filmDeliveryRecorded,
      fillingDeliveryRecorded,
      sevenPoOfficiallyRegistered,
      filmDeliveryConfirmed,
      fillingDeliveryConfirmed,
      readinessState: evaluation.state,
      isReady,
      readyAt: isReady ? previousReadiness?.readyAt ?? now : null,
      evaluatedAt: now,
      evaluatedByUserId: user.id,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.insert(commissionReadiness)
        .values({ id: readinessId, projectId, ...readiness })
        .onConflictDoUpdate({ target: commissionReadiness.projectId, set: readiness });
      await recordAuditEvent(tx, {
        projectId,
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'COMMISSION_READINESS_EVALUATED',
        entityType: 'commission_readiness',
        entityId: projectId,
        afterState: { projectId, ...readiness, blocking: evaluation.blocking },
        occurredAt: now,
        requestMetadata: { operation: 'commission_readiness:evaluate' }
      });
    });

    const [row] = await db.select().from(commissionReadiness).where(eq(commissionReadiness.projectId, projectId)).limit(1);
    return context.json({
      ...(row ?? { id: readinessId, projectId, ...readiness }),
      readinessState: evaluation.state,
      blocking: evaluation.blocking,
      commissionCalculationAllowed: isCommissionCalculationAllowed(evaluation.state)
    }, 201);
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

    // M3/M4 order linkage: a document may declare which film supply order it
    // belongs to. Artwork-bound types (proof, approval evidence) additionally
    // name the design (T-35), while send and acceptance evidence is about the
    // whole maker paper and carries the order alone (design section 5.4). The
    // binding is validated once at intake and trusted everywhere else.
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
      if (!input.designKey && isArtworkBoundDocumentType(input.documentType)) {
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
    // A document's first version shares the document's identity: the version
    // that created the logical document is addressable by either id, so
    // evidence records (approval, send, acceptance) can be resolved from the
    // document or from the version that was cited. Later versions of the same
    // logical document get their own identity.
    const versionId = versionNumber === 1 ? documentId : uuidv7(now);
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
      id: versionId,
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
        await recordAuditEvent(tx, {
          projectId,
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
        await recordAuditEvent(tx, {
          projectId,
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
      await recordAuditEvent(tx, {
        projectId,
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
      await recordAuditEvent(tx, {
        projectId: current.projectId,
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
      await recordAuditEvent(tx, {
        projectId: current.projectId,
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
      await recordAuditEvent(tx, {
        projectId: po.projectId,
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
      await recordAuditEvent(tx, {
        projectId: po.projectId,
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
      await recordAuditEvent(tx, {
        projectId: order.projectId,
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
        await recordAuditEvent(tx, {
          projectId: order.projectId,
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
      await recordAuditEvent(tx, {
        projectId: order.projectId,
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
        await recordAuditEvent(tx, {
          projectId: order.projectId,
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

  // --------------------------- M4: maker purchase orders with manual-send
  // evidence (design section 5.8, gates G8 to G10). The maker PO is a
  // snapshot-first record: the paper the maker receives is frozen as JSON plus
  // a server-computed digest, the CEO approves exactly that digest, and the
  // manual (outside-the-system) send is only ever recorded as evidence.
  //
  // Every transition re-reads the PO row FOR UPDATE inside a transaction and
  // writes it conditionally on the status it was read with, so two simultaneous
  // transition requests (approval + send, or two sends) result in exactly one
  // effective transition and a consistent audit trail (T-25). Every write in
  // this section records its audit_events row in the same transaction.
  async function loadMakerPoSnapshotParts(executor: MakerPoQueryExecutor, orderId: string): Promise<{
    order: typeof filmSupplyOrders.$inferSelect;
    lines: Array<{ lineNumber: number; description: string; orderedQuantity: string; unit: string }>;
    artworkFiles: MakerPoSnapshotArtworkFile[];
    sevenPoNumber: string | null;
  }> {
    const [order] = await executor.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order) throw new Error('maker PO snapshot source order is missing');

    const lines = await executor.select({
      lineNumber: filmSupplyOrderLines.lineNumber,
      description: filmSupplyOrderLines.description,
      orderedQuantity: filmSupplyOrderLines.orderedQuantity,
      unit: filmSupplyOrderLines.unit
    }).from(filmSupplyOrderLines)
      .where(eq(filmSupplyOrderLines.filmSupplyOrderId, orderId))
      .orderBy(filmSupplyOrderLines.lineNumber);

    // Current revision per design: highest revision_no wins. Ordering by design
    // ascending and revision descending makes the first row per design current.
    const revisions = await executor.select({
      designKey: artworkRevisions.designKey,
      revisionNo: artworkRevisions.revisionNo,
      fileSha256: documentVersions.sha256
    }).from(artworkRevisions)
      .innerJoin(documentVersions, eq(documentVersions.id, artworkRevisions.fileDocumentVersionId))
      .where(eq(artworkRevisions.filmSupplyOrderId, orderId))
      .orderBy(artworkRevisions.designKey, desc(artworkRevisions.revisionNo));
    const artworkFiles: MakerPoSnapshotArtworkFile[] = [];
    const seenDesigns = new Set<string>();
    for (const revision of revisions) {
      if (seenDesigns.has(revision.designKey)) continue;
      seenDesigns.add(revision.designKey);
      artworkFiles.push({
        designKey: revision.designKey,
        revisionNo: revision.revisionNo,
        fileSha256: revision.fileSha256
      });
    }

    let sevenPoNumber: string | null = null;
    if (order.sevenPurchaseOrderId) {
      const [po] = await executor.select({ poNumber: sevenPurchaseOrders.poNumber })
        .from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, order.sevenPurchaseOrderId)).limit(1);
      sevenPoNumber = po?.poNumber ?? null;
    }
    return { order, lines, artworkFiles, sevenPoNumber };
  }

  /**
   * Rebuilds the snapshot from current order data plus the frozen request-only
   * parts (amounts, recipient address). Only order-side data can therefore move
   * the digest: a quantity change (T-23) or a new artwork revision (T-24)
   * breaks snapshot identity, an edit of the frozen amounts cannot.
   */
  function rebuildMakerPoSnapshot(
    parts: Awaited<ReturnType<typeof loadMakerPoSnapshotParts>>,
    storedSnapshot: MakerPoSnapshot
  ): MakerPoSnapshot {
    return buildMakerPoSnapshot({
      order: { id: parts.order.id, code: parts.order.code, sevenPoNumber: parts.sevenPoNumber },
      items: parts.lines,
      artworkFiles: parts.artworkFiles,
      amounts: storedSnapshot.amounts ?? null,
      recipientAddress: storedSnapshot.recipient.address
    });
  }

  async function loadMakerPoEvidenceDocument(
    executor: MakerPoQueryExecutor,
    versionId: string
  ): Promise<MakerPoEvidenceDocument | null> {
    const [row] = await executor.select({
      documentId: documents.id,
      versionId: documentVersions.id,
      sha256: documentVersions.sha256,
      documentType: documents.documentType,
      projectId: documents.projectId,
      filmSupplyOrderId: documents.filmSupplyOrderId,
      designKey: documents.designKey,
      verificationStatus: documents.verificationStatus
    }).from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, versionId)).limit(1);
    return row ?? null;
  }

  app.post('/api/film-supply-orders/:orderId/maker-purchase-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const creationGate = evaluateMakerPoCreationGate({ orderStatus: order.status });
    if (!creationGate.ok) return context.json({ error: creationGate.message, code: creationGate.code }, 422);

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.recipientAddress !== 'string' || body.recipientAddress.trim().length === 0) {
      return context.json({ error: '宛先住所が必要です', code: 'RECIPIENT_ADDRESS_REQUIRED' }, 422);
    }
    let amounts: { currency: string; totalAmount: string } | null = null;
    if (body?.amounts !== undefined && body?.amounts !== null) {
      if (typeof body.amounts?.currency !== 'string' || body.amounts.currency.length === 0
        || typeof body.amounts?.totalAmount !== 'string' || body.amounts.totalAmount.length === 0) {
        return context.json({ error: '金額は currency と totalAmount の文字列です', code: 'INVALID_MAKER_PO_AMOUNTS' }, 422);
      }
      amounts = { currency: body.amounts.currency, totalAmount: body.amounts.totalAmount };
    }

    const parts = await loadMakerPoSnapshotParts(db, orderId);
    const snapshot = buildMakerPoSnapshot({
      order: { id: parts.order.id, code: parts.order.code, sevenPoNumber: parts.sevenPoNumber },
      items: parts.lines,
      artworkFiles: parts.artworkFiles,
      amounts,
      recipientAddress: body.recipientAddress
    });
    const snapshotSha256 = computeMakerPoSnapshotSha256(snapshot);

    const now = new Date();
    const poId = uuidv7(now);
    const purchaseOrder = {
      id: poId,
      filmSupplyOrderId: orderId,
      snapshot,
      snapshotSha256,
      status: 'DRAFT' as const,
      ceoApprovedByUserId: null,
      ceoApprovedAt: null,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.insert(makerPurchaseOrders).values(purchaseOrder);
      await recordAuditEvent(tx, {
        projectId: order.projectId,
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'MAKER_PO_CREATED',
        entityType: 'maker_purchase_order',
        entityId: poId,
        afterState: { ...purchaseOrder, orderCode: parts.order.code },
        occurredAt: now,
        requestMetadata: { operation: 'maker_po:create', filmSupplyOrderId: orderId }
      });
    });
    return context.json(purchaseOrder, 201);
  });

  app.post('/api/maker-purchase-orders/:poId/ceo-approval', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);

    // CEO approval is intentionally never delegated: staff attempts get 403
    // (T-31 pattern).
    const decision = canPerform(toActor(user), 'ceo_approve', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '代表者のみ承認できます' }, 403);

    const poStatus = validateMakerPoStatus(existing.status);
    if (!poStatus.ok) return context.json({ error: poStatus.message, code: poStatus.code }, 422);
    const approval = evaluateMakerPoApproval(poStatus.value);
    if (!approval.ok) {
      return context.json({ error: approval.message, code: approval.code, from: approval.from }, 422);
    }

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        const [po] = await tx.select().from(makerPurchaseOrders)
          .where(eq(makerPurchaseOrders.id, poId)).limit(1).for('update');
        if (!po || po.status !== approval.from) throw new MakerPoStateConflict();

        // The approval re-freezes current order data and stamps the digest it
        // approved: a voided snapshot can only come back through this door.
        const parts = await loadMakerPoSnapshotParts(tx, po.filmSupplyOrderId);
        const snapshot = rebuildMakerPoSnapshot(parts, po.snapshot as MakerPoSnapshot);
        const snapshotSha256 = computeMakerPoSnapshotSha256(snapshot);

        const updated = await tx.update(makerPurchaseOrders).set({
          snapshot,
          snapshotSha256,
          status: 'APPROVED_FOR_MANUAL_SEND' as const,
          ceoApprovedByUserId: user.id,
          ceoApprovedAt: now,
          updatedAt: now
        }).where(and(
          eq(makerPurchaseOrders.id, poId),
          eq(makerPurchaseOrders.status, po.status)
        )).returning({ id: makerPurchaseOrders.id });
        if (updated.length === 0) throw new MakerPoStateConflict();

        const approvalEvent = {
          id: uuidv7(now),
          makerPurchaseOrderId: poId,
          eventType: 'CEO_APPROVED' as const,
          verificationStatus: 'UNVERIFIED' as const,
          recordedByUserId: user.id,
          recordedAt: now
        };
        await tx.insert(makerPoEvents).values(approvalEvent);

        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_CEO_APPROVED',
          entityType: 'maker_po_event',
          entityId: approvalEvent.id,
          beforeState: { status: po.status, snapshotSha256: po.snapshotSha256 },
          afterState: { status: 'APPROVED_FOR_MANUAL_SEND', snapshotSha256, approvedByUserId: user.id },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:ceo_approve', makerPurchaseOrderId: poId }
        });
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_STATUS_CHANGED',
          entityType: 'maker_purchase_order',
          entityId: poId,
          beforeState: { status: po.status },
          afterState: { status: 'APPROVED_FOR_MANUAL_SEND', snapshotSha256 },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:ceo_approve' }
        });

        // The film supply order chain mirrors the maker PO when the transition
        // is legal there; exception states (change review, hold) are left alone.
        const [currentOrder] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, po.filmSupplyOrderId)).limit(1);
        if (currentOrder && transitionFilmSupplyOrder(currentOrder.status, 'APPROVED_FOR_MANUAL_SEND').ok) {
          await tx.update(filmSupplyOrders).set({ status: 'APPROVED_FOR_MANUAL_SEND', updatedAt: now })
            .where(eq(filmSupplyOrders.id, currentOrder.id));
          await recordAuditEvent(tx, {
            projectId: order.projectId,
            id: uuidv7(now),
            actorUserId: user.id,
            action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
            entityType: 'film_supply_order',
            entityId: currentOrder.id,
            beforeState: { status: currentOrder.status },
            afterState: { status: 'APPROVED_FOR_MANUAL_SEND' },
            occurredAt: now,
            requestMetadata: { operation: 'maker_po:ceo_approve', reason: 'maker_po_approved' }
          });
        }

        return {
          purchaseOrder: {
            id: poId,
            filmSupplyOrderId: po.filmSupplyOrderId,
            snapshot,
            snapshotSha256,
            status: 'APPROVED_FOR_MANUAL_SEND' as const,
            ceoApprovedByUserId: user.id,
            ceoApprovedAt: now,
            createdByUserId: po.createdByUserId,
            createdAt: po.createdAt,
            updatedAt: now
          },
          approvalEvent
        };
      });
      return context.json(outcome, 200);
    } catch (error) {
      if (error instanceof MakerPoStateConflict) {
        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  app.post('/api/maker-purchase-orders/:poId/send-evidence', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:send_evidence', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const sentAt = parseOptionalDate(body?.sentAt);
    if (!sentAt.ok) return context.json({ error: '送信日時が不正です', code: 'INVALID_DATE' }, 422);

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        const [po] = await tx.select().from(makerPurchaseOrders)
          .where(eq(makerPurchaseOrders.id, poId)).limit(1).for('update');
        if (!po) throw new MakerPoStateConflict();
        const poStatus = validateMakerPoStatus(po.status);
        if (!poStatus.ok) return { kind: 'error' as const, code: poStatus.code, message: poStatus.message };

        const sendGate = evaluateMakerPoSendTransition(poStatus.value);
        if (!sendGate.ok) {
          return { kind: 'blocked' as const, code: sendGate.code, from: sendGate.from, message: sendGate.message };
        }

        // Snapshot identity at the moment of registration (G10): the digest is
        // recomputed from current order data and compared with the approved one.
        const parts = await loadMakerPoSnapshotParts(tx, po.filmSupplyOrderId);
        const storedSnapshot = po.snapshot as MakerPoSnapshot;
        const currentSnapshot = rebuildMakerPoSnapshot(parts, storedSnapshot);
        const currentSnapshotSha256 = computeMakerPoSnapshotSha256(currentSnapshot);
        const requestedEvidenceId = typeof body?.evidenceDocumentVersionId === 'string'
          && body.evidenceDocumentVersionId.length > 0
          ? body.evidenceDocumentVersionId as string
          : null;
        const evidenceDocument = requestedEvidenceId
          ? await loadMakerPoEvidenceDocument(tx, requestedEvidenceId)
          : null;

        const evaluation = evaluateMakerPoSendEvidence({
          evidenceDocumentVersionId: requestedEvidenceId,
          senderAddress: body?.senderAddress,
          recipients: body?.recipients,
          sentAt: sentAt.date,
          attachmentHashes: body?.attachmentHashes
        }, {
          order: { id: order.id, projectId: order.projectId },
          approvedSnapshotSha256: po.snapshotSha256,
          currentSnapshotSha256,
          snapshot: currentSnapshot,
          evidenceDocument
        });

        if (!evaluation.ok) {
          if (evaluation.outcome === 'invalid_request') {
            return { kind: 'invalid' as const, code: evaluation.code, message: evaluation.message };
          }

          // A refused send is itself recorded: SNAPSHOT_VOIDED marks the frozen
          // paper dead (a fresh CEO approval is required), SEND_REJECTED records
          // that a send was claimed and did not check out.
          const targetStatus = evaluation.outcome === 'snapshot_voided'
            ? 'SNAPSHOT_VOIDED' as const
            : poStatus.value;
          if (targetStatus !== poStatus.value) {
            const voided = await tx.update(makerPurchaseOrders).set({ status: targetStatus, updatedAt: now })
              .where(and(eq(makerPurchaseOrders.id, poId), eq(makerPurchaseOrders.status, poStatus.value)))
              .returning({ id: makerPurchaseOrders.id });
            if (voided.length === 0) throw new MakerPoStateConflict();
            await recordAuditEvent(tx, {
              projectId: order.projectId,
              id: uuidv7(now),
              actorUserId: user.id,
              action: 'MAKER_PO_STATUS_CHANGED',
              entityType: 'maker_purchase_order',
              entityId: poId,
              beforeState: { status: poStatus.value },
              afterState: { status: targetStatus, approvedSnapshotSha256: po.snapshotSha256, currentSnapshotSha256 },
              occurredAt: now,
              requestMetadata: { operation: 'maker_po:send_evidence', reason: 'snapshot_mismatch' }
            });
          }
          const refusedEvent = {
            id: uuidv7(now),
            makerPurchaseOrderId: poId,
            eventType: evaluation.outcome === 'snapshot_voided' ? 'SNAPSHOT_VOIDED' as const : 'SEND_REJECTED' as const,
            evidenceDocumentVersionId: evidenceDocument?.versionId ?? null,
            senderAddress: typeof body?.senderAddress === 'string' && body.senderAddress.trim().length > 0
              ? body.senderAddress.trim()
              : null,
            recipients: Array.isArray(body?.recipients) ? body.recipients : null,
            sentAt: sentAt.date,
            attachmentHashes: null,
            verificationStatus: 'UNVERIFIED' as const,
            recordedByUserId: user.id,
            recordedAt: now
          };
          await tx.insert(makerPoEvents).values(refusedEvent);
          await recordAuditEvent(tx, {
            projectId: order.projectId,
            id: uuidv7(now),
            actorUserId: user.id,
            action: evaluation.outcome === 'snapshot_voided' ? 'MAKER_PO_SNAPSHOT_VOIDED' : 'MAKER_PO_SEND_REJECTED',
            entityType: 'maker_po_event',
            entityId: refusedEvent.id,
            beforeState: { status: poStatus.value },
            afterState: {
              status: targetStatus,
              code: evaluation.code,
              approvedSnapshotSha256: po.snapshotSha256,
              currentSnapshotSha256
            },
            occurredAt: now,
            requestMetadata: { operation: 'maker_po:send_evidence', makerPurchaseOrderId: poId }
          });
          return {
            kind: 'refused' as const,
            evaluation,
            event: refusedEvent,
            status: targetStatus,
            snapshotHashes: { approved: po.snapshotSha256, current: currentSnapshotSha256 }
          };
        }

        const targetStatus = evaluation.verificationStatus === 'VERIFIED'
          ? 'MAKER_PO_SENT_MANUALLY' as const
          : 'SEND_UNVERIFIED' as const;
        const updated = await tx.update(makerPurchaseOrders).set({ status: targetStatus, updatedAt: now })
          .where(and(eq(makerPurchaseOrders.id, poId), eq(makerPurchaseOrders.status, poStatus.value)))
          .returning({ id: makerPurchaseOrders.id });
        if (updated.length === 0) throw new MakerPoStateConflict();

        const sentAtValue = typeof evaluation.sentAt === 'string' ? new Date(evaluation.sentAt) : evaluation.sentAt;
        const sendEvent = {
          id: uuidv7(now),
          makerPurchaseOrderId: poId,
          eventType: 'SEND_EVIDENCE_REGISTERED' as const,
          evidenceDocumentVersionId: evaluation.verificationStatus === 'VERIFIED'
            ? evaluation.evidenceDocumentVersionId
            : null,
          senderAddress: evaluation.verificationStatus === 'VERIFIED' ? evaluation.senderAddress : null,
          recipients: evaluation.verificationStatus === 'VERIFIED' ? evaluation.recipients : null,
          sentAt: sentAtValue,
          attachmentHashes: evaluation.verificationStatus === 'VERIFIED' ? evaluation.attachmentHashes : null,
          verificationStatus: evaluation.verificationStatus,
          recordedByUserId: user.id,
          recordedAt: now
        };
        await tx.insert(makerPoEvents).values(sendEvent);

        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: evaluation.verificationStatus === 'VERIFIED'
            ? 'MAKER_PO_SEND_EVIDENCE_REGISTERED'
            : 'MAKER_PO_SEND_RECORDED_UNVERIFIED',
          entityType: 'maker_po_event',
          entityId: sendEvent.id,
          beforeState: { status: poStatus.value },
          afterState: { status: targetStatus, event: sendEvent },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:send_evidence', makerPurchaseOrderId: poId }
        });
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_STATUS_CHANGED',
          entityType: 'maker_purchase_order',
          entityId: poId,
          beforeState: { status: poStatus.value },
          afterState: { status: targetStatus },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:send_evidence' }
        });

        if (targetStatus === 'MAKER_PO_SENT_MANUALLY') {
          const [currentOrder] = await tx.select().from(filmSupplyOrders)
            .where(eq(filmSupplyOrders.id, po.filmSupplyOrderId)).limit(1);
          if (currentOrder && transitionFilmSupplyOrder(currentOrder.status, 'MAKER_PO_SENT_MANUALLY').ok) {
            await tx.update(filmSupplyOrders).set({ status: 'MAKER_PO_SENT_MANUALLY', updatedAt: now })
              .where(eq(filmSupplyOrders.id, currentOrder.id));
            await recordAuditEvent(tx, {
              projectId: order.projectId,
              id: uuidv7(now),
              actorUserId: user.id,
              action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
              entityType: 'film_supply_order',
              entityId: currentOrder.id,
              beforeState: { status: currentOrder.status },
              afterState: { status: 'MAKER_PO_SENT_MANUALLY' },
              occurredAt: now,
              requestMetadata: { operation: 'maker_po:send_evidence', reason: 'maker_po_sent' }
            });
          }
        }

        return {
          kind: 'applied' as const,
          status: targetStatus,
          verificationStatus: evaluation.verificationStatus,
          event: sendEvent,
          purchaseOrder: {
            id: poId,
            filmSupplyOrderId: po.filmSupplyOrderId,
            snapshot: storedSnapshot,
            snapshotSha256: po.snapshotSha256,
            status: targetStatus,
            ceoApprovedByUserId: po.ceoApprovedByUserId,
            ceoApprovedAt: po.ceoApprovedAt,
            createdByUserId: po.createdByUserId,
            createdAt: po.createdAt,
            updatedAt: now
          }
        };
      });

      if (outcome.kind === 'error') return context.json({ error: outcome.message, code: outcome.code }, 422);
      if (outcome.kind === 'blocked') {
        return context.json({ error: outcome.message, code: outcome.code, from: outcome.from }, 422);
      }
      if (outcome.kind === 'invalid') return context.json({ error: outcome.message, code: outcome.code }, 422);
      if (outcome.kind === 'refused') {
        return context.json({
          error: outcome.evaluation.message,
          code: outcome.evaluation.code,
          status: outcome.status,
          event: outcome.event,
          approvedSnapshotSha256: outcome.evaluation.outcome === 'snapshot_voided'
            ? outcome.snapshotHashes.approved
            : undefined,
          currentSnapshotSha256: outcome.evaluation.outcome === 'snapshot_voided'
            ? outcome.snapshotHashes.current
            : undefined
        }, 422);
      }
      return context.json({
        status: outcome.status,
        verificationStatus: outcome.verificationStatus,
        event: outcome.event,
        purchaseOrder: outcome.purchaseOrder
      }, 200);
    } catch (error) {
      if (error instanceof MakerPoStateConflict) {
        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  app.post('/api/maker-purchase-orders/:poId/accept-evidence', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:accept_evidence', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const acceptedAt = parseOptionalDate(body?.acceptedAt);
    if (!acceptedAt.ok) return context.json({ error: '受領日時が不正です', code: 'INVALID_DATE' }, 422);

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        const [po] = await tx.select().from(makerPurchaseOrders)
          .where(eq(makerPurchaseOrders.id, poId)).limit(1).for('update');
        if (!po) throw new MakerPoStateConflict();
        const poStatus = validateMakerPoStatus(po.status);
        if (!poStatus.ok) return { kind: 'error' as const, code: poStatus.code, message: poStatus.message };

        // MAKER_PO_ACCEPTED is only reachable from MAKER_PO_SENT_MANUALLY, and
        // only through a verified acceptance evidence document (T-22).
        const acceptTransition = transitionMakerPurchaseOrder(poStatus.value, 'MAKER_PO_ACCEPTED');
        if (!acceptTransition.ok) {
          return {
            kind: 'blocked' as const,
            code: 'MAKER_PO_TRANSITION_BLOCKED' as const,
            from: poStatus.value,
            message: `a maker purchase order in ${poStatus.value} cannot be accepted; acceptance follows a proven send only`
          };
        }

        const requestedEvidenceId = typeof body?.evidenceDocumentVersionId === 'string'
          && body.evidenceDocumentVersionId.length > 0
          ? body.evidenceDocumentVersionId as string
          : null;
        const evaluation = evaluateMakerPoAcceptEvidence({
          evidenceDocumentVersionId: requestedEvidenceId,
          attachmentHashes: body?.attachmentHashes,
          acceptedAt: acceptedAt.date
        }, {
          order: { id: order.id, projectId: order.projectId },
          evidenceDocument: requestedEvidenceId
            ? await loadMakerPoEvidenceDocument(tx, requestedEvidenceId)
            : null
        });

        if (!evaluation.ok) {
          // A refused acceptance persists nothing: MAKER_PO_ACCEPTED is only
          // ever reached behind a verified acceptance document (T-22).
          if (evaluation.outcome === 'invalid_request') {
            return { kind: 'invalid' as const, code: evaluation.code, message: evaluation.message };
          }
          return { kind: 'refused' as const, evaluation };
        }

        const updated = await tx.update(makerPurchaseOrders).set({ status: 'MAKER_PO_ACCEPTED', updatedAt: now })
          .where(and(eq(makerPurchaseOrders.id, poId), eq(makerPurchaseOrders.status, poStatus.value)))
          .returning({ id: makerPurchaseOrders.id });
        if (updated.length === 0) throw new MakerPoStateConflict();

        const acceptEvent = {
          id: uuidv7(now),
          makerPurchaseOrderId: poId,
          eventType: 'ACCEPT_EVIDENCE_REGISTERED' as const,
          evidenceDocumentVersionId: evaluation.evidenceDocumentVersionId,
          attachmentHashes: evaluation.attachmentHashes,
          sentAt: evaluation.acceptedAt instanceof Date
            ? evaluation.acceptedAt
            : evaluation.acceptedAt === null
              ? null
              : new Date(evaluation.acceptedAt),
          verificationStatus: evaluation.verificationStatus,
          recordedByUserId: user.id,
          recordedAt: now
        };
        await tx.insert(makerPoEvents).values(acceptEvent);

        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_ACCEPT_EVIDENCE_REGISTERED',
          entityType: 'maker_po_event',
          entityId: acceptEvent.id,
          beforeState: { status: poStatus.value },
          afterState: { status: 'MAKER_PO_ACCEPTED', event: acceptEvent },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:accept_evidence', makerPurchaseOrderId: poId }
        });
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_STATUS_CHANGED',
          entityType: 'maker_purchase_order',
          entityId: poId,
          beforeState: { status: poStatus.value },
          afterState: { status: 'MAKER_PO_ACCEPTED' },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:accept_evidence' }
        });

        const [currentOrder] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, po.filmSupplyOrderId)).limit(1);
        if (currentOrder && transitionFilmSupplyOrder(currentOrder.status, 'MAKER_PO_ACCEPTED').ok) {
          await tx.update(filmSupplyOrders).set({ status: 'MAKER_PO_ACCEPTED', updatedAt: now })
            .where(eq(filmSupplyOrders.id, currentOrder.id));
          await recordAuditEvent(tx, {
            projectId: order.projectId,
            id: uuidv7(now),
            actorUserId: user.id,
            action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
            entityType: 'film_supply_order',
            entityId: currentOrder.id,
            beforeState: { status: currentOrder.status },
            afterState: { status: 'MAKER_PO_ACCEPTED' },
            occurredAt: now,
            requestMetadata: { operation: 'maker_po:accept_evidence', reason: 'maker_po_accepted' }
          });
        }

        return {
          kind: 'applied' as const,
          status: 'MAKER_PO_ACCEPTED' as const,
          event: acceptEvent,
          purchaseOrder: {
            id: poId,
            filmSupplyOrderId: po.filmSupplyOrderId,
            snapshot: po.snapshot as MakerPoSnapshot,
            snapshotSha256: po.snapshotSha256,
            status: 'MAKER_PO_ACCEPTED' as const,
            ceoApprovedByUserId: po.ceoApprovedByUserId,
            ceoApprovedAt: po.ceoApprovedAt,
            createdByUserId: po.createdByUserId,
            createdAt: po.createdAt,
            updatedAt: now
          }
        };
      });

      if (outcome.kind === 'error') return context.json({ error: outcome.message, code: outcome.code }, 422);
      if (outcome.kind === 'blocked') {
        return context.json({ error: outcome.message, code: outcome.code, from: outcome.from }, 422);
      }
      if (outcome.kind === 'invalid') return context.json({ error: outcome.message, code: outcome.code }, 422);
      if (outcome.kind === 'refused') {
        return context.json({ error: outcome.evaluation.message, code: outcome.evaluation.code }, 422);
      }
      return context.json({ status: outcome.status, event: outcome.event, purchaseOrder: outcome.purchaseOrder }, 200);
    } catch (error) {
      if (error instanceof MakerPoStateConflict) {
        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  app.get('/api/maker-purchase-orders/:poId', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');

    const [po] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!po) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select({ projectId: filmSupplyOrders.projectId })
      .from(filmSupplyOrders).where(eq(filmSupplyOrders.id, po.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:read', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const events = await db.select().from(makerPoEvents)
      .where(eq(makerPoEvents.makerPurchaseOrderId, poId))
      .orderBy(makerPoEvents.recordedAt, makerPoEvents.id);
    return context.json({ purchaseOrder: po, events });
  });

  app.get('/api/film-supply-orders/:orderId/maker-purchase-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');

    const [order] = await db.select({ projectId: filmSupplyOrders.projectId })
      .from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:read', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const rows = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, orderId))
      .orderBy(desc(makerPurchaseOrders.createdAt));
    return context.json({ makerPurchaseOrders: rows });
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
