import type { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import {
  accounts,
  documents,
  documentVersions,
  filmSupplyOrders,
  makerPoEvents,
  makerPoSendManualVerifications,
  makerPurchaseOrders,
  makerRecipientAddresses,
  projects,
  sevenPoOrderFacts,
  sevenPurchaseOrders,
  users
} from '@kanei/db/schema';
import { uuidv7 } from '@kanei/db';
import {
  canPerform,
  formatQuantityDisplay,
  MEASURE_UNITS,
  validateMakerPoRecipientAddress,
  type MeasureUnit,
  type UserRole
} from '@kanei/core';
import { getSessionUser, toActor, type AppDatabase } from './auth.js';

/** p6 X3: the send check of a send-evidence version, as the evidence list shows it. */
export type SendVerificationState = 'auto_verified' | 'manual_pending' | 'manual_confirmed' | 'manual_rejected';

/**
 * P2 server routes (representative approval 2026-11-21). Every route here:
 * - answers 401 AUTH_REQUIRED before reading anything about its target;
 * - decides permission with the one authorization core (canPerform), so the
 *   auditor / viewer / staff / admin rules are the same as everywhere else;
 * - writes its change and its append-only audit row in one transaction;
 * - never returns an amount to anyone but admin.
 * Writes under /api/film-supply-orders/:id/ and /api/seven-purchase-orders/:id/
 * are covered by the P1 X-Kanei-Expected-Project middleware (project-context.ts).
 */

export interface AuditInput {
  projectId: string | null;
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

export interface P2RouteDeps {
  db: AppDatabase;
  recordAuditEvent: (writer: Pick<AppDatabase, 'insert'>, input: AuditInput) => Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

export const DISPLAY_LANGUAGES = ['ja', 'ja-ko', 'ko'] as const;
export type DisplayLanguage = (typeof DISPLAY_LANGUAGES)[number];

/** A calendar date YYYY-MM-DD that exists (no 2026-02-30), year 2000–2100. */
export function parseCalendarDate(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false };
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 2000 || year > 2100) return { ok: false };
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { ok: false };
  return { ok: true, value };
}

const QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;
const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface OrderFactsInput {
  quantity?: { orderedQuantity: string; orderedUnit: MeasureUnit } | null;
  amount?: { totalAmount: string; currency: string } | null;
}

/**
 * The PUT body of …/order-facts. Quantity+unit and amount+currency are pairs:
 * both present (set), both null (clear), or both absent (unchanged).
 */
export function parseOrderFactsInput(body: unknown): { ok: true; value: OrderFactsInput } | { ok: false; message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: '送信内容を読み取れませんでした' };
  const raw = body as Record<string, unknown>;
  const out: OrderFactsInput = {};
  const has = (key: string) => Object.hasOwn(raw, key);
  if (has('orderedQuantity') || has('orderedUnit')) {
    if (raw.orderedQuantity === null && raw.orderedUnit === null) out.quantity = null;
    else if (typeof raw.orderedQuantity === 'string' && QUANTITY_PATTERN.test(raw.orderedQuantity) && Number(raw.orderedQuantity) > 0
      && typeof raw.orderedUnit === 'string' && (MEASURE_UNITS as readonly string[]).includes(raw.orderedUnit)) {
      out.quantity = { orderedQuantity: raw.orderedQuantity, orderedUnit: raw.orderedUnit as MeasureUnit };
    } else {
      return { ok: false, message: '数量は 0 より大きい数字（小数 3 桁まで）と単位を一緒に入力してください' };
    }
  }
  if (has('totalAmount') || has('currency')) {
    if (raw.totalAmount === null && raw.currency === null) out.amount = null;
    else if (typeof raw.totalAmount === 'string' && AMOUNT_PATTERN.test(raw.totalAmount)
      && typeof raw.currency === 'string' && CURRENCY_PATTERN.test(raw.currency)) {
      out.amount = { totalAmount: raw.totalAmount, currency: raw.currency };
    } else {
      return { ok: false, message: '金額は数字（小数 2 桁まで）と通貨コード（英大文字 3 文字）を一緒に入力してください' };
    }
  }
  if (out.quantity === undefined && out.amount === undefined) {
    return { ok: false, message: '変更する項目（数量または金額）がありません' };
  }
  return { ok: true, value: out };
}

type OrderFactsRow = typeof sevenPoOrderFacts.$inferSelect;

/** The order facts as a role may read them: the amount is admin's only. */
export function orderFactsViewForRole(role: UserRole, sevenPurchaseOrderId: string, row: OrderFactsRow | undefined) {
  const quantity = {
    sevenPurchaseOrderId,
    orderedQuantity: row?.orderedQuantity ?? null,
    orderedUnit: row?.orderedUnit ?? null,
    orderedQuantityDisplay: row?.orderedQuantity && row.orderedUnit
      ? formatQuantityDisplay(row.orderedQuantity, row.orderedUnit)
      : null,
    updatedAt: row?.updatedAt ?? null
  };
  if (role !== 'admin') return quantity;
  return { ...quantity, totalAmount: row?.totalAmount ?? null, currency: row?.currency ?? null };
}

/** Lower-case, validated maker recipient address (same rule as the maker PO, P0 R10). */
export function normalizeRecipientEmail(value: unknown): { ok: true; email: string } | { ok: false; code: string; message: string } {
  const check = validateMakerPoRecipientAddress(value);
  if (!check.ok) return { ok: false, code: check.code, message: check.message };
  return { ok: true, email: check.address.toLowerCase() };
}

function parseLabel(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  return trimmed.length <= 100 ? { ok: true, value: trimmed } : { ok: false };
}

/**
 * P2 decision: the delivery terms are frozen into the maker PO at the
 * representative's approval, so once a live (not cancelled) paper is approved
 * they are the terms the paper was approved against — like 支払条件, a change
 * is a paper cancellation and a new approval (never a silent drift that would
 * void the paper at the send).
 */
const DELIVERY_TERMS_LOCKED = {
  error: '代表承認済みのメーカー発注書があるため、納期・セブン化学発注書の数量は変更できません。変更する場合はメーカー発注書を取り消して作り直してください',
  code: 'DELIVERY_TERMS_LOCKED'
} as const;

function approvedLivePaper(orderIds: ReturnType<typeof eq>) {
  return and(orderIds, isNull(makerPurchaseOrders.deletedAt), ne(makerPurchaseOrders.status, 'CANCELLED'), isNotNull(makerPurchaseOrders.ceoApprovedAt));
}

function postgresCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

/** P-2: document types whose file name the auditor does not read (quotes and the seven PO carry prices; review L-5). */
const AUDITOR_HIDDEN_FILENAME_TYPES: ReadonlySet<string> = new Set(['film_quote_kanei', 'filling_quote_seven', 'seven_po']);

export function registerP2Routes(app: Hono<any>, { db, recordAuditEvent }: P2RouteDeps): void {
  const unauthorized = { error: '認証が必要です', code: 'AUTH_REQUIRED' } as const;
  const forbidden = { error: '権限がありません', code: 'FORBIDDEN' } as const;
  const badPath = (name: string) => ({ error: `経路パラメータ（${name}）はUUIDである必要があります`, code: 'INVALID_PATH_PARAMETER' });

  // ------------------------------------------------------------ R29 language
  app.put('/api/me/preferences', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    const body = await context.req.json().catch(() => null) as { displayLanguage?: unknown } | null;
    const value = body?.displayLanguage;
    if (!body || !Object.hasOwn(body, 'displayLanguage')
      || !(value === null || (typeof value === 'string' && (DISPLAY_LANGUAGES as readonly string[]).includes(value)))) {
      return context.json({
        error: '表示言語は「日本語」「日本語＋한국어」「한국어」から選んでください',
        code: 'DISPLAY_LANGUAGE_INVALID'
      }, 422);
    }
    const now = new Date();
    const displayLanguage = value as DisplayLanguage | null;
    await db.transaction(async (tx) => {
      const [before] = await tx.select({ displayLanguage: users.displayLanguage }).from(users)
        .where(eq(users.id, user.id)).for('update');
      await tx.update(users).set({ displayLanguage, updatedAt: now }).where(eq(users.id, user.id));
      await recordAuditEvent(tx, {
        projectId: null,
        actorUserId: user.id,
        action: 'USER_DISPLAY_LANGUAGE_UPDATED',
        entityType: 'user',
        entityId: user.id,
        beforeState: { displayLanguage: before?.displayLanguage ?? null },
        afterState: { displayLanguage },
        occurredAt: now,
        requestMetadata: { operation: 'user_preferences:update' }
      });
    });
    return context.json({ id: user.id, displayLanguage });
  });

  // ------------------------------------------------------- R30 delivery dates
  app.patch('/api/film-supply-orders/:orderId/delivery-dates', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) return context.json(badPath('orderId'), 400);
    const [order] = await db.select({ id: filmSupplyOrders.id, projectId: filmSupplyOrders.projectId, deletedAt: filmSupplyOrders.deletedAt })
      .from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません', code: 'FILM_SUPPLY_ORDER_NOT_FOUND' }, 404);
    if (!canPerform(toActor(user), 'film_order:update_delivery_dates', 'F1', order.projectId).allowed) {
      return context.json(forbidden, 403);
    }
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const invalid = {
      error: '日付は「年-月-日」（例: 2026-12-01）の実在する日付で入力してください。変更する日付を 1 つ以上送ってください',
      code: 'DELIVERY_DATE_INVALID'
    };
    if (!body || typeof body !== 'object') return context.json(invalid, 422);
    const changes: { requestedDeliveryDate?: string | null; plannedDeliveryDate?: string | null } = {};
    for (const key of ['requestedDeliveryDate', 'plannedDeliveryDate'] as const) {
      if (!Object.hasOwn(body, key)) continue;
      const parsed = parseCalendarDate(body[key]);
      if (!parsed.ok) return context.json(invalid, 422);
      changes[key] = parsed.value;
    }
    if (Object.keys(changes).length === 0) return context.json(invalid, 422);
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).for('update');
      if (!locked || locked.deletedAt) return { kind: 'missing' as const };
      if (String(locked.status) === 'CANCELLED') return { kind: 'cancelled' as const };
      const [approved] = await tx.select({ id: makerPurchaseOrders.id }).from(makerPurchaseOrders)
        .where(approvedLivePaper(eq(makerPurchaseOrders.filmSupplyOrderId, orderId))).limit(1);
      if (approved) return { kind: 'locked' as const, makerPurchaseOrderId: approved.id };
      const before = { requestedDeliveryDate: locked.requestedDeliveryDate, plannedDeliveryDate: locked.plannedDeliveryDate };
      const after = { ...before, ...changes };
      await tx.update(filmSupplyOrders).set({ ...changes, updatedAt: now }).where(eq(filmSupplyOrders.id, orderId));
      await recordAuditEvent(tx, {
        projectId: locked.projectId,
        actorUserId: user.id,
        action: 'FILM_SUPPLY_ORDER_DELIVERY_DATES_UPDATED',
        entityType: 'film_supply_order',
        entityId: orderId,
        beforeState: { id: orderId, code: locked.code, status: locked.status, ...before },
        afterState: { id: orderId, code: locked.code, status: locked.status, ...after },
        occurredAt: now,
        requestMetadata: { operation: 'film_order:update_delivery_dates' }
      });
      return { kind: 'updated' as const, order: { id: orderId, code: locked.code, status: locked.status, ...after, updatedAt: now } };
    });
    if (outcome.kind === 'missing') return context.json({ error: 'フィルム発注が見つかりません', code: 'FILM_SUPPLY_ORDER_NOT_FOUND' }, 404);
    if (outcome.kind === 'cancelled') {
      return context.json({ error: '取消終了した発注の納期は変更できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }
    if (outcome.kind === 'locked') {
      return context.json({ ...DELIVERY_TERMS_LOCKED, makerPurchaseOrderId: outcome.makerPurchaseOrderId }, 409);
    }
    return context.json(outcome.order);
  });

  // ------------------------------------------- R30 seven PO quantity / amount
  async function loadSevenPo(poId: string) {
    const [po] = await db.select({ id: sevenPurchaseOrders.id, projectId: sevenPurchaseOrders.projectId, poNumber: sevenPurchaseOrders.poNumber })
      .from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    return po;
  }

  app.get('/api/seven-purchase-orders/:poId/order-facts', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) return context.json(badPath('poId'), 400);
    const po = await loadSevenPo(poId);
    if (!po) return context.json({ error: 'セブン発注書が見つかりません', code: 'SEVEN_PO_NOT_FOUND' }, 404);
    // Viewer reads statuses only (M7 S3); staff and auditor read the quantity; admin also the amount.
    if (user.role === 'viewer' || !canPerform(toActor(user), 'project:read', 'F1', po.projectId).allowed) {
      return context.json(forbidden, 403);
    }
    const [row] = await db.select().from(sevenPoOrderFacts).where(eq(sevenPoOrderFacts.sevenPurchaseOrderId, poId)).limit(1);
    return context.json({ poNumber: po.poNumber, ...orderFactsViewForRole(user.role, poId, row) });
  });

  app.put('/api/seven-purchase-orders/:poId/order-facts', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) return context.json(badPath('poId'), 400);
    const po = await loadSevenPo(poId);
    if (!po) return context.json({ error: 'セブン発注書が見つかりません', code: 'SEVEN_PO_NOT_FOUND' }, 404);
    if (!canPerform(toActor(user), 'seven_po:update_order_facts', 'F1', po.projectId).allowed) {
      return context.json(forbidden, 403);
    }
    const body = await context.req.json().catch(() => null);
    // The amount is the representative's: staff never read it, so never write it.
    const touchesAmount = body !== null && typeof body === 'object'
      && (Object.hasOwn(body, 'totalAmount') || Object.hasOwn(body, 'currency'));
    if (touchesAmount && !canPerform(toActor(user), 'seven_po:update_amount', 'F1', po.projectId).allowed) {
      return context.json({ error: 'セブン化学発注書の金額は代表者だけが入力できます', code: 'SEVEN_PO_AMOUNT_ADMIN_ONLY' }, 403);
    }
    const parsed = parseOrderFactsInput(body);
    if (!parsed.ok) return context.json({ error: parsed.message, code: 'SEVEN_PO_ORDER_FACTS_INVALID' }, 422);
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      // The seven PO row lock serializes two edits of the same facts, and the
      // approval share-locks the same row before it freezes the quantity.
      await tx.select({ id: sevenPurchaseOrders.id }).from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).for('update');
      if (parsed.value.quantity !== undefined) {
        const [approved] = await tx.select({ id: makerPurchaseOrders.id }).from(makerPurchaseOrders)
          .innerJoin(filmSupplyOrders, eq(filmSupplyOrders.id, makerPurchaseOrders.filmSupplyOrderId))
          .where(approvedLivePaper(eq(filmSupplyOrders.sevenPurchaseOrderId, poId))).limit(1);
        if (approved) return { kind: 'locked' as const, makerPurchaseOrderId: approved.id };
      }
      const [before] = await tx.select().from(sevenPoOrderFacts).where(eq(sevenPoOrderFacts.sevenPurchaseOrderId, poId)).limit(1);
      const next = {
        orderedQuantity: parsed.value.quantity === undefined ? before?.orderedQuantity ?? null : parsed.value.quantity?.orderedQuantity ?? null,
        orderedUnit: parsed.value.quantity === undefined ? before?.orderedUnit ?? null : parsed.value.quantity?.orderedUnit ?? null,
        totalAmount: parsed.value.amount === undefined ? before?.totalAmount ?? null : parsed.value.amount?.totalAmount ?? null,
        currency: parsed.value.amount === undefined ? before?.currency ?? null : parsed.value.amount?.currency ?? null
      };
      const [stored] = await tx.insert(sevenPoOrderFacts).values({
        sevenPurchaseOrderId: poId,
        ...next,
        createdByUserId: user.id,
        updatedByUserId: user.id,
        createdAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: sevenPoOrderFacts.sevenPurchaseOrderId,
        set: { ...next, updatedByUserId: user.id, updatedAt: now }
      }).returning();
      await recordAuditEvent(tx, {
        projectId: po.projectId,
        actorUserId: user.id,
        action: 'SEVEN_PO_ORDER_FACTS_UPDATED',
        entityType: 'seven_purchase_order',
        entityId: poId,
        // The audit views are allowlists: staff/auditor/viewer never see totalAmount/currency.
        beforeState: before
          ? { id: poId, poNumber: po.poNumber, orderedQuantity: before.orderedQuantity, orderedUnit: before.orderedUnit, totalAmount: before.totalAmount, currency: before.currency }
          : null,
        afterState: { id: poId, poNumber: po.poNumber, ...next },
        occurredAt: now,
        requestMetadata: { operation: touchesAmount ? 'seven_po:update_amount' : 'seven_po:update_order_facts' }
      });
      return { kind: 'stored' as const, row: stored! };
    });
    if (outcome.kind === 'locked') {
      return context.json({ ...DELIVERY_TERMS_LOCKED, makerPurchaseOrderId: outcome.makerPurchaseOrderId }, 409);
    }
    return context.json({ poNumber: po.poNumber, ...orderFactsViewForRole(user.role, poId, outcome.row) });
  });

  // --------------------------------------------------------- R33 maker master
  async function makerAccountWithAddresses(accountIds: string[], includeInactive: boolean) {
    if (accountIds.length === 0) return [];
    const makers = await db.select({ id: accounts.id, name: accounts.name, externalCode: accounts.externalCode, isActive: accounts.isActive })
      .from(accounts)
      .where(and(inArray(accounts.id, accountIds), eq(accounts.role, 'maker'), isNull(accounts.deletedAt)))
      .orderBy(asc(accounts.name));
    const addresses = makers.length === 0 ? [] : await db.select({
      id: makerRecipientAddresses.id,
      accountId: makerRecipientAddresses.accountId,
      email: makerRecipientAddresses.email,
      label: makerRecipientAddresses.label,
      isDefault: makerRecipientAddresses.isDefault,
      isActive: makerRecipientAddresses.isActive,
      updatedAt: makerRecipientAddresses.updatedAt
    }).from(makerRecipientAddresses)
      .where(and(
        inArray(makerRecipientAddresses.accountId, makers.map((maker) => maker.id)),
        includeInactive ? undefined : eq(makerRecipientAddresses.isActive, true)
      ))
      .orderBy(desc(makerRecipientAddresses.isDefault), asc(makerRecipientAddresses.email));
    return makers.map((maker) => ({
      ...maker,
      recipientAddresses: addresses.filter((address) => address.accountId === maker.id).map(({ accountId: _accountId, ...rest }) => rest)
    }));
  }

  /** The maker of an assigned project and its usable addresses (the maker PO form's choices). */
  app.get('/api/projects/:projectId/maker-recipient-addresses', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    const projectId = context.req.param('projectId');
    if (!isUuid(projectId)) return context.json(badPath('projectId'), 400);
    if (!canPerform(toActor(user), 'maker_recipient:read', 'F1', projectId).allowed) return context.json(forbidden, 403);
    const [project] = await db.select({ makerAccountId: projects.makerAccountId, deletedAt: projects.deletedAt })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません', code: 'PROJECT_NOT_FOUND' }, 404);
    const [maker] = await makerAccountWithAddresses([project.makerAccountId], false);
    return context.json({ projectId, maker: maker ?? null });
  });

  app.get('/api/maker-accounts', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    if (!canPerform(toActor(user), 'maker_master:manage', 'F1').allowed) {
      return context.json({ error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' }, 403);
    }
    const ids = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.role, 'maker'), isNull(accounts.deletedAt)));
    return context.json({ makers: await makerAccountWithAddresses(ids.map((row) => row.id), true) });
  });

  app.post('/api/maker-accounts', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    if (!canPerform(toActor(user), 'maker_master:manage', 'F1').allowed) {
      return context.json({ error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' }, 403);
    }
    const body = await context.req.json().catch(() => null) as { name?: unknown; externalCode?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const externalCode = body?.externalCode === undefined || body?.externalCode === null || body?.externalCode === ''
      ? null
      : typeof body.externalCode === 'string' && body.externalCode.trim().length > 0 && body.externalCode.trim().length <= 64
        ? body.externalCode.trim()
        : undefined;
    if (name.length === 0 || name.length > 200 || externalCode === undefined) {
      return context.json({ error: '製造先の名前（200 文字まで）を入力してください。取引先コードは 64 文字までです', code: 'MAKER_ACCOUNT_INVALID' }, 422);
    }
    const now = new Date();
    const account = {
      id: uuidv7(now), name, role: 'maker' as const, externalCode, contactEmail: null, isActive: true, createdAt: now, updatedAt: now
    };
    await db.transaction(async (tx) => {
      await tx.insert(accounts).values(account);
      await recordAuditEvent(tx, {
        projectId: null,
        actorUserId: user.id,
        action: 'MAKER_ACCOUNT_CREATED',
        entityType: 'account',
        entityId: account.id,
        afterState: { id: account.id, name, role: 'maker', externalCode },
        occurredAt: now,
        requestMetadata: { operation: 'maker_master:manage' }
      });
    });
    return context.json({ id: account.id, name, externalCode, isActive: true, recipientAddresses: [] }, 201);
  });

  app.post('/api/maker-accounts/:accountId/recipient-addresses', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    if (!canPerform(toActor(user), 'maker_master:manage', 'F1').allowed) {
      return context.json({ error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' }, 403);
    }
    const accountId = context.req.param('accountId');
    if (!isUuid(accountId)) return context.json(badPath('accountId'), 400);
    const [maker] = await db.select({ id: accounts.id, role: accounts.role, isActive: accounts.isActive, deletedAt: accounts.deletedAt })
      .from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!maker || maker.deletedAt || maker.role !== 'maker' || !maker.isActive) {
      return context.json({ error: '製造先が見つかりません', code: 'MAKER_ACCOUNT_NOT_FOUND' }, 404);
    }
    const body = await context.req.json().catch(() => null) as { email?: unknown; label?: unknown; isDefault?: unknown } | null;
    const email = normalizeRecipientEmail(body?.email);
    if (!email.ok) return context.json({ error: email.message, code: email.code }, 422);
    const label = parseLabel(body?.label);
    if (!label.ok || (body?.isDefault !== undefined && typeof body?.isDefault !== 'boolean')) {
      return context.json({ error: '表示名は 100 文字まで、既定の宛先は「はい」か「いいえ」で指定してください', code: 'MAKER_RECIPIENT_ADDRESS_INVALID' }, 422);
    }
    const isDefault = body?.isDefault === true;
    const now = new Date();
    const row = {
      id: uuidv7(now), accountId, email: email.email, label: label.value, isDefault, isActive: true,
      createdByUserId: user.id, updatedByUserId: user.id, createdAt: now, updatedAt: now
    };
    try {
      await db.transaction(async (tx) => {
        // The maker row lock serializes default changes of one maker.
        await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for('update');
        if (isDefault) {
          await tx.update(makerRecipientAddresses).set({ isDefault: false, updatedByUserId: user.id, updatedAt: now })
            .where(and(eq(makerRecipientAddresses.accountId, accountId), eq(makerRecipientAddresses.isDefault, true)));
        }
        await tx.insert(makerRecipientAddresses).values(row);
        await recordAuditEvent(tx, {
          projectId: null,
          actorUserId: user.id,
          action: 'MAKER_RECIPIENT_ADDRESS_CREATED',
          entityType: 'maker_recipient_address',
          entityId: row.id,
          afterState: { id: row.id, accountId, email: row.email, label: row.label, isDefault, isActive: true },
          occurredAt: now,
          requestMetadata: { operation: 'maker_master:manage' }
        });
      });
    } catch (error) {
      if (postgresCode(error) === '23505') {
        return context.json({ error: 'このメールアドレスはこの製造先にすでに登録されています', code: 'DUPLICATE', field: 'email' }, 409);
      }
      throw error;
    }
    const { createdByUserId: _c, updatedByUserId: _u, ...view } = row;
    return context.json(view, 201);
  });

  app.patch('/api/maker-recipient-addresses/:addressId', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    if (!canPerform(toActor(user), 'maker_master:manage', 'F1').allowed) {
      return context.json({ error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' }, 403);
    }
    const addressId = context.req.param('addressId');
    if (!isUuid(addressId)) return context.json(badPath('addressId'), 400);
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const invalid = { error: '表示名は 100 文字まで、既定の宛先・使用中は「はい」か「いいえ」で指定してください', code: 'MAKER_RECIPIENT_ADDRESS_INVALID' };
    if (!body || typeof body !== 'object') return context.json(invalid, 422);
    const changes: { label?: string | null; isDefault?: boolean; isActive?: boolean } = {};
    if (Object.hasOwn(body, 'label')) {
      const label = parseLabel(body.label);
      if (!label.ok) return context.json(invalid, 422);
      changes.label = label.value;
    }
    for (const key of ['isDefault', 'isActive'] as const) {
      if (!Object.hasOwn(body, key)) continue;
      if (typeof body[key] !== 'boolean') return context.json(invalid, 422);
      changes[key] = body[key] as boolean;
    }
    if (Object.keys(changes).length === 0) return context.json(invalid, 422);
    // Deactivating an address also ends its default role.
    if (changes.isActive === false) changes.isDefault = false;
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(makerRecipientAddresses).where(eq(makerRecipientAddresses.id, addressId)).limit(1);
      if (!current) return null;
      await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, current.accountId)).for('update');
      const [locked] = await tx.select().from(makerRecipientAddresses).where(eq(makerRecipientAddresses.id, addressId)).for('update');
      if (!locked) return null;
      const next = {
        label: changes.label === undefined ? locked.label : changes.label,
        isActive: changes.isActive === undefined ? locked.isActive : changes.isActive,
        isDefault: changes.isDefault === undefined ? locked.isDefault : changes.isDefault
      };
      if (next.isDefault && !next.isActive) return { kind: 'invalid' as const };
      if (next.isDefault && !locked.isDefault) {
        await tx.update(makerRecipientAddresses).set({ isDefault: false, updatedByUserId: user.id, updatedAt: now })
          .where(and(eq(makerRecipientAddresses.accountId, locked.accountId), eq(makerRecipientAddresses.isDefault, true)));
      }
      await tx.update(makerRecipientAddresses).set({ ...next, updatedByUserId: user.id, updatedAt: now })
        .where(eq(makerRecipientAddresses.id, addressId));
      await recordAuditEvent(tx, {
        projectId: null,
        actorUserId: user.id,
        action: 'MAKER_RECIPIENT_ADDRESS_UPDATED',
        entityType: 'maker_recipient_address',
        entityId: addressId,
        beforeState: { id: addressId, accountId: locked.accountId, email: locked.email, label: locked.label, isDefault: locked.isDefault, isActive: locked.isActive },
        afterState: { id: addressId, accountId: locked.accountId, email: locked.email, ...next },
        occurredAt: now,
        requestMetadata: { operation: 'maker_master:manage' }
      });
      return { kind: 'updated' as const, view: { id: addressId, accountId: locked.accountId, email: locked.email, ...next, updatedAt: now } };
    });
    if (!outcome) return context.json({ error: '宛先が見つかりません', code: 'MAKER_RECIPIENT_ADDRESS_NOT_FOUND' }, 404);
    if (outcome.kind === 'invalid') return context.json({ error: '使用しない宛先は既定の宛先にできません', code: 'MAKER_RECIPIENT_ADDRESS_INVALID' }, 422);
    return context.json(outcome.view);
  });

  // ------------------------------------------------- P-2 evidence metadata
  /**
   * Evidence metadata of one project: what was uploaded (type, issuer, file
   * name, sha256, size, detected type), bound to which order/design/maker PO,
   * by whom and when, and who verified it when. Never the bytes, the storage
   * path, or the free-text notes (they may carry amounts). Auditor, staff and
   * admin on an assigned project; viewer is refused (M7 S3: no evidence detail).
   */
  app.get('/api/projects/:projectId/evidence-metadata', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json(unauthorized, 401);
    const projectId = context.req.param('projectId');
    if (!isUuid(projectId)) return context.json(badPath('projectId'), 400);
    const [project] = await db.select({ id: projects.id, deletedAt: projects.deletedAt }).from(projects)
      .where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) return context.json({ error: '案件が見つかりません', code: 'PROJECT_NOT_FOUND' }, 404);
    if (!canPerform(toActor(user), 'evidence_metadata:read', 'F1', projectId).allowed) return context.json(forbidden, 403);

    const query = context.req.query();
    const requestedLimit = Number(query.limit ?? '200');
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 200;
    const orderFilter = isUuid(query.filmSupplyOrderId) ? eq(documents.filmSupplyOrderId, query.filmSupplyOrderId) : undefined;
    const rows = await db.select({
      documentId: documents.id,
      documentType: documents.documentType,
      issuerEntity: documents.issuerEntity,
      originalFilename: documents.originalFilename,
      filmSupplyOrderId: documents.filmSupplyOrderId,
      orderCode: filmSupplyOrders.code,
      designKey: documents.designKey,
      makerPurchaseOrderId: documents.makerPurchaseOrderId,
      sevenPurchaseOrderId: documents.sevenPurchaseOrderId,
      verificationStatus: documents.verificationStatus,
      verifiedAt: documents.verifiedAt,
      verifiedByUserId: documents.verifiedByUserId,
      createdAt: documents.createdAt,
      createdByUserId: documents.createdByUserId
    }).from(documents)
      .leftJoin(filmSupplyOrders, eq(filmSupplyOrders.id, documents.filmSupplyOrderId))
      .where(and(eq(documents.projectId, projectId), orderFilter))
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.documentId);
    const versions = ids.length === 0 ? [] : await db.select({
      versionId: documentVersions.id,
      documentId: documentVersions.documentId,
      versionNumber: documentVersions.versionNumber,
      originalFilename: documentVersions.originalFilename,
      sha256: documentVersions.sha256,
      byteSize: documentVersions.byteSize,
      detectedMimeType: documentVersions.detectedMimeType,
      uploadedByUserId: documentVersions.createdByUserId,
      uploadedAt: documentVersions.createdAt
    }).from(documentVersions)
      .where(inArray(documentVersions.documentId, ids))
      .orderBy(asc(documentVersions.documentId), asc(documentVersions.versionNumber));
    // Only a send_evidence version is ever cited by a SEND_EVIDENCE_REGISTERED event.
    const sendVerification = await sendVerificationByVersion(versions.map((version) => version.versionId));
    const personIds = [...new Set([
      ...page.flatMap((row) => [row.createdByUserId, row.verifiedByUserId]),
      ...versions.map((version) => version.uploadedByUserId)
    ].filter((id): id is string => typeof id === 'string'))];
    const people = personIds.length === 0 ? [] : await db.select({ id: users.id, displayName: users.displayName, role: users.role })
      .from(users).where(inArray(users.id, personIds));
    // Security review L3: a quote's file name may carry its price (見積_¥1,200,000.pdf),
    // so the auditor sees that a quote exists, its hash and who filed it — not its name.
    const hideFilename = (documentType: string) => user.role === 'auditor' && AUDITOR_HIDDEN_FILENAME_TYPES.has(documentType);
    const person = (id: string | null) => {
      const found = id ? people.find((candidate) => candidate.id === id) : undefined;
      return found ? { id: found.id, displayName: found.displayName, role: found.role } : null;
    };
    return context.json({
      projectId,
      limit,
      truncated: rows.length > limit,
      documents: page.map((row) => ({
        documentId: row.documentId,
        documentType: row.documentType,
        issuerEntity: row.issuerEntity,
        originalFilename: hideFilename(row.documentType) ? null : row.originalFilename,
        originalFilenameHidden: hideFilename(row.documentType),
        filmSupplyOrderId: row.filmSupplyOrderId,
        orderCode: row.orderCode ?? null,
        designKey: row.designKey,
        makerPurchaseOrderId: row.makerPurchaseOrderId,
        sevenPurchaseOrderId: row.sevenPurchaseOrderId,
        verificationStatus: row.verificationStatus,
        verifiedAt: row.verifiedAt,
        verifiedBy: person(row.verifiedByUserId),
        createdAt: row.createdAt,
        createdBy: person(row.createdByUserId),
        versions: versions.filter((version) => version.documentId === row.documentId).map((version) => ({
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          originalFilename: hideFilename(row.documentType) ? null : version.originalFilename,
          sha256: version.sha256,
          byteSize: version.byteSize,
          detectedMimeType: version.detectedMimeType,
          uploadedAt: version.uploadedAt,
          uploadedBy: person(version.uploadedByUserId),
          // p6 X3: a send_evidence version's send check, apart from the document check (null: not a send evidence, or not cited).
          sendVerification: sendVerification.get(version.versionId) ?? null
        }))
      }))
    });
  });

  /**
   * p6 X3: the send check of each cited send-evidence version — the latest SEND_EVIDENCE_REGISTERED
   * event that cites it: `auto_verified` (VERIFIED), `manual_pending` (PENDING_MANUAL_VERIFICATION
   * with no manual check yet), `manual_confirmed` / `manual_rejected` (the latest manual check's
   * result). Results only — never the reason, the checks or an address.
   */
  async function sendVerificationByVersion(versionIds: string[]): Promise<Map<string, SendVerificationState>> {
    const out = new Map<string, SendVerificationState>();
    if (versionIds.length === 0) return out;
    const events = await db.select({
      id: makerPoEvents.id,
      versionId: makerPoEvents.evidenceDocumentVersionId,
      verificationStatus: makerPoEvents.verificationStatus
    }).from(makerPoEvents)
      .where(and(eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED'), inArray(makerPoEvents.evidenceDocumentVersionId, versionIds)))
      .orderBy(asc(makerPoEvents.recordedAt), asc(makerPoEvents.id));
    // A manual check is only ever recorded on a send that was not VERIFIED.
    const eventIds = events.map((event) => event.id);
    const checks = eventIds.length === 0 ? [] : await db.select({
      eventId: makerPoSendManualVerifications.makerPoEventId,
      result: makerPoSendManualVerifications.result
    }).from(makerPoSendManualVerifications)
      .where(inArray(makerPoSendManualVerifications.makerPoEventId, eventIds))
      .orderBy(asc(makerPoSendManualVerifications.recordedAt), asc(makerPoSendManualVerifications.id));
    const latestCheck = new Map(checks.map((check) => [check.eventId, check.result]));
    for (const event of events) {
      // Every row cites one of versionIds (the where clause); an UNVERIFIED send cites no version at all.
      const check = latestCheck.get(event.id);
      out.set(event.versionId as string, event.verificationStatus === 'VERIFIED'
        ? 'auto_verified'
        : check === 'confirmed' ? 'manual_confirmed' : check === 'rejected' ? 'manual_rejected' : 'manual_pending');
    }
    return out;
  }

}
