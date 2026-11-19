import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  buildMakerPoSnapshot,
  canPerform,
  canWriteSevenPoOfficialDate,
  classifyMakerPoCancellation,
  computeMakerPoSnapshotSha256,
  deriveOrderApprovalGate,
  evaluateApprovalEvidenceBinding,
  evaluateApprovalEvidenceIdentifierForBytes,
  evaluateCommissionReadiness,
  evaluateDeliveryEvidence,
  evaluateFilmReceiptAssumption,
  evaluateMakerPoAcceptEvidence,
  evaluateMakerPoApproval,
  evaluateMakerPoCancellation,
  evaluateMakerPoCancellationAckGate,
  evaluateMakerPoCreationGate,
  evaluateMakerPoSendEvidence,
  evaluateMakerPoSendTransition,
  evaluateMakerPoSentAtCurrency,
  evaluatePaymentGate,
  evaluateRevisionRegistrationGate,
  evaluateSevenPoChecklist,
  evaluateSevenPoPrecedenceGate,
  extractStoredEmlMessageId,
  DEFAULT_PAYMENT_TERMS,
  makerChainTransitionRefusal,
  normalizePaymentTerms,
  validatePaymentTermsInput,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  fillingDeliveryConfirmationState,
  hasApprovalHistoryForDesign,
  isArtworkBoundDocumentType,
  isCommissionCalculationAllowed,
  isExceptionFilmSupplyOrderState,
  isLegacyHoldReleaseTarget,
  isOfficialArtifactDocumentType,
  isFrozenFilmOrderStatus,
  isTerminalFilmSupplyOrderState,
  japaneseStatusSurface,
  shouldAdvanceToDualApproved,
  resolveCancellationReview,
  toQuantityString,
  transitionFilmSupplyOrder,
  transitionMakerPurchaseOrder,
  validateApprovalDecision,
  validateApprovalEvidenceSource,
  validateApprovalOrganization,
  validateDocumentType,
  validateEvidenceVerificationResult,
  validateIssuerEntity,
  validateMakerPoStatus,
  validateProjectRoute,
  validateQuantity,
  validateUnit,
  type ApprovalEventView,
  type ApprovalOrganization,
  type ArtworkRevisionView,
  type EvidenceVerificationView,
  type DocumentType,
  type FilmSupplyOrderState,
  type FilmOrderStatus,
  type IssuerEntity,
  type MakerPoEvidenceDocument,
  type MakerPoSnapshot,
  type MakerPoSnapshotArtworkFile,
  type MeasureUnit,
  type NormalFilmSupplyOrderState,
  type UnitDomain,
  type EvidenceIdentifierStatus
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
  evidenceManualVerifications,
  filmDeliveries,
  filmSupplyOrderLines,
  filmSupplyOrders,
  fillingDeliveries,
  fillingOrderLines,
  fillingOrders,
  makerPoEvents,
  makerPoSendManualVerifications,
  makerPurchaseOrders,
  preOrderReferences,
  projectAssignments,
  projects,
  sevenPurchaseOrders,
  sessions,
  users
} from '@kanei/db/schema';
import { uuidv7 } from '@kanei/db';
import { getSessionUser, issueToken, readSessionToken, toActor, type AppDatabase } from './auth.js';
import {
  computeSha256,
  documentMaxBytes,
  documentStorageRoot,
  evaluateDocumentContent,
  writeStoredFile,
  type DocumentContentCheck
} from './document-storage.js';
import { hashPassword, verifyPassword } from './password.js';
import { buildAuditViewForRole, type AuditHistoryRow } from './audit-view.js';
import {
  buildMakerPoEventViewForRole,
  buildMakerPoViewForRole,
  type MakerPoEventRecord,
  type MakerPoRecord
} from './maker-po-view.js';

export interface AppOptions {
  db: AppDatabase;
  secureCookies?: boolean;
  allowedOrigins?: readonly string[];
  trustProxy?: boolean;
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

/** Thrown when two release calls race; the loser answers without writing. */
class HoldReleaseStateConflict extends Error {}

class FilmOrderTransitionConflict extends Error {}
class HoldReleaseOriginUnknown extends Error {}
class HoldReleaseTargetInvalid extends Error {}
class HoldReleaseEvidenceMismatch extends Error {}
class CancellationReviewStateConflict extends Error {}
class CancellationReviewEvidenceMismatch extends Error {}
class CancellationReviewResolutionInvalid extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

class OfficialRegistrationForbidden extends Error {}
class OfficialRegistrationRace extends Error {}
class OfficialRegistrationReviewPending extends Error {}
class OfficialRegistrationNotVerified extends Error {}

const REASON_MAX_LENGTH = 1000;
const REASON_RAW_MAX_LENGTH = 10000;

/**
 * Remove control/format/variation/combing-mark and non-space blanks before
 * measuring actual visible content. Ordinary spaces remain separators; every
 * other space separator becomes one, so NBSP cannot masquerade as visibility.
 */
function normalizeRequiredReason(
  value: unknown,
  maxLength = REASON_MAX_LENGTH
): { ok: true; text: string } | { ok: false; tooLong: boolean } {
  if (typeof value !== 'string') return { ok: false, tooLong: false };
  if (value.length > REASON_RAW_MAX_LENGTH) return { ok: false, tooLong: true };
  // Storage preserves visible combining marks for scripts such as Thai and
  // Hindi. A separate validation copy strips marks that are not attached to a
  // visible base character, so combining-only strings cannot pass.
  const stored = (value as string)
    .normalize('NFC')
    .replace(/\p{Zs}/gu, ' ')
    .replace(/[\p{C}\u{115F}-\u{11FF}\u{3164}\u{2800}\u{FFA0}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const visibleText = stored.replace(/\p{M}/gu, '');
  const visibleLength = [...visibleText].length;
  if (visibleLength === 0) return { ok: false, tooLong: false };
  if (visibleLength > maxLength) return { ok: false, tooLong: true };
  return { ok: true, text: stored };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function optionalUuidInput(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || value.length === 0 || !isUuid(value)) return { ok: false };
  return { ok: true, value };
}

const ISO_DATE_WITH_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDateWithOffset(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_WITH_OFFSET_PATTERN.test(value);
}

function postgresErrorCode(value: unknown): string | null {
  let current: unknown = value;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return null;
}

function isPostgresDeadlockError(value: unknown): boolean {
  return postgresErrorCode(value) === '40P01';
}

function filmSupplyOrderStateForValue(value: unknown): NormalFilmSupplyOrderState | undefined {
  if (typeof value !== 'string') return undefined;
  const index = (FILM_SUPPLY_ORDER_STATES as readonly string[]).indexOf(value);
  return index >= 0 ? FILM_SUPPLY_ORDER_STATES[index] : undefined;
}

type OrderLineValidation =
  | { ok: true; line: OrderLineInput }
  | { ok: false; code: string; message: string };

/** Database executor that can read: the pool or one open transaction. */
type MakerPoQueryExecutor = Pick<AppDatabase, 'select'>;

/** Database executor that can read and append audit/event rows. */
type MakerPoReadWriteExecutor = MakerPoQueryExecutor & AuditEventWriter;

/** Database executor that can write audit rows: the pool or one open transaction. */
type AuditEventWriter = Pick<AppDatabase, 'insert'>;

/** One open transaction of the maker-PO write paths (reads, writes, audit rows). */
type MakerPoTxExecutor = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/**
 * One audit_events row: what happened, to which entity, and in which project.
 * The project is not derivable from the entity at read time without one EXISTS
 * per audited entity family, so the caller — which already holds the project it
 * is acting on — states it here and the row carries it (migration 0013).
 */
interface AuditEventInput {
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
 * Progressive maker-PO work re-reads the film order under the transaction's
 * row lock before its mirror. If the order was frozen or moved concurrently,
 * the whole paper transition rolls back rather than leaving a progressive paper
 * ahead of a stale/closed order.
 */
async function mirrorMakerPoFilmOrderTransition(
  tx: MakerPoTxExecutor,
  input: {
    projectId: string;
    actorUserId: string;
    filmSupplyOrderId: string;
    expectedStatus: FilmOrderStatus;
    nextStatus: FilmOrderStatus;
    operation: string;
    reason: string;
    occurredAt: Date;
  }
): Promise<boolean> {
  const [lockedOrder] = await tx.select().from(filmSupplyOrders)
    .where(eq(filmSupplyOrders.id, input.filmSupplyOrderId)).limit(1).for('update');
  if (!lockedOrder || lockedOrder.deletedAt || String(lockedOrder.status) !== String(input.expectedStatus)) {
    throw new MakerPoStateConflict();
  }
  if (isFrozenFilmOrderStatus(lockedOrder.status)) throw new MakerPoStateConflict();
  if (!transitionFilmSupplyOrder(lockedOrder.status, input.nextStatus).ok) return false;

  const mirrored = await tx.update(filmSupplyOrders)
    .set({ status: input.nextStatus, updatedAt: input.occurredAt })
    .where(and(
      eq(filmSupplyOrders.id, lockedOrder.id),
      eq(filmSupplyOrders.status, lockedOrder.status)
    ))
    .returning({ id: filmSupplyOrders.id });
  if (mirrored.length === 0) throw new MakerPoStateConflict();
  await recordAuditEvent(tx, {
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
    entityType: 'film_supply_order',
    entityId: lockedOrder.id,
    beforeState: { status: lockedOrder.status },
    afterState: { status: input.nextStatus },
    occurredAt: input.occurredAt,
    requestMetadata: { operation: input.operation, reason: input.reason }
  });
  return true;
}

/**
 * Every maker-paper write takes the order lock first and the paper lock second.
 * This keeps recovery endpoints (order → paper) and progressive endpoints from
 * acquiring the same resources in opposite orders.
 */
async function lockMakerPoOrderForProgressive(
  tx: MakerPoTxExecutor,
  input: { filmSupplyOrderId: string; expectedStatus: FilmOrderStatus }
) {
  const [lockedOrder] = await tx.select().from(filmSupplyOrders)
    .where(eq(filmSupplyOrders.id, input.filmSupplyOrderId)).limit(1).for('update');
  if (!lockedOrder || lockedOrder.deletedAt || String(lockedOrder.status) !== String(input.expectedStatus)) {
    throw new MakerPoStateConflict();
  }
  if (isFrozenFilmOrderStatus(lockedOrder.status)) throw new MakerPoStateConflict();
  return lockedOrder;
}

/**
 * M8-HARDEN FIX B2: the create lost the one-active-maker-PO unique index
 * (maker_purchase_orders_active_order_unique). The driver reports SQLSTATE
 * 23505 and names the constraint, and drizzle wraps the driver error, so both
 * the code and the constraint name are read through the cause chain.
 */
function makerPoActiveUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.constraint === 'maker_purchase_orders_active_order_unique') return true;
    if (candidate.code === '23505'
      && (candidate.constraint === undefined || typeof candidate.constraint !== 'string')) return true;
    current = candidate.cause;
  }
  return false;
}

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

function parseStrictRequiredDate(value: unknown): { ok: true; date: Date } | { ok: false } {
  if (!isIsoDateWithOffset(value)) return { ok: false };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { ok: false };
  // Date accepts calendar overflows (Feb 30 becomes Mar 2). Compare the
  // calendar fields in the instant named by the input offset (JST 00:30 is a
  // real local date even though its UTC instant falls on the prior day).
  const [calendar] = value.split('T');
  const [year, month, day] = calendar!.split('-').map(Number);
  const offsetMatch = /(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!offsetMatch) return { ok: false };
  // For `Z`, the sign/minute groups are undefined; compute their values only
  // for numeric offsets so an UTC suffix can never produce NaN.
  const offsetMinutes = offsetMatch[1] === undefined
    ? 0
    : (offsetMatch[1] === '-' ? -1 : 1)
      * ((Number(offsetMatch[2]) * 60) + Number(offsetMatch[3]));
  const localInstant = new Date(date.getTime() + (offsetMinutes * 60_000));
  if (localInstant.getUTCFullYear() !== year
    || localInstant.getUTCMonth() + 1 !== month
    || localInstant.getUTCDate() !== day) {
    return { ok: false };
  }
  return { ok: true, date };
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Browser CSRF defense for this cookie+JSON API: SameSite=Lax blocks ordinary
 * cross-site POST cookies, and any browser-supplied Origin must be this API or
 * one explicit deployment origin. Non-browser clients may omit Origin.
 */
export function isBrowserOriginAllowed(
  request: Request,
  options: { allowedOrigins?: readonly string[]; trustProxy?: boolean } = {}
): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = options.trustProxy
      ? request.headers.get('x-forwarded-host')
      : null;
    const forwardedProto = options.trustProxy
      ? request.headers.get('x-forwarded-proto')
      : null;
    const host = forwardedHost ?? request.headers.get('host');
    const protocol = forwardedProto?.split(',')[0]?.trim()
      ?? new URL(request.url).protocol.replace(/:$/, '');
    if (host && `${originUrl.protocol.replace(/:$/, '')}://${host}` === `${protocol}://${host}`) {
      return origin === `${protocol}://${host}` || options.allowedOrigins?.includes(origin) === true;
    }
  } catch {
    return false;
  }
  return options.allowedOrigins?.includes(origin) ?? false;
}

const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

function loginGuardIdentity(username: string, remoteAddress: string) {
  return createHash('sha256')
    .update(['login_guard_v1', username.trim().toLowerCase(), remoteAddress].join('\0'))
    .digest('hex');
}

function clientAddress(context: { req: { raw: Request } }, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = context.req.raw.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
    const real = context.req.raw.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  // In Hono's test client no socket is exposed; production uses the socket
  // through the node adapter. A stable unknown value cannot split one source
  // into many identities, so the account-side limit still applies.
  return (context as { env?: { incoming?: { socket?: { remoteAddress?: string } } } })
    .env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Executor that can read inside the pool or one open transaction. */
type TransitionQueryExecutor = Pick<AppDatabase, 'select'>;

/**
 * Reads the normal status recorded by the latest append-only transition into an
 * exception. Callers must already hold the order row lock when this decides a
 * release, so a concurrent re-hold cannot change the origin under them.
 */
async function loadExceptionOrigin(
  executor: TransitionQueryExecutor,
  orderId: string,
  exceptionState: 'ON_HOLD' | 'CANCELLATION_REVIEW'
): Promise<NormalFilmSupplyOrderState | undefined> {
  const [event] = await executor.select({
    beforeState: auditEvents.beforeState,
    afterState: auditEvents.afterState
  }).from(auditEvents)
    .where(and(
      eq(auditEvents.entityType, 'film_supply_order'),
      eq(auditEvents.entityId, orderId),
      eq(auditEvents.action, 'FILM_SUPPLY_ORDER_TRANSITIONED'),
      sql`${auditEvents.afterState} ->> 'status' = ${exceptionState}`
    ))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(1);
  if ((event?.afterState as { status?: unknown } | null)?.status !== exceptionState) return undefined;
  return filmSupplyOrderStateForValue((event?.beforeState as { status?: unknown } | null)?.status);
}

export function createApp({
  db,
  secureCookies = false,
  allowedOrigins = [],
  trustProxy = false
}: AppOptions) {
  const app = new Hono<AuthContext>();

  app.use('*', async (context, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)) return next();
    if (isBrowserOriginAllowed(context.req.raw, { allowedOrigins, trustProxy })) return next();
    return context.json({
      error: 'オリジンが許可されていません',
      code: 'CSRF_ORIGIN_REJECTED'
    }, 403);
  });

  // Any row-lock deadlock is a retryable concurrency conflict, not a server
  // fault. PostgreSQL rolls the transaction back before this handler runs.
  app.onError((error, context) => {
    if (isPostgresDeadlockError(error)) {
      return context.json({
        error: '発注状態の処理でロック競合が発生しました',
        code: 'FILM_ORDER_LOCK_CONFLICT'
      }, 409);
    }
    // Hono's default handler does not run after an onError rethrow with the
    // node-server adapter; logging here restores observability and preserves a
    // stable JSON body without leaking stack or SQL details.
    console.error(error);
    return context.json({ error: 'サーバーエラーが発生しました', code: 'INTERNAL_ERROR' }, 500);
  });

  app.get('/api/health', (context) => context.json({ status: 'ok', app: 'api', port: 3081 }));

  app.post('/api/auth/login', async (context) => {
    const body = await context.req.json().catch(() => null) as {
      username?: unknown;
      password?: unknown;
    } | null;
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      return context.json({ error: 'ユーザー名とパスワードが必要です' }, 400);
    }

    const remoteAddress = clientAddress(context, trustProxy);
    const guardEntityId = loginGuardIdentity(body.username, remoteAddress);
    const now = new Date();
    const recentFailures = await db.select({
      occurredAt: auditEvents.occurredAt
    }).from(auditEvents)
      .where(and(
        eq(auditEvents.action, 'LOGIN_FAILED'),
        eq(auditEvents.entityType, 'login_guard'),
        eq(auditEvents.entityId, guardEntityId),
        sql`${auditEvents.occurredAt} > now() - interval '${sql.raw(String(Math.round(LOGIN_FAILURE_WINDOW_MS / 1000)))} seconds'`
      ))
      .orderBy(desc(auditEvents.occurredAt));
    const latestFailureAt = recentFailures[0]?.occurredAt;
    if (recentFailures.length >= LOGIN_FAILURE_LIMIT
      && latestFailureAt
      && now.getTime() - latestFailureAt.getTime() < LOGIN_LOCKOUT_MS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((latestFailureAt.getTime() + LOGIN_LOCKOUT_MS - now.getTime()) / 1000)
      );
      return context.json({
        error: '試行回数が多いため、しばらくしてから再試行してください',
        code: 'LOGIN_TEMPORARILY_LOCKED',
        retryAfterSeconds
      }, 429);
    }

    const [user] = await db.select().from(users).where(eq(users.username, body.username)).limit(1);
    if (!user || !user.isActive || user.deletedAt || !(await verifyPassword(body.password, user.passwordHash))) {
      await recordAuditEvent(db, {
        projectId: null,
        actorUserId: null,
        action: 'LOGIN_FAILED',
        entityType: 'login_guard',
        entityId: guardEntityId,
        beforeState: null,
        afterState: {
          reason: 'invalid_credentials_or_inactive_user',
          observedAt: now.toISOString()
        },
        occurredAt: now,
        requestMetadata: { operation: 'auth:login_failed', remoteAddress }
      });
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

    const outcome = await db.transaction(async (tx) => {
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

  // M8-UI3: the list the operator-UI project selector reads. It answers exactly
  // the projects the caller may already open by id (admin: every non-deleted
  // project; staff / viewer: only the project_assignments rows they hold), so
  // the dropdown is UI support for the existing permission model — a role that
  // cannot read a project never learns that it exists. Only the fields the
  // selector renders are returned.
  app.get('/api/projects', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);

    const selectorColumns = {
      id: projects.id,
      code: projects.code,
      name: projects.name,
      status: projects.status
    };
    const rows = user.role === 'admin'
      ? await db.select(selectorColumns).from(projects)
          .where(isNull(projects.deletedAt))
          .orderBy(asc(projects.code))
      : await db.select(selectorColumns).from(projects)
          .innerJoin(projectAssignments, eq(projectAssignments.projectId, projects.id))
          .where(and(eq(projectAssignments.userId, user.id), isNull(projects.deletedAt)))
          .orderBy(asc(projects.code));

    return context.json({ projects: rows });
  });

  app.get('/api/projects/:projectId', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
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
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
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
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [current] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    if (!current) return context.json({ error: 'セブン発注書が見つかりません' }, 404);
    const isOverwrite = current.officialRegisteredAt !== null;
    const decision = canPerform(
      toActor(user),
      isOverwrite ? 'seven_po:register_overwrite' : 'seven_po:register',
      'F1',
      current.projectId
    );
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const registeredAt = parseRequiredDate(body?.officialRegisteredAt);
    if (!registeredAt.ok) return context.json({ error: '公式登録日が必要です', code: 'OFFICIAL_REGISTRATION_REQUIRED' }, 422);

    const actor = toActor(user);
    const initiallyUnregistered = current.officialRegisteredAt === null;
    let written: typeof current | null = null;
    let operation: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(sevenPurchaseOrders)
          .where(eq(sevenPurchaseOrders.id, poId)).limit(1).for('update');
        if (!locked) throw new OfficialRegistrationRace();
        if (initiallyUnregistered && locked.officialRegisteredAt !== null) {
          throw new OfficialRegistrationRace();
        }
        const decision = canWriteSevenPoOfficialDate(
          actor,
          locked.officialRegisteredAt,
          'F1',
          locked.projectId
        );
        if (!decision.allowed) {
          throw new OfficialRegistrationForbidden();
        }
        const isOverwrite = locked.officialRegisteredAt !== null;
        operation = isOverwrite ? 'seven_po:register_overwrite' : 'seven_po:register';
        const updated = { officialRegisteredAt: registeredAt.date, updatedAt: new Date() };
        const updateFilter = isOverwrite
          ? eq(sevenPurchaseOrders.id, poId)
          : and(
            eq(sevenPurchaseOrders.id, poId),
            isNull(sevenPurchaseOrders.officialRegisteredAt)
          );
        const updatedRows = await tx.update(sevenPurchaseOrders).set(updated)
          .where(updateFilter)
          .returning();
        if (updatedRows.length === 0) throw new OfficialRegistrationRace();
        written = updatedRows[0]!;
        await recordAuditEvent(tx, {
          projectId: locked.projectId,
          id: uuidv7(updated.updatedAt),
          actorUserId: user.id,
          action: 'SEVEN_PO_OFFICIALLY_REGISTERED',
          entityType: 'seven_purchase_order',
          entityId: poId,
          beforeState: locked,
          afterState: written,
          occurredAt: updated.updatedAt,
          requestMetadata: { operation }
        });
    });
    } catch (error) {
      if (error instanceof OfficialRegistrationForbidden) {
        return context.json({ error: '権限がありません' }, 403);
      }
      if (error instanceof OfficialRegistrationRace) {
        return context.json({
          error: '公式登録日が別の記録で登録されました',
          code: 'OFFICIAL_DATE_ALREADY_REGISTERED'
        }, 409);
      }
      throw error;
    }
    return context.json(written!);
  });

  app.post('/api/projects/:projectId/pre-order-references', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
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
    if (!isUuid(preOrderId)) {
      return context.json({
        error: '経路パラメータ（preOrderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
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
    // M7-SEC3 FIX 3: the G6 transaction terms are recorded at creation and are
    // read again by the maker purchase order approval. An order created without
    // a stated term starts as 'undetermined', the state that closes G6.
    const paymentTermsCheck = body?.paymentTerms === undefined
      ? { ok: true as const, value: DEFAULT_PAYMENT_TERMS }
      : validatePaymentTermsInput(body.paymentTerms);
    if (!paymentTermsCheck.ok) {
      return context.json({ error: paymentTermsCheck.message, code: paymentTermsCheck.code }, 422);
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
      paymentTerms: paymentTermsCheck.value,
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
        const insertedLines = await tx.insert(filmSupplyOrderLines).values(lines.map((line) => ({
          id: uuidv7(now),
          filmSupplyOrderId: orderId,
          lineNumber: line.lineNumber,
          description: line.description,
          orderedQuantity: line.orderedQuantity,
          unit: line.unit
        }))).returning();
        // F-00: the deliveries screen reconstructs choices from audit events,
        // not direct order reads. Every line created with the order must emit
        // the same append-only event as a line added later.
        for (const line of insertedLines) {
          await recordAuditEvent(tx, {
            projectId,
            actorUserId: user.id,
            action: 'FILM_SUPPLY_ORDER_LINE_CREATED',
            entityType: 'film_supply_order_line',
            entityId: line.id,
            afterState: line,
            occurredAt: now,
            requestMetadata: { operation: 'film_order:create', filmSupplyOrderId: orderId }
          });
        }
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

  // M7-SEC3 FIX 3: the G6 payment terms are the only mutable field on a film
  // supply order, and design keeps them writable while the order is a draft
  // only ("발주 초안까지만"). Once the chain has left DRAFT the terms are the
  // ones the rest of the chain was approved against, so this endpoint refuses
  // to renegotiate them.
  app.patch('/api/film-supply-orders/:orderId/payment-terms', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);

    const decision = canPerform(toActor(user), 'film_order:update_payment_terms', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は変更できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

    const body = await context.req.json().catch(() => null) as any;
    const paymentTermsCheck = validatePaymentTermsInput(body?.paymentTerms);
    if (!paymentTermsCheck.ok) {
      return context.json({ error: paymentTermsCheck.message, code: paymentTermsCheck.code }, 422);
    }

    if (order.status !== 'DRAFT') {
      return context.json({
        error: '決済条件（paymentTerms）は発注ドラフト（DRAFT）の間のみ変更できます。現在の状態では変更できません',
        code: 'PAYMENT_TERMS_LOCKED',
        from: order.status
      }, 422);
    }

    const now = new Date();
    const updated = { paymentTerms: paymentTermsCheck.value, updatedAt: now };
    await db.transaction(async (tx) => {
      await tx.update(filmSupplyOrders).set(updated).where(eq(filmSupplyOrders.id, orderId));
      await recordAuditEvent(tx, {
        projectId: order.projectId,
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED',
        entityType: 'film_supply_order',
        entityId: orderId,
        beforeState: { paymentTerms: normalizePaymentTerms(order.paymentTerms) },
        afterState: { paymentTerms: paymentTermsCheck.value },
        occurredAt: now,
        requestMetadata: { operation: 'film_order:update_payment_terms' }
      });
    });
    return context.json({ ...order, ...updated });
  });

  app.post('/api/film-supply-orders/:orderId/lines', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order_line:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は変更できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

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
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_delivery:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は変更できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

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
    if (unitCheck.unit !== line.unit) {
      return context.json({
        error: `納品単位は明細単位（${line.unit}）と一致させてください`,
        code: 'DELIVERY_UNIT_MISMATCH'
      }, 422);
    }

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
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order:transition', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は遷移できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }
    if (order.status === 'CANCELLATION_REVIEW') {
      return context.json({
        error: '取消レビューは専用の解決操作でのみ終了できます',
        code: 'CANCELLATION_REVIEW_RESOLUTION_REQUIRED',
        resolutionEndpoint: 'POST /api/film-supply-orders/:orderId/cancellation-review-resolve'
      }, 422);
    }

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.to !== 'string' || !ALL_FILM_SUPPLY_ORDER_STATES.includes(body.to)) {
      return context.json({ error: '遷移先状態が不正です', code: 'UNKNOWN_STATE' }, 422);
    }
    const target = body.to as FilmSupplyOrderState;

    // M7 security fix S1: the maker purchase-order chain is written only by the
    // dedicated M4 endpoints (CEO approval, send evidence, acceptance evidence).
    // Naming one of these states here would freeze paper nobody approved, record
    // a send nobody proved or an acceptance nobody verified.
    const makerChainRefusal = makerChainTransitionRefusal(target);
    if (!makerChainRefusal.ok) {
      return context.json({ error: makerChainRefusal.message, code: makerChainRefusal.code }, 422);
    }

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
      // M7 security fix S4: the same precedence gate the official artifacts and
      // the supply-order registration use. The date axis is still evaluated
      // first and reads official_registered_at ONLY (T-06) — a recorded
      // checklist never substitutes for the missing date — and the authenticity
      // axis now also has to be open, so a PO nobody verified through the
      // checklist cannot move the order forward.
      const gate = evaluateSevenPoPrecedenceGate(po);
      if (!gate.ok) {
        return context.json({ error: gate.message, code: gate.code }, 422);
      }
    }

    // CHANGE_REVIEW's restart targets sit after the seven-PO verification
    // boundary. A legacy row that entered review before that boundary cannot
    // use review resolution to leapfrog the registered-and-verified PO gate.
    if (order.status === 'CHANGE_REVIEW'
      && (target === 'ARTWORK_RECEIVED' || target === 'PROOF_READY' || target === 'APPROVAL_PENDING')) {
      if (!order.sevenPurchaseOrderId) {
        return context.json({ error: 'セブン発注書の紐付けが必要です', code: 'SEVEN_PO_REQUIRED' }, 422);
      }
      const [po] = await db.select().from(sevenPurchaseOrders)
        .where(eq(sevenPurchaseOrders.id, order.sevenPurchaseOrderId)).limit(1);
      if (!po) return context.json({ error: 'セブン発注書が見つかりません', code: 'SEVEN_PO_NOT_FOUND' }, 422);
      const gate = evaluateSevenPoPrecedenceGate(po);
      if (!gate.ok) return context.json({ error: gate.message, code: gate.code }, 422);
    }

    // M3: leaving the approval chain for maker ordering requires the derived
    // dual-approval gate to be open right now, not just a status that was set
    // when both approvals existed (T-13). A revocation closes it again.
    //
    // M7-SEC3 FIX 2: DUAL_APPROVED is under the same live gate. The status is
    // the derived conclusion of the approval log — the dedicated approval
    // endpoint writes it the moment the gate closes — so naming it here is only
    // legitimate for the recovery path where the gate closed while the order sat
    // in an exception state and the automatic advance never fired. Without this
    // check any staff member could freeze "dual approved" onto an order nobody
    // approved twice.
    if (target === 'MAKER_PO_READY' || target === 'DUAL_APPROVED') {
      const approvalContext = await loadApprovalContext(orderId);
      const approvalGate = deriveOrderApprovalGate(
        approvalContext.revisions,
        approvalContext.events,
        approvalContext.verifications
      );
      if (!approvalGate.dualApproved) {
        return context.json({
          error: '全デザインの両組織承認が必要です',
          code: 'DUAL_APPROVAL_REQUIRED',
          missingApprovals: approvalGate.missingApprovals,
          ...(target === 'DUAL_APPROVED'
            ? {
                dualApprovedRecordedOnlyViaApprovalEndpoint:
                  'POST /api/artwork-revisions/:revisionId/approvals'
              }
            : {})
        }, 422);
      }
    }

    const holdReasonCheck = target === 'ON_HOLD'
      ? normalizeRequiredReason(body?.holdReason ?? body?.reason)
      : { ok: true as const, text: null as string | null };
    if (target === 'ON_HOLD' && !holdReasonCheck.ok) {
      return context.json({
        error: holdReasonCheck.tooLong
          ? `保留理由（holdReason）は${REASON_MAX_LENGTH}文字以下で入力してください`
          : '保留理由（holdReason）は必須です',
        code: holdReasonCheck.tooLong ? 'HOLD_REASON_TOO_LONG' : 'HOLD_REASON_REQUIRED'
      }, 422);
    }

    const now = new Date();
    const holdReason = holdReasonCheck.ok ? holdReasonCheck.text : null;
    const updated = { status: target, holdReason, updatedAt: now };
    try {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, orderId)).limit(1).for('update');
        if (!current || current.deletedAt || current.status !== order.status) {
          throw new FilmOrderTransitionConflict();
        }
        if (!transitionFilmSupplyOrder(current.status, target).ok) {
          throw new FilmOrderTransitionConflict();
        }
        const updatedRows = await tx.update(filmSupplyOrders).set(updated)
          .where(and(
            eq(filmSupplyOrders.id, orderId),
            eq(filmSupplyOrders.status, current.status)
          ))
          .returning({ id: filmSupplyOrders.id });
        if (updatedRows.length === 0) throw new FilmOrderTransitionConflict();
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
          entityType: 'film_supply_order',
          entityId: orderId,
          beforeState: { status: current.status, holdReason: current.holdReason },
          afterState: { status: target, holdReason },
          occurredAt: now,
          requestMetadata: { operation: 'film_order:transition', holdReason }
        });
      });
    } catch (error) {
      if (error instanceof FilmOrderTransitionConflict) {
        return context.json({
          error: '発注状態がすでに変わっています',
          code: 'FILM_ORDER_STATE_CHANGED',
          from: order.status,
          to: target
        }, 409);
      }
      throw error;
    }
    return context.json({ ...order, ...updated });
  });

  // Holds are a recovery side-channel, not a shortcut around the maker chain.
  // The API keeps the origin from the append-only transition audit row and lets
  // only the representative release the hold to that same normal state.
  app.post('/api/film-supply-orders/:orderId/hold-release', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order:release_hold', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は解除できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

    if (order.status !== 'ON_HOLD') {
      return context.json({ error: '保留中の発注ではありません', code: 'ORDER_NOT_ON_HOLD', from: order.status }, 422);
    }

    const body = await context.req.json().catch(() => null) as any;
    const reasonCheck = normalizeRequiredReason(body?.reason);
    if (!reasonCheck.ok) {
      return context.json({
        error: reasonCheck.tooLong
          ? `保留解除理由は${REASON_MAX_LENGTH}字以下で入力してください`
          : '保留解除理由（reason）は必須です',
        code: reasonCheck.tooLong ? 'HOLD_RELEASE_REASON_TOO_LONG' : 'HOLD_RELEASE_REASON_REQUIRED'
      }, 422);
    }
    const reason = reasonCheck.text;
    const requestedResume = body?.resumeStatus;

    const now = new Date();
    let releasedStatus: NormalFilmSupplyOrderState | null = null;
    let holdEventId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, orderId)).limit(1).for('update');
        if (!current || current.deletedAt || current.status !== 'ON_HOLD') {
          throw new HoldReleaseStateConflict();
        }

        // The append-only hold event is read only after the order row is locked,
        // so a concurrent re-hold cannot change the origin this decision uses.
        const [holdEvent] = await tx.select({
          id: auditEvents.id,
          beforeState: auditEvents.beforeState,
          afterState: auditEvents.afterState
        }).from(auditEvents)
          .where(and(
            eq(auditEvents.entityType, 'film_supply_order'),
            eq(auditEvents.entityId, orderId),
            eq(auditEvents.action, 'FILM_SUPPLY_ORDER_TRANSITIONED'),
            sql`${auditEvents.afterState} ->> 'status' = 'ON_HOLD'`
          ))
          .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
          .limit(1);
        const originState = (holdEvent?.afterState as { status?: unknown } | null)?.status === 'ON_HOLD'
          ? filmSupplyOrderStateForValue((holdEvent?.beforeState as { status?: unknown } | null)?.status)
          : undefined;

        let targetState: NormalFilmSupplyOrderState;
        let paperRecoveryToReady = false;
        if (originState) {
          targetState = originState;
          if (
            originState === 'APPROVED_FOR_MANUAL_SEND'
            || originState === 'MAKER_PO_SENT_MANUALLY'
            || originState === 'MAKER_PO_ACCEPTED'
          ) {
            const [activePaper] = await tx.select({ id: makerPurchaseOrders.id })
              .from(makerPurchaseOrders)
              .where(and(
                eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
                ne(makerPurchaseOrders.status, 'CANCELLED'),
                isNull(makerPurchaseOrders.deletedAt)
              ))
              .limit(1)
              .for('update');
            if (!activePaper) {
              targetState = 'MAKER_PO_READY';
              paperRecoveryToReady = true;
            }
          }
          if (!paperRecoveryToReady && requestedResume !== undefined && requestedResume !== targetState) {
            throw new HoldReleaseTargetInvalid();
          }
          // A cleaned maker origin may name either its historical origin or the
          // effective recovery target; both intentionally resolve to READY.
          if (
            paperRecoveryToReady
            && requestedResume !== undefined
            && requestedResume !== originState
            && requestedResume !== 'MAKER_PO_READY'
          ) {
            throw new HoldReleaseTargetInvalid();
          }
        } else {
          if (requestedResume === undefined || requestedResume === null) {
            throw new HoldReleaseOriginUnknown();
          }
          if (!isLegacyHoldReleaseTarget(requestedResume)) throw new HoldReleaseTargetInvalid();
          targetState = requestedResume;

          if (targetState === 'APPROVED_FOR_MANUAL_SEND'
            || targetState === 'MAKER_PO_SENT_MANUALLY'
            || targetState === 'MAKER_PO_ACCEPTED') {
            const [activePo] = await tx.select({ status: makerPurchaseOrders.status })
              .from(makerPurchaseOrders)
              .where(and(
                eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
                ne(makerPurchaseOrders.status, 'CANCELLED')
              ))
              .orderBy(desc(makerPurchaseOrders.createdAt), desc(makerPurchaseOrders.id))
              .limit(1);
            if (activePo?.status !== targetState) throw new HoldReleaseEvidenceMismatch();
          }
        }

        if (!transitionFilmSupplyOrder(current.status, targetState, targetState).ok) {
          throw new HoldReleaseTargetInvalid();
        }
        const updatedRows = await tx.update(filmSupplyOrders)
          .set({ status: targetState, holdReason: null, updatedAt: now })
          .where(and(
            eq(filmSupplyOrders.id, orderId),
            eq(filmSupplyOrders.status, 'ON_HOLD')
          ))
          .returning({ id: filmSupplyOrders.id });
        if (updatedRows.length === 0) throw new HoldReleaseStateConflict();
        releasedStatus = targetState;
        holdEventId = holdEvent?.id ?? null;
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_SUPPLY_ORDER_HOLD_RELEASED',
          entityType: 'film_supply_order',
          entityId: orderId,
          beforeState: { status: current.status, holdReason: current.holdReason },
          afterState: { status: targetState, holdReason: null },
          occurredAt: now,
          requestMetadata: {
            operation: 'film_order:release_hold',
            reason,
            holdEventId,
            ...(paperRecoveryToReady ? {
              originState,
              intendedReverseRecovery: 'no_active_maker_po_after_cleanup'
            } : {}),
            ...(originState ? {} : { legacyResumeStatus: targetState })
          }
        });
      });
    } catch (error) {
      if (error instanceof HoldReleaseStateConflict) {
        return context.json({ error: '保留状態がすでに変わりました', code: 'HOLD_RELEASE_STATE_CONFLICT' }, 409);
      }
      if (error instanceof HoldReleaseOriginUnknown) {
        return context.json({
          error: '保留直前の状態を確認できないため、復帰先（resumeStatus）の指定が必要です',
          code: 'HOLD_ORIGIN_UNKNOWN'
        }, 422);
      }
      if (error instanceof HoldReleaseTargetInvalid) {
        return context.json({
          error: '復帰先（resumeStatus）は直前状態、または整理済み maker origin 回復では MAKER_PO_READY のみ指定できます',
          code: 'HOLD_RESUME_STATUS_INVALID'
        }, 422);
      }
      if (error instanceof HoldReleaseEvidenceMismatch) {
        return context.json({
          error: '復帰先のメーカー発注状態に対応する有効な証跡がありません',
          code: 'HOLD_RESUME_EVIDENCE_MISMATCH'
        }, 422);
      }
      throw error;
    }
    return context.json({ ...order, status: releasedStatus!, holdReason: null, updatedAt: now });
  });

  // CANCELLATION_REVIEW is a representative-owned side-channel. The generic
  // transition endpoint refuses every exit; this endpoint resolves it to the
  // exact entry origin or closes the film order as CANCELLED in one audit row.
  app.post('/api/film-supply-orders/:orderId/cancellation-review-resolve', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order:resolve_cancellation_review', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: 'すでに取消終了しています', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

    if (order.status !== 'CANCELLATION_REVIEW') {
      return context.json({
        error: '取消レビュー中の発注ではありません',
        code: 'ORDER_NOT_IN_CANCELLATION_REVIEW',
        from: order.status
      }, 422);
    }

    const body = await context.req.json().catch(() => null) as any;
    const outcome = body?.outcome;
    if (outcome !== 'resume' && outcome !== 'cancel') {
      return context.json({
        error: '処理結果（outcome）は resume または cancel です',
        code: 'CANCELLATION_OUTCOME_INVALID'
      }, 422);
    }
    const reasonCheck = normalizeRequiredReason(body?.reason);
    if (!reasonCheck.ok) {
      return context.json({
        error: reasonCheck.tooLong
          ? `取消レビュー処理理由は${REASON_MAX_LENGTH}字以下で入力してください`
          : '取消レビュー処理理由（reason）は必須です',
        code: reasonCheck.tooLong ? 'CANCELLATION_REASON_TOO_LONG' : 'CANCELLATION_REASON_REQUIRED'
      }, 422);
    }

    const now = new Date();
    let resolvedStatus: string | null = null;
    let reviewEventId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, orderId)).limit(1).for('update');
        if (!current || current.deletedAt || current.status !== 'CANCELLATION_REVIEW') {
          throw new CancellationReviewStateConflict();
        }

        // Origin is read after the order lock so a concurrent re-entry cannot
        // change the state this resolution names in its audit evidence.
        const [reviewEvent] = await tx.select({
          id: auditEvents.id,
          beforeState: auditEvents.beforeState,
          afterState: auditEvents.afterState
        }).from(auditEvents)
          .where(and(
            eq(auditEvents.entityType, 'film_supply_order'),
            eq(auditEvents.entityId, orderId),
            eq(auditEvents.action, 'FILM_SUPPLY_ORDER_TRANSITIONED'),
            sql`${auditEvents.afterState} ->> 'status' = 'CANCELLATION_REVIEW'`
          ))
          .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
          .limit(1);
        const origin = (reviewEvent?.afterState as { status?: unknown } | null)?.status === 'CANCELLATION_REVIEW'
          ? filmSupplyOrderStateForValue((reviewEvent?.beforeState as { status?: unknown } | null)?.status)
          : undefined;
        let cleanedMakerOrigin = false;
        let activePaper: { id: string } | undefined;
        if (
          origin !== undefined
          && (
            origin === 'APPROVED_FOR_MANUAL_SEND'
            || origin === 'MAKER_PO_SENT_MANUALLY'
            || origin === 'MAKER_PO_ACCEPTED'
          )
        ) {
          const [paper] = await tx.select({ id: makerPurchaseOrders.id })
            .from(makerPurchaseOrders)
            .where(and(
              eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
              ne(makerPurchaseOrders.status, 'CANCELLED'),
              isNull(makerPurchaseOrders.deletedAt)
            ))
            .limit(1)
            .for('update');
          activePaper = paper;
          cleanedMakerOrigin = !paper;
        }
        const requestedResume = body?.resumeStatus;
        const requestForStateRule = cleanedMakerOrigin
          && (requestedResume === origin || requestedResume === 'MAKER_PO_READY')
          ? undefined
          : requestedResume;
        if (
          origin !== undefined
          && outcome === 'resume'
          && (
            (cleanedMakerOrigin && requestedResume !== undefined
              && requestedResume !== origin && requestedResume !== 'MAKER_PO_READY')
            || (!cleanedMakerOrigin && requestedResume === 'MAKER_PO_READY' && origin !== 'MAKER_PO_READY')
          )
        ) {
          throw new CancellationReviewResolutionInvalid(
            'CANCELLATION_RESUME_TARGET_INVALID',
            cleanedMakerOrigin
              ? 'resumeStatus must name the review origin or MAKER_PO_READY when cleaned maker recovery applies'
              : 'resumeStatus must name the exact review origin while its live maker paper remains'
          );
        }
        const resolution = resolveCancellationReview(outcome, origin, requestForStateRule);
        if (!resolution.ok) {
          throw new CancellationReviewResolutionInvalid(resolution.code, resolution.message);
        }
        let resumeTarget = resolution.target;
        let paperRecoveryToReady = false;
        if (
          origin !== undefined
          && resolution.target === origin
          && (
            origin === 'APPROVED_FOR_MANUAL_SEND'
            || origin === 'MAKER_PO_SENT_MANUALLY'
            || origin === 'MAKER_PO_ACCEPTED'
          )
        ) {
          if (!activePaper) {
            resumeTarget = 'MAKER_PO_READY';
            paperRecoveryToReady = true;
          }
        }

        if (origin === undefined && resolution.target !== 'CANCELLED'
          && (resolution.target === 'APPROVED_FOR_MANUAL_SEND'
            || resolution.target === 'MAKER_PO_SENT_MANUALLY'
            || resolution.target === 'MAKER_PO_ACCEPTED')) {
          const [activePo] = await tx.select({ status: makerPurchaseOrders.status })
            .from(makerPurchaseOrders)
            .where(and(
              eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
              ne(makerPurchaseOrders.status, 'CANCELLED')
            ))
            .orderBy(desc(makerPurchaseOrders.createdAt), desc(makerPurchaseOrders.id))
            .limit(1);
          if (activePo?.status !== resolution.target) {
            throw new CancellationReviewEvidenceMismatch();
          }
        }

        const updatedRows = resumeTarget === 'CANCELLED'
          ? await tx.update(filmSupplyOrders)
            .set({
              status: sql`'CANCELLED'::film_supply_order_status`,
              holdReason: null,
              updatedAt: now
            })
            .where(and(
              eq(filmSupplyOrders.id, orderId),
              eq(filmSupplyOrders.status, 'CANCELLATION_REVIEW')
            ))
            .returning({ id: filmSupplyOrders.id })
          : await tx.update(filmSupplyOrders)
            .set({ status: resumeTarget, holdReason: null, updatedAt: now })
            .where(and(
              eq(filmSupplyOrders.id, orderId),
              eq(filmSupplyOrders.status, 'CANCELLATION_REVIEW')
            ))
            .returning({ id: filmSupplyOrders.id });
        if (updatedRows.length === 0) throw new CancellationReviewStateConflict();
        resolvedStatus = String(resumeTarget);
        reviewEventId = reviewEvent?.id ?? null;
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED',
          entityType: 'film_supply_order',
          entityId: orderId,
          beforeState: { status: current.status, holdReason: current.holdReason },
          afterState: { status: resolvedStatus, holdReason: null },
          occurredAt: now,
          requestMetadata: {
            operation: 'film_order:resolve_cancellation_review',
            outcome,
            reason: reasonCheck.text,
            reviewEventId,
            ...(paperRecoveryToReady ? {
              intendedReverseRecovery: 'no_active_maker_po_after_cleanup'
            } : {}),
            ...(origin ? { origin } : { legacyResumeStatus: resolution.target })
          }
        });
      });
    } catch (error) {
      if (error instanceof CancellationReviewStateConflict) {
        return context.json({
          error: '取消レビュー状態がすでに変わりました',
          code: 'CANCELLATION_REVIEW_STATE_CHANGED'
        }, 409);
      }
      if (error instanceof CancellationReviewEvidenceMismatch) {
        return context.json({
          error: '復帰先のメーカー発注状態に対応する有効な証跡がありません',
          code: 'CANCELLATION_RESUME_EVIDENCE_MISMATCH'
        }, 422);
      }
      if (error instanceof CancellationReviewResolutionInvalid) {
        return context.json({ error: error.message, code: error.code }, 422);
      }
      throw error;
    }
    return context.json({
      ...order,
      status: resolvedStatus!,
      holdReason: null,
      updatedAt: now
    });
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
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'film_order:assume_receipt', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は変更できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

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
    orderStatus?: unknown;
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
        orderDeletedAt: filmSupplyOrders.deletedAt,
        orderStatus: filmSupplyOrders.status
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
    if (!isUuid(deliveryId)) {
      return context.json({
        error: '経路パラメータ（deliveryId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const target = await loadDeliveryConfirmationTarget(kind, deliveryId);
    if (!target || target.orderDeletedAt) return context.json({ error: '納品行が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'delivery_confirmation:record', 'F1', target.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (kind === 'film' && String(target.orderStatus) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は確認できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

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
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
    // An unknown project is 404 before the assignment check: staff of this
    // company learn nothing about a project that does not exist.
    const [project] = await db.select({ id: projects.id, deletedAt: projects.deletedAt }).from(projects)
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

    // M7 security fix S3: the rows are append-only and stay exactly as they were
    // written; only this answer is narrowed to what the caller's role may read.
    const selectedRows: AuditHistoryRow[] = rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeState: row.beforeState,
      afterState: row.afterState,
      occurredAt: row.occurredAt,
      requestMetadata: row.requestMetadata,
      // display_name is NOT NULL; it is only nullable here through the left join.
      actor: row.actorId && row.actorDisplayName !== null
        ? { id: row.actorId, displayName: row.actorDisplayName, role: row.actorRole }
        : null
    }));

    return context.json({
      projectId,
      count: selectedRows.length,
      events: buildAuditViewForRole(user.role, selectedRows)
    });
  });

  // ------------------------------------------------ M1: filling orders (design
  // section 5). Units are filling vocabulary only.
  app.post('/api/projects/:projectId/filling-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
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
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    if (unitCheck.unit !== line.unit) {
      return context.json({
        error: `納品単位は明細単位（${line.unit}）と一致させてください`,
        code: 'DELIVERY_UNIT_MISMATCH'
      }, 422);
    }

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
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
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
    makerPurchaseOrderId: string | null;
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
        // M8-HARDEN FIX B2 (d): the maker PO an acceptance evidence is for.
        makerPurchaseOrderId: typeof raw.makerPurchaseOrderId === 'string' && raw.makerPurchaseOrderId.length > 0
          ? raw.makerPurchaseOrderId
          : null,
        originalReceivedAt: receivedAt.date
      }
    };
  }

  app.post('/api/projects/:projectId/documents', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const projectId = context.req.param('projectId');
    if (!isUuid(projectId)) {
      return context.json({
        error: '経路パラメータ（projectId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
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

    // M8-HARDEN FIX B2 (d): the acceptance evidence of one maker PO names that
    // maker PO. The binding is validated once at intake and read everywhere
    // else, so an acceptance document can never close a paper it was not
    // uploaded for — one order can hold a cancelled and a live maker PO.
    let makerPoBindingId: string | null = null;
    if (input.makerPurchaseOrderId) {
      const [boundPo] = await db.select({
        id: makerPurchaseOrders.id,
        filmSupplyOrderId: makerPurchaseOrders.filmSupplyOrderId
      }).from(makerPurchaseOrders)
        .where(eq(makerPurchaseOrders.id, input.makerPurchaseOrderId)).limit(1);
      if (!boundPo || boundPo.filmSupplyOrderId !== artworkBindingOrderId) {
        return context.json({
          error: '紐付け対象のメーカー発注書が、この書類の発注に見つかりません',
          code: 'MAKER_PO_BINDING_MISMATCH'
        }, 422);
      }
      makerPoBindingId = boundPo.id;
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
        || (existingDocument.designKey ?? null) !== input.designKey
        || (existingDocument.makerPurchaseOrderId ?? null) !== makerPoBindingId;
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
      makerPurchaseOrderId: makerPoBindingId,
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
        afterState: {
          ...versionRow,
          documentType: (newDocument ?? existingDocument)?.documentType,
          issuerEntity: (newDocument ?? existingDocument)?.issuerEntity ?? null,
          filmSupplyOrderId: (newDocument ?? existingDocument)?.filmSupplyOrderId ?? null,
          designKey: (newDocument ?? existingDocument)?.designKey ?? null
        },
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
    if (!isUuid(documentId)) {
      return context.json({
        error: '経路パラメータ（documentId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    if (!isUuid(preOrderId)) {
      return context.json({
        error: '経路パラメータ（preOrderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    let written: typeof po | null = null;
    let operation: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(sevenPurchaseOrders)
          .where(eq(sevenPurchaseOrders.id, po.id)).limit(1).for('update');
        if (!locked) throw new OfficialRegistrationRace();
        const decision = canWriteSevenPoOfficialDate(
          toActor(user),
          locked.officialRegisteredAt,
          'F1',
          locked.projectId
        );
        if (!decision.allowed) throw new OfficialRegistrationForbidden();
        if (locked.reviewPending) {
          throw new OfficialRegistrationReviewPending();
        }
        if (locked.verificationStatus !== 'verified') {
          throw new OfficialRegistrationNotVerified();
        }

        const isOverwrite = locked.officialRegisteredAt !== null;
        operation = isOverwrite
          ? 'pre_order:promote_official_overwrite'
          : 'pre_order:promote_official';
        const updated = {
          officialRegisteredAt: registeredAt.date ?? now,
          promotedAt: now,
          promotedByUserId: user.id,
          updatedAt: now
        };
        const updateFilter = isOverwrite
          ? eq(sevenPurchaseOrders.id, locked.id)
          : and(
            eq(sevenPurchaseOrders.id, locked.id),
            isNull(sevenPurchaseOrders.officialRegisteredAt)
          );
        const updatedRows = await tx.update(sevenPurchaseOrders).set(updated)
          .where(updateFilter)
          .returning();
        if (updatedRows.length === 0) throw new OfficialRegistrationRace();
        written = updatedRows[0]!;
        await recordAuditEvent(tx, {
          projectId: locked.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'PRE_ORDER_PROMOTED_OFFICIAL',
          entityType: 'seven_purchase_order',
          entityId: locked.id,
          beforeState: locked,
          afterState: written,
          occurredAt: now,
          requestMetadata: { operation, preOrderReferenceId: reference.id }
        });
      });
    } catch (error) {
      if (error instanceof OfficialRegistrationForbidden) {
        return context.json({ error: '権限がありません' }, 403);
      }
      if (error instanceof OfficialRegistrationReviewPending) {
        return context.json({ error: '見積と発注書の突合レビューが未解決です', code: 'PO_REVIEW_PENDING' }, 422);
      }
      if (error instanceof OfficialRegistrationNotVerified) {
        return context.json({ error: 'セブン発注書の真正性確認が完了していません', code: 'SEVEN_PO_NOT_VERIFIED' }, 422);
      }
      if (error instanceof OfficialRegistrationRace) {
        return context.json({
          error: '公式登録日が別の記録で登録されました',
          code: 'OFFICIAL_DATE_ALREADY_REGISTERED'
        }, 409);
      }
      throw error;
    }
    return context.json(written);
  });

  // Supply-order registration against a seven purchase order (T-04, T-05):
  // the precedence gate is evaluated before anything is written.
  app.post('/api/seven-purchase-orders/:poId/supply-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    // M7-SEC3 FIX 3: the G6 transaction terms are recorded at creation; an
    // unstated term starts as 'undetermined', the state that closes G6.
    const paymentTermsCheck = body?.paymentTerms === undefined
      ? { ok: true as const, value: DEFAULT_PAYMENT_TERMS }
      : validatePaymentTermsInput(body.paymentTerms);
    if (!paymentTermsCheck.ok) {
      return context.json({ error: paymentTermsCheck.message, code: paymentTermsCheck.code }, 422);
    }

    const now = new Date();
    const orderId = uuidv7(now);
    const order = {
      id: orderId,
      projectId: po.projectId,
      code: body.code,
      status: 'DRAFT' as const,
      sevenPurchaseOrderId: po.id,
      paymentTerms: paymentTermsCheck.value,
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
        const insertedLines = await tx.insert(filmSupplyOrderLines).values(lines.map((line) => ({
          id: uuidv7(now),
          filmSupplyOrderId: orderId,
          lineNumber: line.lineNumber,
          description: line.description,
          orderedQuantity: line.orderedQuantity,
          unit: line.unit
        }))).returning();
        // F-00 contract parity: the Seven-PO-bound creation endpoint and the
        // project creation endpoint must both make every line selectable on the
        // deliveries screen. operation distinguishes the creation path.
        for (const line of insertedLines) {
          await recordAuditEvent(tx, {
            projectId: po.projectId,
            actorUserId: user.id,
            action: 'FILM_SUPPLY_ORDER_LINE_CREATED',
            entityType: 'film_supply_order_line',
            entityId: line.id,
            afterState: line,
            occurredAt: now,
            requestMetadata: { operation: 'supply_order:create', filmSupplyOrderId: orderId }
          });
        }
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
  async function loadApprovalContext(
    orderId: string,
    executor: MakerPoQueryExecutor = db
  ): Promise<{
    revisions: ArtworkRevisionView[];
    events: ApprovalEventView[];
    verifications: EvidenceVerificationView[];
  }> {
    const revisionRows = await executor.select({
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
      : await executor.select({
        id: artworkApprovalEvents.id,
        artworkRevisionId: artworkApprovalEvents.artworkRevisionId,
        organization: artworkApprovalEvents.organization,
        decision: artworkApprovalEvents.decision,
        approvedFileSha256: artworkApprovalEvents.approvedFileSha256,
        recordedAt: artworkApprovalEvents.recordedAt,
        eventTime: artworkApprovalEvents.eventTime,
        supersedesEventId: artworkApprovalEvents.supersedesEventId,
        evidenceDocumentVersionId: artworkApprovalEvents.evidenceDocumentVersionId,
        evidenceIdentifier: artworkApprovalEvents.evidenceIdentifier,
        // M8-OPERATOR FIX 4: the gate must know which approvals are still only
        // recorded-but-pending manual identifier verification.
        evidenceIdentifierStatus: artworkApprovalEvents.evidenceIdentifierStatus
      }).from(artworkApprovalEvents)
        .where(inArray(artworkApprovalEvents.artworkRevisionId, revisionIds));

    // M8-OPER2 FIX 2: the manual verifications that decide which pending
    // approvals count. Append-only rows read in recording order; the latest one
    // per approval event wins inside the gate derivation.
    const verificationRows = revisionIds.length === 0
      ? [] as EvidenceVerificationView[]
      : await executor.select({
        id: evidenceManualVerifications.id,
        approvalEventId: evidenceManualVerifications.approvalEventId,
        artworkRevisionId: evidenceManualVerifications.artworkRevisionId,
        approvedFileSha256: evidenceManualVerifications.approvedFileSha256,
        result: evidenceManualVerifications.result,
        verifierName: evidenceManualVerifications.verifierName,
        verifiedAt: evidenceManualVerifications.verifiedAt,
        recordedAt: evidenceManualVerifications.recordedAt
      }).from(evidenceManualVerifications)
        .where(inArray(evidenceManualVerifications.artworkRevisionId, revisionIds)) as EvidenceVerificationView[];
    // result is a text column held to the EvidenceVerificationResult vocabulary by
    // the evidence_manual_verifications_result_vocabulary CHECK (migration 0017).

    return { revisions: revisionRows, events: eventRows, verifications: verificationRows };
  }

  /**
   * M8-OPER3: the real-time dual-approval re-verification at the maker-PO
   * boundary (CEO final safety gate).
   *
   * The approval log is append-only and a REVOKE never rewrites the order
   * status, so an order that once reached MAKER_PO_READY keeps sitting there
   * after one organization withdrew its approval — the four maker-PO endpoints
   * were the doors that never re-read the gate (the generic transitions
   * endpoint already does, T-13). Every call here derives the gate fresh from
   * the database, records one append-only audit row naming the decision, its
   * reason and the gate snapshot, and returns the 422 payload when the boundary
   * must refuse.
   *
   * M8-HARDEN FIX A3: one closure remains a non-block, and one was added.
   * - (kept) a send or acceptance for paper whose send is already proven (a
   *   SEND_EVIDENCE_REGISTERED event with verificationStatus VERIFIED): what
   *   has left the company cannot be un-sent, so the re-check is recorded in
   *   the audit trail instead of enforced. Not-yet-shipped paper stays blocked.
   *   The G10 snapshot-void machinery itself is untouched — a drifted snapshot
   *   is still refused by its own check in the send path.
   * - (FIX A3) every other closed gate blocks, including the case that used to
   *   pass: the current artwork revision holds no valid approval from BOTH
   *   organizations because a newer revision superseded the old approvals (the
   *   T-11 change-review flow). Certifying or sending paper whose artwork no
   *   organization approved is exactly the leak the CEO closed: the acts now
   *   answer 422 DUAL_APPROVAL_NO_LONGER_VALID with the missing approvals, and
   *   recovery is both organizations approving the new revision.
   */
  type MakerPoRecheckStage =
    | 'maker_po:create'
    | 'maker_po:ceo_approve'
    | 'maker_po:send_evidence'
    | 'maker_po:accept_evidence';

  interface MakerPoRecheckInput {
    order: { id: string; projectId: string };
    /** The order status as the calling handler read it. */
    orderStatus: string;
    /** The maker purchase order the call acts on; null while creating one. */
    poId: string | null;
    stage: MakerPoRecheckStage;
    actorUserId: string;
    now: Date;
  }

  interface MakerPoRecheckRefusal {
    error: string;
    code: 'DUAL_APPROVAL_NO_LONGER_VALID';
    missingApprovals: Array<{ designKey: string; organization: ApprovalOrganization }>;
  }

  const DUAL_APPROVAL_NO_LONGER_VALID_MESSAGE =
    '二重承認が無効になっているため、この操作は実行できません。取り消された組織の承認を再取得してから実行してください';

  async function dualApprovalRecheck(
    input: MakerPoRecheckInput,
    executor: MakerPoReadWriteExecutor = db
  ): Promise<MakerPoRecheckRefusal | null> {
    const approvalContext = await loadApprovalContext(input.order.id, executor);
    const gate = deriveOrderApprovalGate(
      approvalContext.revisions,
      approvalContext.events,
      approvalContext.verifications
    );

    // The proven-send read: a send registered with a verified evidence document
    // is the fact that the paper already left the company (G9 VERIFIED).
    const provenSendRows = input.poId === null
      ? [] as Array<{ id: string }>
      : await executor.select({ id: makerPoEvents.id }).from(makerPoEvents).where(and(
        eq(makerPoEvents.makerPurchaseOrderId, input.poId),
        eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED'),
        eq(makerPoEvents.verificationStatus, 'VERIFIED')
      )).limit(1);
    const provenSendExists = provenSendRows.length > 0;
    const postSendStage = input.stage === 'maker_po:send_evidence'
      || input.stage === 'maker_po:accept_evidence';

    // A closure counts as a withdrawal when a required organization's latest
    // effective decision on the current revision is a REVOKE, or when its
    // latest APPROVE is not counted (identifier awaiting manual confirmation).
    // A revision that has no counted approvals at all is the superseded case:
    // the approvals that once opened this gate belong to an older revision and
    // were never re-recorded for the current one (FIX A3).
    const approvalWithdrawn = gate.designs.some((design) =>
      design.customer.revoked || design.seven.revoked
      || design.customer.pendingEvidenceIdentifier || design.seven.pendingEvidenceIdentifier
    );
    // FIX A3: the gate being closed is enough. Pre-send boundary acts need the
    // current revision to hold both approvals right now; only paper whose send
    // is already proven escapes, because that send already happened.
    const blocked = !gate.dualApproved
      && !(postSendStage && provenSendExists);
    const reason = gate.dualApproved
      ? 'gate_open'
      : postSendStage && provenSendExists
        ? 'gate_closed_after_proven_send_recorded_not_enforced'
        : approvalWithdrawn
          ? 'gate_closed_approval_withdrawn'
          : 'gate_closed_current_revision_missing_dual_approval';

    await recordAuditEvent(executor, {
      projectId: input.order.projectId,
      id: uuidv7(input.now),
      actorUserId: input.actorUserId,
      action: 'MAKER_PO_DUAL_APPROVAL_RECHECK',
      entityType: input.poId === null ? 'film_supply_order' : 'maker_purchase_order',
      entityId: input.poId ?? input.order.id,
      afterState: {
        result: blocked ? 'blocked' : 'passed',
        stage: input.stage,
        reason,
        provenSendExists,
        orderStatus: input.orderStatus,
        gate: {
          dualApproved: gate.dualApproved,
          requiredDesignKeys: gate.requiredDesignKeys,
          missingApprovals: gate.missingApprovals,
          designs: gate.designs.map((design) => ({
            designKey: design.designKey,
            revisionNo: design.currentRevisionNo,
            fileSha256: design.fileSha256,
            customer: {
              valid: design.customer.valid,
              revoked: design.customer.revoked,
              latestDecision: design.customer.latestDecision,
              pendingEvidenceIdentifier: design.customer.pendingEvidenceIdentifier
            },
            seven: {
              valid: design.seven.valid,
              revoked: design.seven.revoked,
              latestDecision: design.seven.latestDecision,
              pendingEvidenceIdentifier: design.seven.pendingEvidenceIdentifier
            }
          }))
        }
      },
      occurredAt: input.now,
      requestMetadata: {
        operation: input.stage,
        filmSupplyOrderId: input.order.id,
        ...(input.poId === null ? {} : { makerPurchaseOrderId: input.poId })
      }
    });

    return blocked
      ? {
        error: DUAL_APPROVAL_NO_LONGER_VALID_MESSAGE,
        code: 'DUAL_APPROVAL_NO_LONGER_VALID',
        missingApprovals: gate.missingApprovals
      }
      : null;
  }

  /**
   * M7 security fix S4: the seven purchase order precedence gate (T-04, T-05)
   * applied to the endpoints that advance work on an order rather than to the
   * paperwork intake alone. The date axis still reads official_registered_at
   * only (T-06); the authenticity axis requires the recorded checklist verdict.
   * Returns null when the gate is open, otherwise the 422 payload to answer
   * with.
   */
  async function sevenPoPrecedenceRefusal(
    order: {
    sevenPurchaseOrderId: string | null;
    },
    executor: MakerPoReadWriteExecutor = db
  ): Promise<{ code: string; message: string } | null> {
    if (!order.sevenPurchaseOrderId) {
      return { code: 'SEVEN_PO_REQUIRED', message: '検証済みのセブン発注書の紐付けが必要です' };
    }
    const [po] = await executor.select().from(sevenPurchaseOrders)
      .where(eq(sevenPurchaseOrders.id, order.sevenPurchaseOrderId)).limit(1);
    if (!po) return { code: 'SEVEN_PO_NOT_FOUND', message: 'セブン発注書が見つかりません' };
    const gate = evaluateSevenPoPrecedenceGate(po);
    if (!gate.ok) return { code: gate.code, message: gate.message };
    return null;
  }

  app.post('/api/film-supply-orders/:orderId/artwork-revisions', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'artwork_revision:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注には版を追加できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

    // Representative decision for seventh-recheck Medium-5: a live maker paper
    // freezes production scope. A new artwork revision cannot enter change
    // review while that paper is outstanding, because acceptance during review
    // would leave a READY order holding an accepted paper with no forward path.
    const [activeMakerPaper] = await db.select({ id: makerPurchaseOrders.id })
      .from(makerPurchaseOrders)
      .where(and(
        eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
        ne(makerPurchaseOrders.status, 'CANCELLED'),
        isNull(makerPurchaseOrders.deletedAt)
      ))
      .limit(1);
    if (activeMakerPaper) {
      return context.json({
        error: '有効なメーカー発注書がある間は新しい原稿版を登録できません。既存の発注書を取り消してから原稿を変更してください',
        code: 'MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED',
        makerPurchaseOrderId: activeMakerPaper.id
      }, 409);
    }

    // Artwork only exists downstream of a verified purchase order.
    const registrationGate = evaluateRevisionRegistrationGate(order.status);
    if (!registrationGate.ok) return context.json({ error: registrationGate.message, code: registrationGate.code }, 422);

    // M7 security fix S4: the revision file is always a proof, and proof intake
    // already applies the precedence gate; stating the gate here as well keeps
    // the invariant at the endpoint that advances the order, independent of how
    // the proof version came to exist.
    const precedenceRefusal = await sevenPoPrecedenceRefusal(order);
    if (precedenceRefusal) {
      return context.json({ error: precedenceRefusal.message, code: precedenceRefusal.code }, 422);
    }

    const body = await context.req.json().catch(() => null) as any;
    if (typeof body?.designKey !== 'string' || body.designKey.trim().length === 0) {
      return context.json({ error: 'デザインキーが必要です', code: 'DESIGN_KEY_REQUIRED' }, 422);
    }
    const designKey = body.designKey.trim();
    if (typeof body?.fileDocumentVersionId !== 'string' || body.fileDocumentVersionId.length === 0) {
      return context.json({ error: '版ファイルの指定が必要です', code: 'FILE_DOCUMENT_VERSION_REQUIRED' }, 422);
    }
    if (!isUuid(body.fileDocumentVersionId)) {
      return context.json({ error: '版ファイルIDが不正です', code: 'FILE_DOCUMENT_VERSION_INVALID' }, 422);
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

    try {
      await db.transaction(async (tx) => {
      // Re-read under lock: a concurrent cancellation/review transition must
      // win over the stale preflight status used above.
      const [lockedOrder] = await tx.select().from(filmSupplyOrders)
        .where(eq(filmSupplyOrders.id, orderId)).limit(1).for('update');
      if (!lockedOrder || lockedOrder.deletedAt || lockedOrder.status !== order.status) {
        throw new MakerPoStateConflict();
      }
      if (String(lockedOrder.status) === 'CANCELLED') {
        throw new MakerPoStateConflict();
      }
      const [racingActivePaper] = await tx.select({ id: makerPurchaseOrders.id })
        .from(makerPurchaseOrders)
        .where(and(
          eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
          ne(makerPurchaseOrders.status, 'CANCELLED'),
          isNull(makerPurchaseOrders.deletedAt)
        ))
        .limit(1)
        .for('update');
      if (racingActivePaper) throw new MakerPoStateConflict();
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
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {

        return context.json({ error: '発注状態がすでに変わっています', code: 'FILM_ORDER_STATE_CHANGED' }, 409);
      }
      throw error;
    }

    return context.json({ ...revision, status: statusAfter, invalidatedApprovals }, 201);
  });

  app.post('/api/artwork-revisions/:revisionId/approvals', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const revisionId = context.req.param('revisionId');
    if (!isUuid(revisionId)) {
      return context.json({
        error: '経路パラメータ（revisionId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は変更できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

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
    if (!isUuid(body.evidenceDocumentVersionId)) {
      return context.json({ error: '承認証跡の書類バージョンIDが不正です', code: 'EVIDENCE_DOCUMENT_VERSION_INVALID' }, 422);
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
      designKey: documents.designKey,
      storagePath: documentVersions.storagePath,
      declaredMimeType: documentVersions.declaredMimeType
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

    // M7-SEC3 FIX 1: the identifier must be derivable from the evidence it
    // cites. M8-OPERATOR FIX 4 makes the rule content-type aware: text-like
    // evidence (text/plain, text/csv) is still a literal, case sensitive
    // substring match against the stored bytes — an invented identifier is
    // refused — while binary evidence (PDF, images) is never auto-verified: its
    // event is recorded with pending_manual_verification and stays out of the
    // dual-approval gate until a human confirms the identifier. Nothing here
    // approves anything on its own.
    let evidenceBytes: Buffer;
    try {
      evidenceBytes = await readFile(evidence.storagePath);
    } catch {
      // The bytes behind the cited version are gone, so nothing about them is
      // derivable — the identifier has no evidence to be checked against.
      return context.json({
        error: '承認証跡ファイルが読み取れないため、識別子を検証できません',
        code: 'EVIDENCE_DOCUMENT_UNREADABLE'
      }, 422);
    }
    // G6: a stored mail's identifier comes from its own Message-ID header. The
    // client's auto-fill is convenient, but the server re-extracts and replaces
    // it, so a typo or a quoted parent ID can never enter the event. Non-EML
    // evidence keeps the existing minimum-8 identifier rule.
    let evidenceIdentifier = typeof body?.evidenceIdentifier === 'string'
      ? body.evidenceIdentifier.trim()
      : '';
    const storedMessageId = extractStoredEmlMessageId(evidenceBytes);
    if (storedMessageId !== null) {
      evidenceIdentifier = storedMessageId;
    } else if (evidenceIdentifier.length === 0) {
      return context.json({
        error: '承認証跡識別子（evidenceIdentifier）が必要です。例：メッセージIDや署名ブロックのハッシュ',
        code: 'EVIDENCE_IDENTIFIER_REQUIRED'
      }, 422);
    } else if (evidenceIdentifier.length < 8) {
      return context.json({
        error: '承認証跡識別子（evidenceIdentifier）は8文字以上で指定してください',
        code: 'EVIDENCE_IDENTIFIER_TOO_SHORT'
      }, 422);
    }
    const identifierCheck = evaluateApprovalEvidenceIdentifierForBytes({
      identifier: evidenceIdentifier,
      bytes: evidenceBytes,
      contentType: evidence.declaredMimeType
    });
    if (!identifierCheck.ok) {
      return context.json({ error: identifierCheck.message, code: identifierCheck.code }, 422);
    }
    // A revocation never contributes to an approval, so its status reads
    // not_applicable regardless of the evidence kind — the identifier itself is
    // still checked above and an invented one is refused.
    const evidenceIdentifierStatus: EvidenceIdentifierStatus =
      decisionCheck.value === 'APPROVE' ? identifierCheck.status : 'not_applicable';
    const countsTowardDualApproval =
      decisionCheck.value === 'APPROVE' && evidenceIdentifierStatus !== 'pending_manual_verification';

    const approvalContext = await loadApprovalContext(order.id);
    const revisionEvents = approvalContext.events.filter((event) => event.artworkRevisionId === revision.id);

    // M7 security fix S2 (duplicate-message registration): the same
    // organization may not register the same evidence version twice. Recording
    // it again only counts as a correction when the event it replaces is named
    // explicitly (supersedesEventId), so a double submission can never look like
    // a second, independent approval.
    const sameEvidence = revisionEvents.find((event) =>
      event.organization === organization
      && event.evidenceDocumentVersionId === evidence.versionId
    );
    const explicitSupersedeRequested = typeof body?.supersedesEventId === 'string';
    if (sameEvidence && !explicitSupersedeRequested) {
      return context.json({
        error: '同じ組織で同じ承認証跡バージョンは二重に登録できません。置き換える場合は supersedesEventId を指定してください',
        code: 'EVIDENCE_DUPLICATE_REGISTRATION'
      }, 422);
    }

    // M7 security fix S2 (cross-organization identifier reuse): two
    // organizations citing one file stay distinguishable only while each keeps
    // its own identifier. The same identifier from the other organization means
    // the same approval message is being registered twice.
    const identifierReuse = revisionEvents.find((event) =>
      event.organization !== organization
      && event.evidenceIdentifier === evidenceIdentifier
    );
    if (identifierReuse) {
      return context.json({
        error: 'この承認証跡識別子（evidenceIdentifier）は別の組織が同じ版で既に登録しています。組織ごとに固有の識別子を指定してください',
        code: 'EVIDENCE_IDENTIFIER_REUSED_ACROSS_ORGANIZATIONS'
      }, 422);
    }

    let supersedesEventId: string | null = null;
    if (explicitSupersedeRequested) {
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
      const revisionGate = deriveOrderApprovalGate(
        approvalContext.revisions,
        approvalContext.events,
        approvalContext.verifications
      ).designs.find((design) => design.currentRevisionId === revision.id);
      supersedesEventId = revisionGate?.[organization].latestEventId ?? null;
    }

    const now = new Date();
    const eventId = uuidv7(now);
    const approvalEvent = {
      id: eventId,
      artworkRevisionId: revision.id,
      organization,
      decision: decisionCheck.value,
      // The approver is recorded verbatim as free text. Nothing here derives the
      // approver's organization or authority from a name or an issuerEntity:
      // the organization is what the recorder declares, the authority is the
      // evidence the event cites (version + per-organization identifier).
      externalApproverName: optionalText(body?.approverName) ?? optionalText(body?.externalApproverName),
      externalApproverOrg: optionalText(body?.externalApproverOrg),
      recordedByUserId: user.id,
      evidenceDocumentVersionId: evidence.versionId,
      evidenceIdentifier,
      evidenceIdentifierStatus,
      evidenceSource: sourceCheck.value,
      approvedFileSha256: revision.fileSha256,
      eventTime: eventTime.date,
      recordedAt: now,
      supersedesEventId
    };
    try {
    let recordedOrderStatus: FilmOrderStatus = order.status;
    let gateAfter = deriveOrderApprovalGate(approvalContext.revisions, approvalContext.events, approvalContext.verifications);
    await db.transaction(async (tx) => {
      // The order lock closes the side-channel race: an admin hold/CR/CANCELLED
      // transition and this approval serialize before either writes. A frozen
      // order may still receive an append-only approval fact, but it never
      // advances; a newly cancelled order rolls this approval back.
      const [lockedOrder] = await tx.select().from(filmSupplyOrders)
        .where(eq(filmSupplyOrders.id, order.id)).limit(1).for('update');
      if (!lockedOrder || lockedOrder.deletedAt) throw new MakerPoStateConflict();
      if (String(lockedOrder.status) === 'CANCELLED') throw new MakerPoStateConflict();
      const lockedStatus: FilmOrderStatus = lockedOrder.status;
      // Medium-C: the promotion is judged only from the append-only log and the
      // order state read after this transaction owns the row lock. A REVOKE or
      // other transition that committed while this request waited cannot be
      // promoted over.
      const lockedApprovalContext = await loadApprovalContext(order.id, tx);
      gateAfter = deriveOrderApprovalGate(
        lockedApprovalContext.revisions,
        [...lockedApprovalContext.events, approvalEvent],
        lockedApprovalContext.verifications
      );
      const advancesToDualApproved = decisionCheck.value === 'APPROVE'
        && shouldAdvanceToDualApproved(gateAfter, lockedStatus);
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
      if (advancesToDualApproved && !isFrozenFilmOrderStatus(lockedStatus)) {
        const advanced = await tx.update(filmSupplyOrders)
          .set({ status: 'DUAL_APPROVED', updatedAt: now })
          .where(and(
            eq(filmSupplyOrders.id, order.id),
            sql`${filmSupplyOrders.status}::text = ${lockedStatus}::text`
          ))
          .returning({ id: filmSupplyOrders.id });
        if (advanced.length === 0) throw new MakerPoStateConflict();
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
          entityType: 'film_supply_order',
          entityId: order.id,
          beforeState: { status: lockedStatus },
          afterState: { status: 'DUAL_APPROVED' },
          occurredAt: now,
          requestMetadata: { operation: 'artwork_approval:record', reason: 'dual_approval_reached' }
        });
        recordedOrderStatus = 'DUAL_APPROVED';
      } else {
        recordedOrderStatus = lockedStatus;
      }
    });

    return context.json({
      approvalEvent,
      // M8-OPERATOR FIX 4: the answer says plainly whether this event counts.
      // A pending_manual_verification APPROVE is recorded but never completes
      // the dual approval — the order stays where it was.
      evidenceIdentifierStatus,
      countsTowardDualApproval,
      orderStatus: recordedOrderStatus,
      dualApproved: gateAfter.dualApproved,
      missingApprovals: gateAfter.missingApprovals
    }, 201);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'FILM_ORDER_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {
        return context.json({ error: '発注状態がすでに変わっています', code: 'FILM_ORDER_STATE_CHANGED' }, 409);
      }
      throw error;
    }
  });

  /**
   * G6: the browser's approval form asks for the stored EML's own Message-ID.
   * The response deliberately contains only that header value; paths, storage
   * metadata and bytes never leave the server.
   */
  app.get('/api/document-versions/:versionId/evidence-message-id', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const versionId = context.req.param('versionId');
    if (!isUuid(versionId)) {
      return context.json({
        error: '経路パラメータ（versionId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
    const [evidence] = await db.select({
      projectId: documents.projectId,
      documentId: documents.id,
      documentType: documents.documentType,
      versionNumber: documentVersions.versionNumber,
      byteSize: documentVersions.byteSize,
      storagePath: documentVersions.storagePath
    }).from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, versionId)).limit(1);
    if (!evidence) return context.json({ error: '書類バージョンが見つかりません' }, 404);
    // Assignment is checked before any type-specific metadata is sent. A
    // foreign project gets the same missing-resource answer whether the id
    // exists or not.
    if (!user.assignedProjectIds.includes(evidence.projectId)) {
      return context.json({ error: '書類バージョンが見つかりません' }, 404);
    }
    const readDecision = canPerform(toActor(user), 'document:read', 'F1', evidence.projectId);
    if (!readDecision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (evidence.documentType !== 'approval_evidence') {
      return context.json({
        error: 'Message-IDの自動抽出は承認証跡（approval_evidence）だけが対象です',
        code: 'EVIDENCE_DOCUMENT_TYPE_INVALID'
      }, 422);
    }
    const [currentVersion] = await db.select({ id: documentVersions.id })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, evidence.documentId))
      .orderBy(desc(documentVersions.versionNumber)).limit(1);
    if (!currentVersion || currentVersion.id !== versionId) {
      return context.json({
        error: '最新版の承認証跡だけがMessage-ID自動抽出の対象です',
        code: 'EVIDENCE_VERSION_NOT_CURRENT'
      }, 422);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(evidence.storagePath);
    } catch {
      return context.json({ error: '承認証跡ファイルが読み取れません', code: 'EVIDENCE_DOCUMENT_UNREADABLE' }, 422);
    }
    const evidenceIdentifier = extractStoredEmlMessageId(bytes);
    if (evidenceIdentifier === null) {
      return context.json({
        error: '保存済みEMLからMessage-IDを自動抽出できませんでした',
        code: 'EVIDENCE_IDENTIFIER_NOT_EXTRACTABLE'
      }, 422);
    }
    const viewedAt = new Date();
    await recordAuditEvent(db, {
      projectId: evidence.projectId,
      actorUserId: user.id,
      action: 'DOCUMENT_VERSION_VIEWED',
      entityType: 'document_version',
      entityId: versionId,
      beforeState: null,
      afterState: {
        documentId: evidence.documentId,
        versionNumber: evidence.versionNumber,
        byteSize: evidence.byteSize,
        access: 'view'
      },
      occurredAt: viewedAt,
      requestMetadata: { operation: 'document_version:view', documentId: evidence.documentId }
    });
    return context.json({ evidenceIdentifier, source: 'stored_eml_message_id' });
  });

  app.get('/api/document-versions/:versionId/download', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const versionId = context.req.param('versionId');
    if (!isUuid(versionId)) {
      return context.json({
        error: '経路パラメータ（versionId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }
    const [row] = await db.select({
      projectId: documents.projectId,
      documentId: documents.id,
      documentType: documents.documentType,
      versionNumber: documentVersions.versionNumber,
      byteSize: documentVersions.byteSize,
      declaredMimeType: documentVersions.declaredMimeType,
      originalFilename: documentVersions.originalFilename,
      storagePath: documentVersions.storagePath
    }).from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, versionId)).limit(1);
    if (!row) return context.json({ error: '書類バージョンが見つかりません' }, 404);
    if (!user.assignedProjectIds.includes(row.projectId)) {
      return context.json({ error: '書類バージョンが見つかりません' }, 404);
    }
    const decision = canPerform(toActor(user), 'document:read', 'F1', row.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const storageRoot = documentStorageRoot();
    const resolvedRoot = path.resolve(storageRoot);
    const resolvedFile = path.resolve(row.storagePath);
    if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
      return context.json({ error: '書類ファイルが読み取れません', code: 'DOCUMENT_UNREADABLE' }, 404);
    }
    let fileStats;
    try {
      fileStats = await lstat(row.storagePath);
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) throw new Error('not a private regular file');
      const realParent = await realpath(path.dirname(row.storagePath));
      if (realParent !== path.dirname(resolvedFile)) throw new Error('path is not inside the validated root');
    } catch {
      return context.json({ error: '書類ファイルが読み取れません', code: 'DOCUMENT_UNREADABLE' }, 404);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(row.storagePath);
    } catch {
      return context.json({ error: '書類ファイルが読み取れません', code: 'DOCUMENT_UNREADABLE' }, 404);
    }
    if (bytes.byteLength !== row.byteSize || bytes.byteLength > documentMaxBytes()) {
      return context.json({ error: '書類ファイルの整合性が不正です', code: 'DOCUMENT_INTEGRITY_INVALID' }, 409);
    }

    const now = new Date();
    await recordAuditEvent(db, {
      projectId: row.projectId,
      actorUserId: user.id,
      action: 'DOCUMENT_VERSION_DOWNLOADED',
      entityType: 'document_version',
      entityId: versionId,
      beforeState: null,
      afterState: {
        documentId: row.documentId,
        versionNumber: row.versionNumber,
        byteSize: row.byteSize,
        access: 'download'
      },
      occurredAt: now,
      requestMetadata: { operation: 'document_version:download', documentId: row.documentId }
    });

    // RFC 5987 keeps Unicode names while the encoder also removes CR/LF and
    // header separators. Hash and storage path are deliberately not returned.
    const encodedFilename = encodeURIComponent(row.originalFilename.replace(/[\r\n]/g, ''));
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': row.declaredMimeType,
        'content-length': String(row.byteSize),
        'content-disposition': `attachment; filename*=UTF-8''${encodedFilename}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    });
  });

  // M8-OPER2 FIX 2: the representative's manual verification of a pending
  // evidence identifier. Binary evidence (PDF/image) can never prove a quoted
  // identifier by substring, so its APPROVE is recorded with
  // pending_manual_verification and stays out of the dual-approval gate until a
  // human — admin only — records what they saw in the original evidence. The
  // verification is a NEW append-only record of type evidence manual
  // verification; the approval event and its audit row are never edited, so the
  // original decision keeps reading exactly as it was recorded.
  app.post('/api/artwork-approval-events/:eventId/verification', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const eventId = context.req.param('eventId');
    if (!isUuid(eventId)) {
      return context.json({
        error: '経路パラメータ（eventId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [target] = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, eventId)).limit(1);
    if (!target) return context.json({ error: '承認イベントが見つかりません' }, 404);

    const [revision] = await db.select({
      id: artworkRevisions.id,
      filmSupplyOrderId: artworkRevisions.filmSupplyOrderId,
      designKey: artworkRevisions.designKey,
      revisionNo: artworkRevisions.revisionNo
    }).from(artworkRevisions).where(eq(artworkRevisions.id, target.artworkRevisionId)).limit(1);
    if (!revision) return context.json({ error: '版が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, revision.filmSupplyOrderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);

    // Representative only: this decision is what lets an approval complete the
    // dual approval, so it is never delegated to staff or a viewer.
    const decision = canPerform(toActor(user), 'artwork_approval:verify_evidence', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);
    if (String(order.status) === 'CANCELLED') {
      return context.json({ error: '取消終了した発注は変更できません', code: 'FILM_ORDER_CANCELLED' }, 409);
    }

    const body = await context.req.json().catch(() => null) as any;
    const resultCheck = validateEvidenceVerificationResult(body?.result);
    if (!resultCheck.ok) {
      return context.json({ error: resultCheck.message, code: resultCheck.code }, 422);
    }
    if (typeof body?.verifierName !== 'string' || body.verifierName.trim().length === 0) {
      return context.json({
        error: '検証者名（verifierName）は必須です。原本証跡を確認した人を記録してください',
        code: 'VERIFIER_NAME_REQUIRED'
      }, 422);
    }
    const verifiedAt = parseStrictRequiredDate(body?.verifiedAt);
    if (!verifiedAt.ok) {
      return context.json({
        error: '検証日時（verifiedAt）が必要です',
        code: 'VERIFIED_AT_REQUIRED'
      }, 422);
    }
    if (typeof body?.reasonNote !== 'string' || body.reasonNote.trim().length === 0) {
      return context.json({
        error: '根拠（reasonNote）は必須です。原本証跡のどこで識別子を確認したかを記録してください',
        code: 'VERIFICATION_REASON_REQUIRED'
      }, 422);
    }

    // Only an approval that is actually waiting for this check can receive it:
    // a REVOKE never contributes to an approval, an already-verified (or
    // pre-M8) APPROVE has nothing pending, and an approval without a recorded
    // identifier has nothing to confirm — insufficient evidence never completes
    // an approval here.
    if (target.decision !== 'APPROVE') {
      return context.json({
        error: 'REVOKE（承認取消）イベントは手動確認の対象ではありません',
        code: 'EVIDENCE_VERIFICATION_TARGET_INVALID'
      }, 422);
    }
    if (target.evidenceIdentifierStatus !== 'pending_manual_verification') {
      return context.json({
        error: 'この承認イベントの識別子は手動確認待ちではありません。確認済みまたは自動検証済みのイベントは確認できません',
        code: 'EVIDENCE_NOT_PENDING_MANUAL_VERIFICATION'
      }, 422);
    }
    if (!target.evidenceIdentifier) {
      return context.json({
        error: 'この承認イベントには承認証跡識別子が記録されていないため、確認できません',
        code: 'EVIDENCE_IDENTIFIER_MISSING'
      }, 422);
    }

    // A 'confirmed' verification is final: the only append-only way to
    // invalidate an approved decision afterwards is the organization's own
    // REVOKE — the same rule the approval log itself follows (migration 0007).
    // Letting a later verification flip a confirmed decision could re-open a
    // dual approval the order already moved on.
    const existingVerifications = await db.select({ result: evidenceManualVerifications.result })
      .from(evidenceManualVerifications)
      .where(eq(evidenceManualVerifications.approvalEventId, target.id));
    if (existingVerifications.some((verification) => verification.result === 'confirmed')) {
      return context.json({
        error: 'この承認イベントはすでに確認済みです。確認後の訂正は、組織の承認取消（REVOKE）として記録してください',
        code: 'EVIDENCE_ALREADY_CONFIRMED'
      }, 422);
    }

    const approvalContext = await loadApprovalContext(order.id);
    const now = new Date();
    const verificationId = uuidv7(now);
    const verification = {
      id: verificationId,
      approvalEventId: target.id,
      artworkRevisionId: target.artworkRevisionId,
      evidenceDocumentVersionId: target.evidenceDocumentVersionId,
      approvedFileSha256: target.approvedFileSha256,
      result: resultCheck.value,
      verifierName: body.verifierName.trim(),
      verifiedAt: verifiedAt.date,
      reasonNote: body.reasonNote.trim(),
      recordedByUserId: user.id,
      recordedAt: now
    };

    try {
    let recordedOrderStatus: FilmOrderStatus = order.status;
    let gateAfter = deriveOrderApprovalGate(
      approvalContext.revisions,
      approvalContext.events,
      approvalContext.verifications
    );
    const outcome = await db.transaction(async (tx) => {
      // Serialize with hold/release and review resolution. As above, a frozen
      // order can receive the verification fact but cannot be advanced by it.
      const [lockedOrder] = await tx.select().from(filmSupplyOrders)
        .where(eq(filmSupplyOrders.id, order.id)).limit(1).for('update');
      if (!lockedOrder || lockedOrder.deletedAt) throw new MakerPoStateConflict();
      if (String(lockedOrder.status) === 'CANCELLED') throw new MakerPoStateConflict();
      const lockedStatus: FilmOrderStatus = lockedOrder.status;
      // Low-2/Medium-2: a rejected first record remains correctable, but a
      // queued record must never follow a final confirmed assertion.
      const [racingVerification] = await tx.select({ result: evidenceManualVerifications.result })
        .from(evidenceManualVerifications)
        .where(and(
          eq(evidenceManualVerifications.approvalEventId, target.id),
          eq(evidenceManualVerifications.result, 'confirmed')
        ))
        .orderBy(asc(evidenceManualVerifications.recordedAt), asc(evidenceManualVerifications.id))
        .limit(1)
        .for('update');
      if (racingVerification) {
        return { kind: 'duplicateVerification' as const };
      }
      await tx.insert(evidenceManualVerifications).values(verification);
      // Medium-C: the promotion gate is recomputed from rows visible only after
      // the row lock. A confirmation queued behind a REVOKE cannot complete a
      // dual approval that no longer exists.
      const lockedApprovalContext = await loadApprovalContext(order.id, tx);
      gateAfter = deriveOrderApprovalGate(
        lockedApprovalContext.revisions,
        lockedApprovalContext.events,
        lockedApprovalContext.verifications
      );
      const advancesToDualApproved = resultCheck.value === 'confirmed'
        && shouldAdvanceToDualApproved(gateAfter, lockedStatus);
      await recordAuditEvent(tx, {
        projectId: order.projectId,
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'EVIDENCE_MANUAL_VERIFICATION_RECORDED',
        entityType: 'artwork_approval_event',
        entityId: target.id,
        afterState: {
          ...verification,
          designKey: revision.designKey,
          revisionNo: revision.revisionNo,
          organization: target.organization,
          evidenceIdentifier: target.evidenceIdentifier,
          verificationType: 'evidence_manual_verification'
        },
        occurredAt: now,
        requestMetadata: {
          operation: 'artwork_approval:verify_evidence',
          filmSupplyOrderId: order.id
        }
      });
      if (advancesToDualApproved && !isFrozenFilmOrderStatus(lockedStatus)) {
        const advanced = await tx.update(filmSupplyOrders)
          .set({ status: 'DUAL_APPROVED', updatedAt: now })
          .where(and(
            eq(filmSupplyOrders.id, order.id),
            sql`${filmSupplyOrders.status}::text = ${lockedStatus}::text`
          ))
          .returning({ id: filmSupplyOrders.id });
        if (advanced.length === 0) throw new MakerPoStateConflict();
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
          entityType: 'film_supply_order',
          entityId: order.id,
          beforeState: { status: lockedStatus },
          afterState: { status: 'DUAL_APPROVED' },
          occurredAt: now,
          requestMetadata: {
            operation: 'artwork_approval:verify_evidence',
            reason: 'dual_approval_reached_after_manual_verification'
          }
        });
        recordedOrderStatus = 'DUAL_APPROVED';
      } else {
        recordedOrderStatus = lockedStatus;
      }
    });

    const targetDesign = gateAfter.designs.find((design) =>
      design.currentRevisionId === target.artworkRevisionId);
    const targetState = targetDesign ? targetDesign[target.organization] : null;

    if (outcome?.kind === 'duplicateVerification') {
      return context.json({
        error: 'この承認イベントはすでに手動確認が記録されています。訂正は組織の承認取消（REVOKE）として記録してください',
        code: 'EVIDENCE_ALREADY_VERIFIED'
      }, 422);
    }

    return context.json({
      verification,
      // The answer says plainly what the verification did to the gate, mirroring
      // the approval endpoint's countsTowardDualApproval answer: only a
      // 'confirmed' verification whose approval now counts opens anything.
      approvalEventId: target.id,
      countsTowardDualApproval: resultCheck.value === 'confirmed' && (targetState?.valid ?? false),
      dualApproved: gateAfter.dualApproved,
      missingApprovals: gateAfter.missingApprovals,
      orderStatus: recordedOrderStatus
    }, 201);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'FILM_ORDER_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {
        return context.json({ error: '発注状態がすでに変わっています', code: 'FILM_ORDER_STATE_CHANGED' }, 409);
      }
      throw error;
    }
  });

  app.get('/api/film-supply-orders/:orderId/approval-gate', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'artwork_approval:read', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const approvalContext = await loadApprovalContext(orderId);
    const gate = deriveOrderApprovalGate(
      approvalContext.revisions,
      approvalContext.events,
      approvalContext.verifications
    );

    // M8-OPER2 FIX 2: the pending verifications the representative can act on.
    // The identifiers and evidence versions stay out of every other role's
    // answer — staff and viewer see only the derived states.
    const pendingManualVerifications = user.role !== 'admin'
      ? []
      : gate.designs.flatMap((design) => (
          (['customer', 'seven'] as const).flatMap((organization) => {
            const state = design[organization];
            if (!state.pendingEvidenceIdentifier || !state.latestEventId) return [];
            const event = approvalContext.events.find((candidate) => candidate.id === state.latestEventId);
            if (!event) return [];
            return [{
              approvalEventId: event.id,
              revisionId: design.currentRevisionId,
              designKey: design.designKey,
              revisionNo: design.currentRevisionNo,
              organization,
              evidenceDocumentVersionId: event.evidenceDocumentVersionId ?? null,
              evidenceIdentifier: event.evidenceIdentifier ?? null,
              approvedFileSha256: event.approvedFileSha256,
              eventTime: event.eventTime,
              recordedAt: event.recordedAt,
              manualVerification: state.manualVerification
            }];
          })
        ));

    return context.json({
      orderId,
      orderStatus: order.status,
      dualApproved: gate.dualApproved,
      requiredDesignKeys: gate.requiredDesignKeys,
      missingApprovals: gate.missingApprovals,
      designs: gate.designs,
      pendingManualVerifications
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
      verificationStatus: documents.verificationStatus,
      // M8-HARDEN FIX B2: which paper the document was uploaded for.
      makerPurchaseOrderId: documents.makerPurchaseOrderId,
      // M8-HARDEN FIX C1: the stored bytes, so cited evidence is verified as
      // the email it claims to be.
      declaredMimeType: documentVersions.declaredMimeType,
      storagePath: documentVersions.storagePath
    }).from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, versionId)).limit(1);
    return row ?? null;
  }

  /**
   * M8-HARDEN FIX C1: stores the send evidence the request brought inline —
   * the original .eml of the production-order mail — as the send_evidence
   * document of this paper, so the send event cites stored, hashed bytes
   * exactly like the document-cited path does. One logical document per maker
   * PO (per filename), append-only versions: identical bytes resolve to the
   * version already stored (T-27) — no new version row and no document audit
   * row for a repeat filing — and a new attempt becomes the next version.
   *
   * The size/type check here is the send-evidence intake's own: the payload is
   * not a generic upload, so a PDF declared as an EML is accepted for storage
   * and then fails the email verification (PENDING_MANUAL_VERIFICATION) instead
   * of being refused before it could be looked at.
   */
  const MAKER_PO_SEND_EVIDENCE_MIME_TYPE = 'message/rfc822';

  async function storeMakerPoSendEvidenceDocument(
    tx: MakerPoTxExecutor,
    input: {
      projectId: string;
      makerPurchaseOrderId: string;
      filmSupplyOrderId: string;
      sevenPurchaseOrderId: string | null;
      actorUserId: string;
      bytes: Buffer;
      filename: string;
    }
  ): Promise<{ documentId: string; versionId: string; sha256: string }> {
    const sha256 = computeSha256(input.bytes);
    const [existingDocument] = await tx.select().from(documents).where(and(
      eq(documents.projectId, input.projectId),
      eq(documents.documentType, 'send_evidence'),
      eq(documents.issuerEntity, 'kanei'),
      eq(documents.originalFilename, input.filename)
    )).limit(1);

    // T-27 in the send-evidence intake, the same rule the generic document
    // upload applies: bytes this paper already filed resolve to the version
    // already stored, so a repeat registration files no new version row. The
    // gap is real — two registrations of one paper inside the same wall-clock
    // second carry a byte-identical .eml (the Date header is the only byte that
    // moves, at whole-second resolution; the Message-ID, subject and body name
    // the paper, not the attempt) — and without this resolution the second
    // insert collides with document_versions_document_sha256_unique and dies as
    // an unhandled 500 instead of registering the send.
    if (existingDocument) {
      const [existingVersion] = await tx.select({ id: documentVersions.id })
        .from(documentVersions)
        .where(and(
          eq(documentVersions.documentId, existingDocument.id),
          eq(documentVersions.sha256, sha256)
        )).limit(1);
      if (existingVersion) {
        return { documentId: existingDocument.id, versionId: existingVersion.id, sha256 };
      }
    }

    let documentId = existingDocument?.id ?? '';
    let versionNumber = 1;
    if (existingDocument) {
      const [maxRow] = await tx.select({ maxVersion: sql<number>`coalesce(max(${documentVersions.versionNumber}), 0)` })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, existingDocument.id));
      versionNumber = (maxRow?.maxVersion ?? 0) + 1;
    } else {
      documentId = uuidv7();
    }
    const versionId = versionNumber === 1 ? documentId : uuidv7();

    // Identical bytes always keep referencing the same physical file (T-26).
    const storageRoot = documentStorageRoot();
    const [sharedVersion] = await tx.select({ storagePath: documentVersions.storagePath })
      .from(documentVersions)
      .where(eq(documentVersions.sha256, sha256))
      .orderBy(desc(documentVersions.createdAt))
      .limit(1);
    const storagePath = await resolveStoragePath(storageRoot, sha256, input.bytes, sharedVersion?.storagePath);

    const now = new Date();
    if (!existingDocument) {
      const newDocument = {
        id: documentId,
        projectId: input.projectId,
        documentType: 'send_evidence' as const,
        issuerEntity: 'kanei' as const,
        originalFilename: input.filename,
        note: `メーカー発注書 ${input.makerPurchaseOrderId} の送信証跡（.eml原本）`,
        preOrderReferenceId: null,
        // documents_official_artifact_requires_po: a document of any type the
        // intake does not name as an input carries the seven PO linkage.
        sevenPurchaseOrderId: input.sevenPurchaseOrderId,
        filmSupplyOrderId: input.filmSupplyOrderId,
        makerPurchaseOrderId: input.makerPurchaseOrderId,
        designKey: null,
        verificationStatus: 'unverified' as const,
        verifiedByUserId: null,
        verifiedAt: null,
        verificationNote: null,
        createdByUserId: input.actorUserId,
        createdAt: now,
        updatedAt: now
      };
      await tx.insert(documents).values(newDocument);
      await recordAuditEvent(tx, {
        projectId: input.projectId,
        id: uuidv7(now),
        actorUserId: input.actorUserId,
        action: 'DOCUMENT_CREATED',
        entityType: 'document',
        entityId: documentId,
        afterState: newDocument,
        occurredAt: now,
        requestMetadata: { operation: 'maker_po:send_evidence', documentType: 'send_evidence' }
      });
    }

    const versionRow = {
      id: versionId,
      documentId,
      versionNumber,
      sha256,
      byteSize: input.bytes.length,
      storagePath,
      originalFilename: input.filename,
      declaredMimeType: MAKER_PO_SEND_EVIDENCE_MIME_TYPE,
      detectedMimeType: null,
      sizeCheckPassed: true,
      typeCheckPassed: true,
      createdByUserId: input.actorUserId,
      createdAt: now
    };
    await tx.insert(documentVersions).values(versionRow);
    await recordAuditEvent(tx, {
      projectId: input.projectId,
      id: uuidv7(now),
      actorUserId: input.actorUserId,
      action: 'DOCUMENT_VERSION_UPLOADED',
      entityType: 'document_version',
      entityId: versionRow.id,
      afterState: {
        ...versionRow,
        issuerEntity: 'kanei',
        makerPurchaseOrderId: input.makerPurchaseOrderId
      },
      occurredAt: now,
      requestMetadata: { operation: 'maker_po:send_evidence', documentId }
    });

    return { documentId, versionId, sha256 };
  }

  app.post('/api/film-supply-orders/:orderId/maker-purchase-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:create', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    // Progressive maker-PO work stays frozen during CR/CANCELLED. Cleanup
    // endpoints remain available, but replacement paper cannot be created.
    if (String(order.status) === 'CANCELLED') {
      return context.json({
        error: '取消終了した発注のメーカー発注書は新規作成できません',
        code: 'FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }
    if (isFrozenFilmOrderStatus(order.status)) {
      return context.json({
        error: '保留・見直し中の発注のメーカー発注書は進められません。状態を解決後に記録してください',
        code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }

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
    const now = new Date();

    try {
      const outcome = await db.transaction(async (tx) => {
        // All generation gates are re-evaluated after the order lock. Body
        // parsing precedes this transaction, so a slow client cannot keep a
        // stale gate open while the order or another paper changes.
        await lockMakerPoOrderForProgressive(tx, {
          filmSupplyOrderId: orderId,
          expectedStatus: order.status
        });

        const cancelledPapers = await tx.select({ id: makerPurchaseOrders.id })
          .from(makerPurchaseOrders)
          .where(and(
            eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
            eq(makerPurchaseOrders.status, 'CANCELLED'),
            isNull(makerPurchaseOrders.deletedAt)
          ));
        const cancellationGate = evaluateMakerPoCancellationAckGate(await Promise.all(cancelledPapers.map(async (paper) => {
          const events = await tx.select({
            eventType: makerPoEvents.eventType,
            verificationStatus: makerPoEvents.verificationStatus
          }).from(makerPoEvents).where(eq(makerPoEvents.makerPurchaseOrderId, paper.id));
          const [confirmedManualSend] = await tx.select({ id: makerPoSendManualVerifications.id })
            .from(makerPoSendManualVerifications)
            .where(and(
              eq(makerPoSendManualVerifications.makerPurchaseOrderId, paper.id),
              eq(makerPoSendManualVerifications.result, 'confirmed')
            ))
            .limit(1);
          return {
            id: paper.id,
            verifiedSend: confirmedManualSend !== undefined || events.some((event) =>
              event.eventType === 'SEND_EVIDENCE_REGISTERED' && event.verificationStatus === 'VERIFIED'),
            acknowledged: events.some((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED')
          };
        })));
        if (!cancellationGate.ok) {
          return {
            kind: 'ackRequired' as const,
            error: cancellationGate.message,
            code: cancellationGate.code,
            pendingMakerPurchaseOrderId: cancellationGate.pendingMakerPurchaseOrderId
          };
        }

        const creationGate = evaluateMakerPoCreationGate({ orderStatus: order.status });
        if (!creationGate.ok) {
          return { kind: 'invalid' as const, error: creationGate.message, code: creationGate.code };
        }

        const precedenceRefusal = await sevenPoPrecedenceRefusal(order, tx);
        if (precedenceRefusal) {
          return { kind: 'invalid' as const, error: precedenceRefusal.message, code: precedenceRefusal.code };
        }

        const creationRecheck = await dualApprovalRecheck({
          order: { id: order.id, projectId: order.projectId },
          orderStatus: order.status,
          poId: null,
          stage: 'maker_po:create',
          actorUserId: user.id,
          now
        }, tx);
        if (creationRecheck) return { kind: 'invalid' as const, ...creationRecheck };

        const [activeMakerPo] = await tx.select({
          id: makerPurchaseOrders.id,
          status: makerPurchaseOrders.status
        }).from(makerPurchaseOrders).where(and(
          eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
          isNull(makerPurchaseOrders.deletedAt)
        ))
          .orderBy(sql`case when ${makerPurchaseOrders.status} = 'CANCELLED' then 1 else 0 end`)
          .limit(1)
          .for('update');
        if (activeMakerPo && activeMakerPo.status !== 'CANCELLED') {
          return {
            kind: 'activePaper' as const,
            existingMakerPurchaseOrderId: activeMakerPo.id,
            existingStatus: activeMakerPo.status
          };
        }

        const parts = await loadMakerPoSnapshotParts(tx, orderId);
        const snapshot = buildMakerPoSnapshot({
          order: { id: parts.order.id, code: parts.order.code, sevenPoNumber: parts.sevenPoNumber },
          items: parts.lines,
          artworkFiles: parts.artworkFiles,
          amounts,
          recipientAddress: body.recipientAddress
        });
        const snapshotSha256 = computeMakerPoSnapshotSha256(snapshot);
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
        return { kind: 'created' as const, purchaseOrder };
      });

      if (outcome.kind === 'ackRequired') {
        return context.json({
          error: outcome.error,
          code: outcome.code,
          pendingMakerPurchaseOrderId: outcome.pendingMakerPurchaseOrderId
        }, 422);
      }
      if (outcome.kind === 'invalid') {
        return context.json({
          error: outcome.error,
          code: outcome.code,
          ...('missingApprovals' in outcome ? { missingApprovals: outcome.missingApprovals } : {})
        }, 422);
      }
      if (outcome.kind === 'activePaper') {
        return context.json({
          error: `この発注には既に有効なメーカー発注書があります（${outcome.existingMakerPurchaseOrderId}）。発注内容を訂正する場合は、既存の発注書を取り消してから新しい発注書を作成してください。`,
          code: 'MAKER_PO_ALREADY_EXISTS',
          existingMakerPurchaseOrderId: outcome.existingMakerPurchaseOrderId,
          existingStatus: outcome.existingStatus
        }, 422);
      }
      return context.json(buildMakerPoViewForRole(user.role, outcome.purchaseOrder), 201);
    } catch (error) {
      if (makerPoActiveUniqueViolation(error)) {
        return context.json({
          error: `この発注には既に有効なメーカー発注書があります。発注内容を訂正する場合は、既存の発注書を取り消してから新しい発注書を作成してください。`,
          code: 'MAKER_PO_ALREADY_EXISTS'
        }, 422);
      }
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {
        return context.json({ error: '発注状態がすでに変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  app.post('/api/maker-purchase-orders/:poId/ceo-approval', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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

    // A hold freezes the whole maker-PO workflow. Letting the paper advance
    // while the order stays behind makes release unable to catch up (M2).
    if (String(order.status) === 'CANCELLED') {
      return context.json({
        error: '取消終了した発注のメーカー発注書は操作できません',
        code: 'FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }
    if (isFrozenFilmOrderStatus(order.status)) {
      return context.json({
        error: '保留・見直し中の発注のメーカー発注書は進められません。状態を解決後に記録してください',
        code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }

    const poStatus = validateMakerPoStatus(existing.status);
    if (!poStatus.ok) return context.json({ error: poStatus.message, code: poStatus.code }, 422);
    const approval = evaluateMakerPoApproval(poStatus.value);
    if (!approval.ok) {
      return context.json({ error: approval.message, code: approval.code, from: approval.from }, 422);
    }

    // M7-SEC3 FIX 3: the G6 payment gate (design "G6 결제 조건" and its maker-PO
    // approval condition applicable_payment_gate_satisfied). The CEO approves
    // maker paper only for an order whose transaction terms are settled; an
    // order that never recorded a term (or still reads 'undetermined') is
    // refused here, before anything is written.
    const paymentGate = evaluatePaymentGate({ paymentTerms: order.paymentTerms });
    if (!paymentGate.ok) {
      return context.json({
        error: paymentGate.message,
        code: paymentGate.code,
        paymentTerms: paymentGate.paymentTerms
      }, 422);
    }

    // M8-OPER3: the representative's approval is the last pre-send act, so the
    // dual approval it certifies is re-derived here too — a withdrawal recorded
    // between the order reaching MAKER_PO_READY and this approval must not be
    // certified over.
    const approvalRecheck = await dualApprovalRecheck({
      order: { id: order.id, projectId: order.projectId },
      orderStatus: order.status,
      poId,
      stage: 'maker_po:ceo_approve',
      actorUserId: user.id,
      now: new Date()
    });
    if (approvalRecheck) return context.json(approvalRecheck, 422);

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        await lockMakerPoOrderForProgressive(tx, {
          filmSupplyOrderId: existing.filmSupplyOrderId,
          expectedStatus: order.status
        });
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
          afterState: {
            status: 'APPROVED_FOR_MANUAL_SEND',
            snapshotSha256,
            approvedByUserId: user.id,
            // M7-SEC3 FIX 3: the approval audit names the G6 result it approved
            // under, so the paper trail shows the payment gate was open.
            paymentGate: {
              applicable: true,
              satisfied: true,
              paymentTerms: paymentGate.paymentTerms,
              gatedOn: paymentGate.gatedOn
            }
          },
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
        await mirrorMakerPoFilmOrderTransition(tx, {
          projectId: order.projectId,
          actorUserId: user.id,
          filmSupplyOrderId: po.filmSupplyOrderId,
          expectedStatus: order.status,
          nextStatus: 'APPROVED_FOR_MANUAL_SEND',
          operation: 'maker_po:ceo_approve',
          reason: 'maker_po_approved',
          occurredAt: now
        });

        return {
          purchaseOrder: buildMakerPoViewForRole(user.role, {
            id: poId,
            filmSupplyOrderId: po.filmSupplyOrderId,
            snapshot,
            snapshotSha256,
            status: 'APPROVED_FOR_MANUAL_SEND',
            ceoApprovedByUserId: user.id,
            ceoApprovedAt: now,
            createdByUserId: po.createdByUserId,
            createdAt: po.createdAt,
            updatedAt: now
          }),
          approvalEvent
        };
      });
      return context.json(outcome, 200);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
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
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:send_evidence', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    // A hold freezes the whole maker-PO workflow. Letting the paper advance
    // while the order stays behind makes release unable to catch up (M2).
    if (String(order.status) === 'CANCELLED') {
      return context.json({
        error: '取消終了した発注のメーカー発注書は操作できません',
        code: 'FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }
    if (isFrozenFilmOrderStatus(order.status)) {
      return context.json({
        error: '保留・見直し中の発注のメーカー発注書は進められません。状態を解決後に記録してください',
        code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }

    const body = await context.req.json().catch(() => null) as any;
    const sentAt = parseOptionalDate(body?.sentAt);
    if (!sentAt.ok) return context.json({ error: '送信日時が不正です', code: 'INVALID_DATE' }, 422);
    const sendEvidenceId = optionalUuidInput(body?.evidenceDocumentVersionId);
    if (!sendEvidenceId.ok) {
      return context.json({
        error: '引用された送信証跡のドキュメントバージョンIDが不正です',
        code: 'SEND_EVIDENCE_DOCUMENT_VERSION_INVALID'
      }, 422);
    }

    // M8-HARDEN FIX C2: a send claimed more than ten minutes ahead of the server
    // clock is impossible, not early. The comparison is UTC (Date.getTime), so a
    // timezone-shifted client value cannot slip past it. Malformed request
    // fields are refused here, before the boundary re-check writes its audit row
    // — the same place INVALID_DATE is refused.
    const serverNow = new Date();
    if (sentAt.date !== null) {
      const currency = evaluateMakerPoSentAtCurrency({ sentAt: sentAt.date, now: serverNow });
      if (!currency.ok) {
        return context.json({
          error: currency.message,
          code: currency.code,
          serverNow: currency.serverNow,
          sentAt: currency.sentAt
        }, 422);
      }
    }
    // FIX C1: the evidence itself arrives inline — the original .eml exported
    // from Thunderbird's Sent folder. Its bytes are stored as the send_evidence
    // document of this paper and then verified as an email; a cited document
    // version keeps working the same way, through its stored bytes.
    let inlineEmlBytes: Buffer | null = null;
    if (body?.contentBase64 !== undefined && body?.contentBase64 !== null) {
      if (typeof body.contentBase64 !== 'string' || body.contentBase64.length === 0) {
        return context.json({
          error: 'contentBase64 には送信証跡（.eml原本）のBase64データを指定してください',
          code: 'SEND_EVIDENCE_CONTENT_REQUIRED'
        }, 422);
      }
      inlineEmlBytes = Buffer.from(body.contentBase64, 'base64');
      if (inlineEmlBytes.length === 0) {
        return context.json({
          error: 'contentBase64 を送信証跡のバイト列として解釈できませんでした',
          code: 'SEND_EVIDENCE_CONTENT_INVALID'
        }, 422);
      }
      if (inlineEmlBytes.length > documentMaxBytes()) {
        return context.json({
          error: `送信証跡が ${documentMaxBytes()} バイトの上限を超えています`,
          code: 'DOCUMENT_TOO_LARGE'
        }, 422);
      }
    }

    // M8-OPER3: the send is the point of no return, so the gate is re-derived
    // here — but only for paper that has not shipped yet. A send already proven
    // by a verified evidence document is history: the re-check is recorded in
    // the audit trail and the registration is answered normally.
    const sendRecheck = await dualApprovalRecheck({
      order: { id: order.id, projectId: order.projectId },
      orderStatus: order.status,
      poId,
      stage: 'maker_po:send_evidence',
      actorUserId: user.id,
      now: new Date()
    });
    if (sendRecheck) return context.json(sendRecheck, 422);

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        await lockMakerPoOrderForProgressive(tx, {
          filmSupplyOrderId: existing.filmSupplyOrderId,
          expectedStatus: order.status
        });
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

        // M8-HARDEN FIX C1: resolve the evidence bytes. The inline .eml payload
        // is stored first (one logical send_evidence document per paper,
        // append-only versions), and a cited document version is read back from
        // its stored bytes — either way the verification runs on the evidence
        // itself, never on the facts the request merely declares.
        let emlBytes: Buffer | null = inlineEmlBytes;
        let evidenceDocument: MakerPoEvidenceDocument | null = null;
        let evidenceDocumentVersionId: string | null = requestedEvidenceId;
        if (inlineEmlBytes !== null) {
          const stored = await storeMakerPoSendEvidenceDocument(tx, {
            projectId: order.projectId,
            makerPurchaseOrderId: poId,
            filmSupplyOrderId: order.id,
            sevenPurchaseOrderId: order.sevenPurchaseOrderId,
            actorUserId: user.id,
            bytes: inlineEmlBytes,
            filename: `maker-po-${poId}-send-evidence.eml`
          });
          evidenceDocument = await loadMakerPoEvidenceDocument(tx, stored.versionId);
          evidenceDocumentVersionId = stored.versionId;
        } else if (requestedEvidenceId !== null) {
          evidenceDocument = await loadMakerPoEvidenceDocument(tx, requestedEvidenceId);
          if (evidenceDocument !== null) {
            try {
              emlBytes = await readFile(evidenceDocument.storagePath ?? '');
            } catch {
              // The bytes behind the cited version are gone, so nothing about
              // them can be verified — the same refusal the approval path gives.
              return {
                kind: 'invalid' as const,
                code: 'SEND_EVIDENCE_DOCUMENT_UNREADABLE',
                message: '引用された送信証跡ファイルが読み取れないため、内容を検証できません'
              };
            }
          }
        }

        const evaluation = evaluateMakerPoSendEvidence({
          evidenceDocumentVersionId,
          senderAddress: body?.senderAddress,
          recipients: body?.recipients,
          sentAt: sentAt.date,
          attachmentHashes: body?.attachmentHashes,
          emlBytes
        }, {
          order: { id: order.id, projectId: order.projectId },
          approvedSnapshotSha256: po.snapshotSha256,
          currentSnapshotSha256,
          snapshot: currentSnapshot,
          evidenceDocument,
          ceoApprovedAt: po.ceoApprovedAt,
          now
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

        // M8-HARDEN FIX C1: only a VERIFIED send moves the paper. A pending one
        // leaves the paper where it is — the send is recorded with its failed
        // checks and a corrected .eml can be registered afterwards; an
        // UNVERIFIED (timestamp-only) registration still parks it in the T-21
        // dead end.
        const targetStatus = evaluation.verificationStatus === 'VERIFIED'
          ? 'MAKER_PO_SENT_MANUALLY' as const
          : evaluation.verificationStatus === 'UNVERIFIED'
            ? 'SEND_UNVERIFIED' as const
            : poStatus.value;
        const updated = await tx.update(makerPurchaseOrders).set({ status: targetStatus, updatedAt: now })
          .where(and(eq(makerPurchaseOrders.id, poId), eq(makerPurchaseOrders.status, poStatus.value)))
          .returning({ id: makerPurchaseOrders.id });
        if (updated.length === 0) throw new MakerPoStateConflict();

        const sentAtValue = typeof evaluation.sentAt === 'string' ? new Date(evaluation.sentAt) : evaluation.sentAt;
        // Narrowed once: the timestamp-only shape carries no evidence facts, the
        // other two carry the verification result and the facts it proved.
        const evidenceFacts = evaluation.verificationStatus === 'UNVERIFIED'
          ? {
            evidenceDocumentVersionId: null as string | null,
            senderAddress: null as string | null,
            recipients: null as Array<string> | null,
            attachmentHashes: null as Array<string> | null,
            verificationMethod: null as string | null,
            verificationChecks: null as unknown,
            verificationNote: null as string | null,
            pendingCode: null as string | null,
            pendingCodes: [] as string[]
          }
          : {
            evidenceDocumentVersionId: evaluation.evidenceDocumentVersionId,
            senderAddress: evaluation.senderAddress,
            recipients: evaluation.recipients,
            attachmentHashes: evaluation.attachmentHashes,
            verificationMethod: evaluation.verification.verificationMethod,
            verificationChecks: evaluation.verification.verificationChecks,
            verificationNote: evaluation.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
              ? evaluation.reasonNote
              : null,
            pendingCode: evaluation.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
              ? evaluation.pendingCode
              : null,
            pendingCodes: evaluation.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
              ? evaluation.pendingCodes
              : []
          };
        const sendEvent = {
          id: uuidv7(now),
          makerPurchaseOrderId: poId,
          eventType: 'SEND_EVIDENCE_REGISTERED' as const,
          evidenceDocumentVersionId: evidenceFacts.evidenceDocumentVersionId,
          senderAddress: evidenceFacts.senderAddress,
          recipients: evidenceFacts.recipients,
          sentAt: sentAtValue,
          attachmentHashes: evidenceFacts.attachmentHashes,
          verificationStatus: evaluation.verificationStatus,
          // M8-HARDEN FIX C1: how the evidence was verified, the machine-readable
          // check list, and — when pending — why a human has to look at it.
          verificationMethod: evidenceFacts.verificationMethod,
          verificationChecks: evidenceFacts.verificationChecks,
          verificationNote: evidenceFacts.verificationNote,
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
            : evaluation.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
              ? 'MAKER_PO_SEND_PENDING_MANUAL_VERIFICATION'
              : 'MAKER_PO_SEND_RECORDED_UNVERIFIED',
          entityType: 'maker_po_event',
          entityId: sendEvent.id,
          beforeState: { status: poStatus.value },
          afterState: {
            status: targetStatus,
            event: sendEvent,
            // FIX C1: an EML being stored is not proof of delivery. VERIFIED
            // means the email content and its recipient were verified; delivery
            // is asserted only by the representative's manual verification.
            deliveryAsserted: evaluation.verificationStatus === 'VERIFIED'
              ? 'not_asserted_by_this_event'
              : null
          },
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
          await mirrorMakerPoFilmOrderTransition(tx, {
            projectId: order.projectId,
            actorUserId: user.id,
            filmSupplyOrderId: po.filmSupplyOrderId,
            expectedStatus: order.status,
            nextStatus: 'MAKER_PO_SENT_MANUALLY',
            operation: 'maker_po:send_evidence',
            reason: 'maker_po_sent',
            occurredAt: now
          });
        }

        return {
          kind: 'applied' as const,
          status: targetStatus,
          verificationStatus: evaluation.verificationStatus,
          verificationMethod: evidenceFacts.verificationMethod,
          verificationChecks: evidenceFacts.verificationChecks,
          verificationNote: evidenceFacts.verificationNote,
          pendingCode: evidenceFacts.pendingCode,
          pendingCodes: evidenceFacts.pendingCodes,
          event: sendEvent,
          // M8-OPERATOR FIX 1: staff register the send, so their answer carries
          // the work view; an admin caller still gets the whole frozen paper.
          purchaseOrder: buildMakerPoViewForRole(user.role, {
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
          })
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
        // FIX C1: what the evidence was verified as, the check list a reviewer
        // reads, and the reason a pending registration waits for a human.
        verificationMethod: outcome.verificationMethod,
        verificationChecks: outcome.verificationChecks,
        verificationNote: outcome.verificationNote,
        pendingCode: outcome.pendingCode,
        pendingCodes: outcome.pendingCodes,
        // Storing the EML is not proof of delivery: VERIFIED means the email
        // content and its recipient were verified against the frozen paper.
        // Delivery is asserted only by the representative's manual verification.
        deliveryAssertedByManualVerification: false,
        event: outcome.event,
        purchaseOrder: outcome.purchaseOrder
      }, 200);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {

        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  // M8-HARDEN FIX C1: the manual verification of a send event whose evidence
  // could not be auto-verified. Mirrors the approval-evidence manual
  // verification (M8-OPER2): an append-only record naming the verifier, the
  // time they checked and the reason. This is the only place a delivery is
  // asserted — storing or even verifying the EML is not proof of delivery.
  //
  // M8-HARDEN2 FIX 3: a 'confirmed' verification is also what lets the chain
  // proceed — the paper moves to MAKER_PO_SENT_MANUALLY exactly as a VERIFIED
  // send would have moved it, so acceptance becomes reachable. While the send
  // event is still only PENDING_MANUAL_VERIFICATION the acceptance gate stays
  // shut. A 'rejected' verification asserts no delivery and moves nothing.
  // Double-processing is refused, not idempotent: a second 'confirmed' record
  // for the same event is 422 MAKER_PO_SEND_ALREADY_CONFIRMED (a retraction is
  // a new record, never an edit), per the migration 0018 rules the table
  // enforces with its append-only trigger.
  app.post('/api/maker-po-events/:eventId/send-manual-verification', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const eventId = context.req.param('eventId');
    if (!isUuid(eventId)) {
      return context.json({
        error: '経路パラメータ（eventId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [target] = await db.select().from(makerPoEvents)
      .where(eq(makerPoEvents.id, eventId)).limit(1);
    if (!target) return context.json({ error: 'メーカー発注イベントが見つかりません' }, 404);
    const [po] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, target.makerPurchaseOrderId)).limit(1);
    if (!po) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, po.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);

    // Representative only: this record asserts a delivery, so it is never
    // delegated (the same rule as the approval evidence verification).
    const decision = canPerform(toActor(user), 'maker_po:verify_send', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    // A hold freezes the whole maker-PO workflow. Letting the paper advance
    // while the order stays behind makes release unable to catch up (M2).
    if (String(order.status) === 'CANCELLED') {
      return context.json({
        error: '取消終了した発注のメーカー発注書は操作できません',
        code: 'FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }
    if (isFrozenFilmOrderStatus(order.status)) {
      return context.json({
        error: '保留・見直し中の発注のメーカー発注書は進められません。状態を解決後に記録してください',
        code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }

    const body = await context.req.json().catch(() => null) as any;
    const resultCheck = validateEvidenceVerificationResult(body?.result);
    if (!resultCheck.ok) return context.json({ error: resultCheck.message, code: resultCheck.code }, 422);
    if (typeof body?.verifierName !== 'string' || body.verifierName.trim().length === 0) {
      return context.json({
        error: '検証者名（verifierName）は必須です。原本を確認した人を記録してください',
        code: 'VERIFIER_NAME_REQUIRED'
      }, 422);
    }
    const verifiedAt = parseStrictRequiredDate(body?.verifiedAt);
    if (!verifiedAt.ok) {
      return context.json({ error: '検証日時（verifiedAt）が必要です', code: 'VERIFIED_AT_REQUIRED' }, 422);
    }
    if (verifiedAt.date.getTime() > Date.now() + 5 * 60 * 1000) {
      return context.json({ error: '検証日時（verifiedAt）に未来時刻は記録できません', code: 'VERIFIED_AT_IN_FUTURE' }, 422);
    }
    if (verifiedAt.date.getTime() < Date.UTC(2000, 0, 1)) {
      return context.json({ error: '検証日時（verifiedAt）が許容範囲外です', code: 'VERIFIED_AT_OUT_OF_RANGE' }, 422);
    }
    if (typeof body?.reasonNote !== 'string' || body.reasonNote.trim().length === 0) {
      return context.json({
        error: '根拠（reasonNote）は必須です。何を確認して納品を断定したかを記録してください',
        code: 'VERIFICATION_REASON_REQUIRED'
      }, 422);
    }
    if (target.eventType !== 'SEND_EVIDENCE_REGISTERED') {
      return context.json({
        error: '送信イベントのみ手動確認の対象です',
        code: 'MAKER_PO_SEND_VERIFICATION_TARGET_INVALID'
      }, 422);
    }
    if (target.verificationStatus !== 'PENDING_MANUAL_VERIFICATION') {
      return context.json({
        error: 'この送信イベントは手動確認待ちではありません。確認済み・自動検証済み・未検証のイベントは確認できません',
        code: 'MAKER_PO_SEND_NOT_PENDING_MANUAL_VERIFICATION'
      }, 422);
    }
    // A 'confirmed' verification is final, exactly like the approval evidence
    // one: the only append-only way to retract it is a new event, never an edit.
    const existingVerifications = await db.select({ result: makerPoSendManualVerifications.result })
      .from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, target.id));
    if (existingVerifications.some((verification) => verification.result === 'confirmed')) {
      return context.json({
        error: 'この送信イベントはすでに確認済みです。納品の断定を取り消す場合は、新しい記録として残してください',
        code: 'MAKER_PO_SEND_ALREADY_CONFIRMED'
      }, 422);
    }

    const now = new Date();
    const verification = {
      id: uuidv7(now),
      makerPoEventId: target.id,
      makerPurchaseOrderId: po.id,
      result: resultCheck.value,
      verifierName: body.verifierName.trim(),
      verifiedAt: verifiedAt.date,
      reasonNote: body.reasonNote.trim(),
      recordedByUserId: user.id,
      recordedAt: now
    };
    try {
    const outcome = await db.transaction(async (tx) => {
        await lockMakerPoOrderForProgressive(tx, {
          filmSupplyOrderId: po.filmSupplyOrderId,
          expectedStatus: order.status
        });
      // A pending send can outlive a cancelled paper. Refuse a post-cancellation
      // delivery assertion so it cannot authorize replacement work beside a
      // paper the representative already cancelled.
      const [lockedPaper] = await tx.select().from(makerPurchaseOrders)
        .where(eq(makerPurchaseOrders.id, po.id)).limit(1).for('update');
      if (!lockedPaper) throw new MakerPoStateConflict();
      if (lockedPaper.status === 'CANCELLED') {
        return {
          kind: 'cancelled' as const,
          code: 'MAKER_PO_CANCELLED_SEND_CONFIRMATION_BLOCKED' as const,
          message: '取り消し済みのメーカー発注書の送信は確認できません'
        };
      }
      if (resultCheck.value === 'confirmed') {
        const [racingConfirmed] = await tx.select({ id: makerPoSendManualVerifications.id })
          .from(makerPoSendManualVerifications)
          .where(and(
            eq(makerPoSendManualVerifications.makerPoEventId, target.id),
            eq(makerPoSendManualVerifications.result, 'confirmed')
          ))
          .limit(1);
        if (racingConfirmed) {
          return { kind: 'duplicateConfirmed' as const };
        }
      }
      await tx.insert(makerPoSendManualVerifications).values(verification);
      await recordAuditEvent(tx, {
        projectId: order.projectId,
        id: uuidv7(now),
        actorUserId: user.id,
        action: 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED',
        entityType: 'maker_po_event',
        entityId: target.id,
        afterState: {
          ...verification,
          verificationType: 'maker_po_send_manual_verification',
          // The delivery assertion lives here and only here.
          deliveryAsserted: resultCheck.value === 'confirmed'
        },
        occurredAt: now,
        requestMetadata: {
          operation: 'maker_po:verify_send',
          filmSupplyOrderId: order.id,
          makerPurchaseOrderId: po.id
        }
      });

      // M8-HARDEN2 FIX 3: a confirmed verification is the delivery assertion a
      // VERIFIED send never was, so it carries the paper across the same step a
      // VERIFIED send does — the paper leaves the company and the acceptance
      // gate opens. A rejected verification asserts the opposite and moves
      // nothing. The move is guarded by the status the paper still holds: paper
      // that has already moved on (a corrected .eml verified in the meantime) or
      // that was cancelled after the pending send is left exactly where it is.
      let statusChanged: { from: string; to: string } | null = null;
      if (resultCheck.value === 'confirmed') {
        // Only the state a VERIFIED send would have moved — the approved paper a
        // pending send left where it was — may be carried forward. Paper that has
        // moved on since (voided, cancelled, already sent, accepted) stays put.
        const poStatus = validateMakerPoStatus(po.status);
        if (poStatus.ok && transitionMakerPurchaseOrder(poStatus.value, 'MAKER_PO_SENT_MANUALLY').ok) {
          const moved = await tx.update(makerPurchaseOrders)
            .set({ status: 'MAKER_PO_SENT_MANUALLY' as const, updatedAt: now })
            .where(and(
              eq(makerPurchaseOrders.id, po.id),
              eq(makerPurchaseOrders.status, poStatus.value)
            ))
            .returning({ id: makerPurchaseOrders.id, status: makerPurchaseOrders.status });
          if (moved.length > 0) {
            statusChanged = { from: poStatus.value, to: 'MAKER_PO_SENT_MANUALLY' };
            await recordAuditEvent(tx, {
              projectId: order.projectId,
              id: uuidv7(now),
              actorUserId: user.id,
              action: 'MAKER_PO_STATUS_CHANGED',
              entityType: 'maker_purchase_order',
              entityId: po.id,
              beforeState: { status: poStatus.value },
              afterState: {
                status: 'MAKER_PO_SENT_MANUALLY',
                reason: 'send_manual_verification_confirmed',
                makerPoEventId: target.id,
                // The send event keeps its PENDING_MANUAL_VERIFICATION status:
                // maker_po_events are append-only, and the content verification
                // of its evidence never becomes the delivery assertion.
                eventVerificationStatusUnchanged: true
              },
              occurredAt: now,
              requestMetadata: { operation: 'maker_po:verify_send', makerPurchaseOrderId: po.id }
            });

            await mirrorMakerPoFilmOrderTransition(tx, {
              projectId: order.projectId,
              actorUserId: user.id,
              filmSupplyOrderId: po.filmSupplyOrderId,
              expectedStatus: order.status,
              nextStatus: 'MAKER_PO_SENT_MANUALLY',
              operation: 'maker_po:verify_send',
              reason: 'send_manual_verification_confirmed',
              occurredAt: now
            });
          }
        }
      }

      const [currentPo] = await tx.select().from(makerPurchaseOrders)
        .where(eq(makerPurchaseOrders.id, po.id)).limit(1);
      return { statusChanged, purchaseOrder: currentPo ?? po };
    });

    if (outcome.kind === 'cancelled') {
      return context.json({ error: outcome.message, code: outcome.code }, 409);
    }
    if (outcome.kind === 'duplicateConfirmed') {
      return context.json({
        error: 'この送信イベントはすでに確認済みです。納品の断定を取り消す場合は、新しい記録として残してください',
        code: 'MAKER_PO_SEND_ALREADY_CONFIRMED'
      }, 422);
    }

    return context.json({
      verification,
      makerPoEventId: target.id,
      deliveryAsserted: resultCheck.value === 'confirmed',
      // FIX 3: the chain proceeds exactly like a VERIFIED send — the paper is at
      // MAKER_PO_SENT_MANUALLY and the acceptance gate is open. Null when the
      // paper had already moved (or the verification rejected the send).
      purchaseOrderStatusChanged: outcome.statusChanged,
      purchaseOrder: buildMakerPoViewForRole(user.role, outcome.purchaseOrder as MakerPoRecord)
    }, 201);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {
        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  // M8-HARDEN FIX B2 (c): the explicit replacement step (정정·재발주). The old
  // paper is cancelled — an append-only MAKER_PO_CANCELLED event, an audit row,
  // status CANCELLED, no row deleted — and only then can a new maker PO freeze
  // for the same order. Admin only: freeing live paper is the representative's
  // decision, exactly like freezing it was.
  app.post('/api/maker-purchase-orders/:poId/cancel', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:cancel', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '代表者のみ取り消せます' }, 403);

    const body = await context.req.json().catch(() => null) as any;
    const noteCheck = normalizeRequiredReason(body?.note);
    if (!noteCheck.ok) {
      return context.json({
        error: noteCheck.tooLong
          ? `取消理由（note）は${REASON_MAX_LENGTH}文字以下の可視文字で入力してください`
          : '取消理由（note）は必須です。訂正・再発注の理由を記録してください',
        code: noteCheck.tooLong ? 'MAKER_PO_CANCEL_REASON_TOO_LONG' : 'MAKER_PO_CANCEL_REASON_REQUIRED'
      }, 422);
    }
    const cancelNote = noteCheck.text;

    const poStatus = validateMakerPoStatus(existing.status);
    if (!poStatus.ok) return context.json({ error: poStatus.message, code: poStatus.code }, 422);
    const cancellation = evaluateMakerPoCancellation(poStatus.value);
    if (!cancellation.ok) {
      return context.json({ error: cancellation.message, code: cancellation.code, from: cancellation.from }, 422);
    }

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        // Lock the order before deciding the mirror. A concurrent move into an
        // exception/closed state must never be overwritten by this cleanup.
        const [lockedOrder] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1).for('update');
        if (!lockedOrder || lockedOrder.deletedAt) throw new MakerPoStateConflict();

        // M8-HARDEN2 FIX 2: the cancellation is classified by what the paper
        // already did. A proven send means the production-order mail left the
        // company, so the replacement needs the representative's acknowledgement
        // before a new maker PO may freeze for the order.
        const [verifiedSend] = await tx.select({ id: makerPoEvents.id })
          .from(makerPoEvents)
          .where(and(
            eq(makerPoEvents.makerPurchaseOrderId, poId),
            eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED'),
            eq(makerPoEvents.verificationStatus, 'VERIFIED')
          ))
          .limit(1);
        const [confirmedManualSend] = await tx.select({ id: makerPoSendManualVerifications.id })
          .from(makerPoSendManualVerifications)
          .where(and(
            eq(makerPoSendManualVerifications.makerPurchaseOrderId, poId),
            eq(makerPoSendManualVerifications.result, 'confirmed')
          ))
          .limit(1);
        const provenSend = verifiedSend !== undefined || confirmedManualSend !== undefined;
        const cancellation = classifyMakerPoCancellation({ verifiedSend: provenSend });

        const updated = await tx.update(makerPurchaseOrders)
          .set({ status: 'CANCELLED' as const, updatedAt: now })
          .where(and(eq(makerPurchaseOrders.id, poId), eq(makerPurchaseOrders.status, poStatus.value)))
          .returning({ id: makerPurchaseOrders.id });
        if (updated.length === 0) throw new MakerPoStateConflict();

        const cancelEvent = {
          id: uuidv7(now),
          makerPurchaseOrderId: poId,
          eventType: 'MAKER_PO_CANCELLED' as const,
          verificationStatus: 'UNVERIFIED' as const,
          recordedByUserId: user.id,
          recordedAt: now
        };
        await tx.insert(makerPoEvents).values(cancelEvent);

        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_CANCELLED',
          entityType: 'maker_po_event',
          entityId: cancelEvent.id,
          beforeState: { status: poStatus.value },
          afterState: {
            status: 'CANCELLED',
            note: cancelNote,
            // FIX 2: which cancellation this was, and what it takes to replace
            // the paper. An internal cancel frees the order immediately; a
            // cancelled paper whose send was proven stays closed until the
            // acknowledgement is recorded.
            cancellationKind: cancellation.kind,
            verifiedSend: cancellation.verifiedSend,
            newMakerPoRequiresCancellationAcknowledgement: cancellation.acknowledgementRequired,
            // History is preserved: the rows stay, a new maker PO replaces them.
            rowsDeleted: false,
            replacementStep: 'cancel_then_create_new_maker_po'
          },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:cancel', makerPurchaseOrderId: poId }
        });
        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_STATUS_CHANGED',
          entityType: 'maker_purchase_order',
          entityId: poId,
          beforeState: { status: poStatus.value },
          afterState: { status: 'CANCELLED' },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:cancel' }
        });

        // FIX B2 (c): a live order is explicitly allowed to reverse from the
        // maker-chain step back to the ordering step after its paper is retired.
        // This intended backward recovery applies only when no other live paper
        // remains. A proven/confirmed send stays gated until acknowledgement,
        // while frozen and closed orders remain under their own recovery flows.
        const makerChainReopenStates = [
          'APPROVED_FOR_MANUAL_SEND',
          'MAKER_PO_SENT_MANUALLY',
          'MAKER_PO_ACCEPTED'
        ] as const;
        const [remainingLivePaper] = await tx.select({ id: makerPurchaseOrders.id })
          .from(makerPurchaseOrders)
          .where(and(
            eq(makerPurchaseOrders.filmSupplyOrderId, lockedOrder.id),
            ne(makerPurchaseOrders.id, poId),
            ne(makerPurchaseOrders.status, 'CANCELLED'),
            isNull(makerPurchaseOrders.deletedAt)
          ))
          .limit(1)
          .for('update');
        if (!cancellation.acknowledgementRequired
          && !isFrozenFilmOrderStatus(lockedOrder.status)
          && !remainingLivePaper
          && (makerChainReopenStates as readonly string[]).includes(String(lockedOrder.status))) {
          const reopened = await tx.update(filmSupplyOrders)
            .set({ status: 'MAKER_PO_READY', updatedAt: now })
            .where(and(
              eq(filmSupplyOrders.id, lockedOrder.id),
              eq(filmSupplyOrders.status, lockedOrder.status)
            ))
            .returning({ id: filmSupplyOrders.id });
          if (reopened.length > 0) {
            await recordAuditEvent(tx, {
              projectId: order.projectId,
              id: uuidv7(now),
              actorUserId: user.id,
              action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
              entityType: 'film_supply_order',
              entityId: lockedOrder.id,
              beforeState: { status: lockedOrder.status },
              afterState: { status: 'MAKER_PO_READY' },
              occurredAt: now,
              requestMetadata: {
                operation: 'maker_po:cancel',
                reason: 'maker_po_cancelled_reopens_the_ordering_step',
                intendedReverseRecovery: true
              }
            });
          }
        }

        return {
          event: cancelEvent,
          cancellation,
          purchaseOrder: buildMakerPoViewForRole(user.role, {
            id: poId,
            filmSupplyOrderId: existing.filmSupplyOrderId,
            snapshot: existing.snapshot as MakerPoSnapshot,
            snapshotSha256: existing.snapshotSha256,
            status: 'CANCELLED',
            ceoApprovedByUserId: existing.ceoApprovedByUserId,
            ceoApprovedAt: existing.ceoApprovedAt,
            createdByUserId: existing.createdByUserId,
            createdAt: existing.createdAt,
            updatedAt: now
          })
        };
      });
      return context.json({
        status: 'CANCELLED',
        // M8-HARDEN2 FIX 2: which cancellation this was, and whether the
        // representative has to acknowledge it before replacement paper freezes.
        cancellationKind: outcome.cancellation.kind,
        newMakerPoRequiresCancellationAcknowledgement: outcome.cancellation.acknowledgementRequired,
        event: outcome.event,
        purchaseOrder: outcome.purchaseOrder
      }, 200);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {

        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  // M8-HARDEN2 FIX 2: the representative's acknowledgement of a cancelled paper
  // whose send was proven — the maker-side acceptance of the cancellation
  // (取消承認). It is the only record that re-opens the ordering step after sent
  // paper was cancelled: until it exists, the maker-PO create endpoint refuses,
  // so the sent paper and its replacement can never both be in production at
  // the same time. Append-only like every maker PO event, bound to the exact
  // paper it acknowledges, admin-only like the cancellation itself.
  app.post('/api/maker-purchase-orders/:poId/cancellation-acknowledgement', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const [cancellationEvent] = await db.select({ recordedAt: makerPoEvents.recordedAt })
      .from(makerPoEvents)
      .where(and(
        eq(makerPoEvents.makerPurchaseOrderId, existing.id),
        eq(makerPoEvents.eventType, 'MAKER_PO_CANCELLED')
      ))
      .orderBy(desc(makerPoEvents.recordedAt), desc(makerPoEvents.id))
      .limit(1);
    // The same act as cancelling: freeing (or keeping closed) the order's
    // production step is the representative's decision, never staff work.
    const decision = canPerform(toActor(user), 'maker_po:cancel', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '代表者のみ承認を記録できます' }, 403);
    const ackProjectId = order.projectId;
    const ackActorUserId = user.id;
    const now = new Date();

    const body = await context.req.json().catch(() => null) as any;
    const noteCheck = normalizeRequiredReason(body?.note);
    if (!noteCheck.ok) {
      return context.json({
        error: noteCheck.tooLong
          ? `承認理由（note）は${REASON_MAX_LENGTH}文字以下の可視文字で入力してください`
          : '承認理由（note）は必須です。取り消しを確認した根拠を記録してください',
        code: noteCheck.tooLong
          ? 'MAKER_CANCELLATION_ACK_REASON_TOO_LONG'
          : 'MAKER_CANCELLATION_ACK_REASON_REQUIRED'
      }, 422);
    }
    const acknowledgementNote = noteCheck.text;
    const acknowledgedAt = body?.acknowledgedAt === undefined || body?.acknowledgedAt === null
      ? { ok: true as const, date: null as Date | null }
      : parseStrictRequiredDate(body?.acknowledgedAt);
    if (!acknowledgedAt.ok) {
      return context.json({
        error: '承認日時（acknowledgedAt）はオフセット付きISO-8601で指定してください',
        code: 'MAKER_CANCELLATION_ACK_TIME_FORMAT_INVALID'
      }, 422);
    }
    if (acknowledgedAt.date !== null && !isIsoDateWithOffset(body?.acknowledgedAt)) {
      return context.json({
        error: '承認日時（acknowledgedAt）はオフセット付きISO-8601で指定してください',
        code: 'MAKER_CANCELLATION_ACK_TIME_FORMAT_INVALID'
      }, 422);
    }
    if (acknowledgedAt.date !== null) {
      if (acknowledgedAt.date.getTime() > now.getTime() + 5 * 60 * 1000) {
        return context.json({
          error: '承認日時（acknowledgedAt）に未来時刻は記録できません',
          code: 'MAKER_CANCELLATION_ACK_TIME_IN_FUTURE'
        }, 422);
      }
      if (acknowledgedAt.date.getTime() < Date.UTC(2000, 0, 1)) {
        return context.json({
          error: '承認日時（acknowledgedAt）が許容範囲外です',
          code: 'MAKER_CANCELLATION_ACK_TIME_OUT_OF_RANGE'
        }, 422);
      }
      if (cancellationEvent && acknowledgedAt.date.getTime() < cancellationEvent.recordedAt.getTime()) {
        return context.json({
          error: '承認日時（acknowledgedAt）は取消記録以降である必要があります',
          code: 'MAKER_CANCELLATION_ACK_TIME_BEFORE_CANCELLATION'
        }, 422);
      }
    }
    const rawEvidenceId = body?.evidenceDocumentVersionId;
    const requestedEvidenceId = rawEvidenceId === undefined || rawEvidenceId === null ? null : rawEvidenceId;
    if (requestedEvidenceId !== null && (typeof requestedEvidenceId !== 'string'
      || requestedEvidenceId.length === 0 || !isUuid(requestedEvidenceId))) {
      return context.json({
        error: '引用された承認証跡のドキュメントバージョンIDが不正です',
        code: 'MAKER_CANCELLATION_ACK_EVIDENCE_INVALID'
      }, 422);
    }
    // An accept-evidence style record: the acknowledgement may cite the
    // document that proves the maker accepted the cancellation, and the cited
    // version must exist when it is named.
    let evidenceDocument: MakerPoEvidenceDocument | null = null;
    if (requestedEvidenceId !== null) {
      evidenceDocument = await loadMakerPoEvidenceDocument(db, requestedEvidenceId);
      if (evidenceDocument === null) {
        return context.json({
          error: '引用された承認証跡のドキュメントバージョンが見つかりません',
          code: 'MAKER_CANCELLATION_ACK_EVIDENCE_NOT_FOUND'
        }, 422);
      }
      if (evidenceDocument.projectId !== order.projectId
        || evidenceDocument.filmSupplyOrderId !== order.id
        || evidenceDocument.makerPurchaseOrderId !== poId) {
        return context.json({
          error: '承認証跡は同じプロジェクト・発注・メーカー発注書に紐づく必要があります',
          code: 'MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH'
        }, 422);
      }
      if (evidenceDocument.documentType !== 'acceptance_evidence') {
        return context.json({
          error: '承認証跡は acceptance_evidence 文書である必要があります',
          code: 'MAKER_CANCELLATION_ACK_EVIDENCE_TYPE_INVALID'
        }, 422);
      }
      if (evidenceDocument.verificationStatus !== 'verified') {
        return context.json({
          error: '承認証跡は人間による検証済みである必要があります',
          code: 'MAKER_CANCELLATION_ACK_EVIDENCE_NOT_VERIFIED'
        }, 422);
      }
    }

    try {
      const outcome = await db.transaction(async (tx) => {
        const [lockedOrder] = await tx.select().from(filmSupplyOrders)
          .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1).for('update');
        if (!lockedOrder || lockedOrder.deletedAt) throw new MakerPoStateConflict();
        if (String(lockedOrder.status) === 'CANCELLED' && order.status !== lockedOrder.status) {
          throw new MakerPoStateConflict();
        }

        const [po] = await tx.select().from(makerPurchaseOrders)
          .where(eq(makerPurchaseOrders.id, poId)).limit(1).for('update');
        if (!po) throw new MakerPoStateConflict();
        if (po.status !== 'CANCELLED') {
          return {
            kind: 'not_cancelled' as const,
            status: po.status,
            message: '取り消し承認は取り消し済みのメーカー発注書にのみ記録できます',
            code: 'MAKER_PO_NOT_CANCELLED' as const
          };
        }
        if (requestedEvidenceId !== null) {
          const [currentEvidence] = await tx.select({
            projectId: documents.projectId,
            documentType: documents.documentType,
            filmSupplyOrderId: documents.filmSupplyOrderId,
            makerPurchaseOrderId: documents.makerPurchaseOrderId,
            versionId: documentVersions.id,
            verificationStatus: documents.verificationStatus
          }).from(documentVersions)
            .innerJoin(documents, eq(documents.id, documentVersions.documentId))
            .where(eq(documentVersions.id, requestedEvidenceId))
            .limit(1)
            .for('share');
          if (!currentEvidence) {
            return {
              kind: 'evidenceChanged' as const,
              message: '引用された承認証跡のドキュメントバージョンが見つかりません',
              code: 'MAKER_CANCELLATION_ACK_EVIDENCE_NOT_FOUND' as const
            };
          }
          if (currentEvidence.projectId !== order.projectId
            || currentEvidence.filmSupplyOrderId !== order.id
            || currentEvidence.makerPurchaseOrderId !== poId
            || currentEvidence.documentType !== 'acceptance_evidence'
            || currentEvidence.verificationStatus !== 'verified') {
            return {
              kind: 'evidenceChanged' as const,
              message: '承認証跡は検証済み acceptance_evidence であり、同一プロジェクト・発注・paper に紐づく必要があります',
              code: 'MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH' as const
            };
          }
        }
        const events = await tx.select({
          id: makerPoEvents.id,
          eventType: makerPoEvents.eventType,
          verificationStatus: makerPoEvents.verificationStatus
        }).from(makerPoEvents).where(eq(makerPoEvents.makerPurchaseOrderId, poId));
        const hasVerifiedSend = events.some((event) =>
          event.eventType === 'SEND_EVIDENCE_REGISTERED' && event.verificationStatus === 'VERIFIED');
        const [confirmedManualSend] = await tx.select({ id: makerPoSendManualVerifications.id })
          .from(makerPoSendManualVerifications)
          .where(and(
            eq(makerPoSendManualVerifications.makerPurchaseOrderId, poId),
            eq(makerPoSendManualVerifications.result, 'confirmed')
          ))
          .limit(1);
        const provenSend = hasVerifiedSend || confirmedManualSend !== undefined;
        let internalReplacementPaperLive = false;
        if (!provenSend) {
          // Representative decision for seventh-recheck Medium-2: an internal
          // cancellation can still receive a record-only post-delivery fact.
          // It must never reopen the order or lift a replacement gate.
          const [liveReplacement] = await tx.select({ id: makerPurchaseOrders.id })
            .from(makerPurchaseOrders)
            .where(and(
              eq(makerPurchaseOrders.filmSupplyOrderId, lockedOrder!.id),
              ne(makerPurchaseOrders.id, poId),
              ne(makerPurchaseOrders.status, 'CANCELLED'),
              isNull(makerPurchaseOrders.deletedAt)
            ))
            .limit(1)
            .for('update');
          internalReplacementPaperLive = liveReplacement !== undefined;
        }
        if (events.some((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED')) {
          return {
            kind: 'already' as const,
            status: po.status,
            message: 'この発注書の取り消し承認はすでに記録済みです。訂正する場合は新しい記録として残してください',
            code: 'MAKER_CANCELLATION_ACK_ALREADY_RECORDED' as const
          };
        }

        const ackEvent = {
          id: uuidv7(now),
          makerPurchaseOrderId: poId,
          eventType: 'MAKER_CANCELLATION_ACKNOWLEDGED' as const,
          evidenceDocumentVersionId: evidenceDocument?.versionId ?? null,
          verificationStatus: 'UNVERIFIED' as const,
          verificationNote: acknowledgementNote,
          recordedByUserId: user.id,
          recordedAt: now
        };
        await tx.insert(makerPoEvents).values(ackEvent);

        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_CANCELLATION_ACKNOWLEDGED',
          entityType: 'maker_po_event',
          entityId: ackEvent.id,
          beforeState: { status: 'CANCELLED' },
          afterState: {
            status: 'CANCELLED',
            note: acknowledgementNote,
            acknowledgedAt: acknowledgedAt.date,
            acknowledgementKind: provenSend ? 'CANCELLATION_ACKNOWLEDGEMENT' : 'POST_DELIVERY_CONFIRMATION',
            replacementAllowed: provenSend,
            verifiedSend: provenSend,
            replacementPaperLive: internalReplacementPaperLive,
            rowsDeleted: false
          },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:cancellation_acknowledgement', makerPurchaseOrderId: poId }
        });

        // Reopening is part of the same acknowledged transaction. A rejected
        // acknowledgement therefore leaves neither order status nor recovery
        // audit behind. The representative-owned frozen/closed states are never
        // mirrored, and another live paper blocks reopening the ordering step.
        const recoveryOrder = lockedOrder!;
        if (provenSend && !isFrozenFilmOrderStatus(recoveryOrder.status)) {
          const canReopenMakerStep = (
            recoveryOrder.status === 'APPROVED_FOR_MANUAL_SEND' ||
            recoveryOrder.status === 'MAKER_PO_SENT_MANUALLY' ||
            recoveryOrder.status === 'MAKER_PO_ACCEPTED'
          );
          if (canReopenMakerStep && recoveryOrder.status !== 'MAKER_PO_READY') {
            const [remainingLivePaper] = await tx.select({ id: makerPurchaseOrders.id })
              .from(makerPurchaseOrders)
              .where(and(
                eq(makerPurchaseOrders.filmSupplyOrderId, recoveryOrder.id),
                ne(makerPurchaseOrders.id, poId),
                ne(makerPurchaseOrders.status, 'CANCELLED'),
                isNull(makerPurchaseOrders.deletedAt)
              ))
              .limit(1)
              .for('update');
            if (!remainingLivePaper) {
              const reopened = await tx.update(filmSupplyOrders)
                .set({ status: 'MAKER_PO_READY', updatedAt: now })
                .where(and(
                  eq(filmSupplyOrders.id, recoveryOrder.id),
                  eq(filmSupplyOrders.status, recoveryOrder.status)
                ))
                .returning({ id: filmSupplyOrders.id });
              if (reopened.length > 0) {
                await recordAuditEvent(tx, {
                  projectId: ackProjectId,
                  id: uuidv7(now),
                  actorUserId: ackActorUserId,
                  action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
                  entityType: 'film_supply_order',
                  entityId: recoveryOrder.id,
                  beforeState: { status: recoveryOrder.status },
                  afterState: { status: 'MAKER_PO_READY' },
                  occurredAt: now,
                  requestMetadata: {
                    operation: 'maker_po:cancellation_acknowledgement',
                    reason: 'maker_cancellation_acknowledged_reopens_the_ordering_step',
                    intendedReverseRecovery: true
                  }
                });
              }
            }
          }
        }
        return {
          kind: 'recorded' as const,
          event: ackEvent,
          acknowledgementKind: provenSend ? 'CANCELLATION_ACKNOWLEDGEMENT' as const : 'POST_DELIVERY_CONFIRMATION' as const,
          replacementPaperLive: internalReplacementPaperLive,
          purchaseOrder: buildMakerPoViewForRole(user.role, {
            id: poId,
            filmSupplyOrderId: po.filmSupplyOrderId,
            snapshot: po.snapshot as MakerPoSnapshot,
            snapshotSha256: po.snapshotSha256,
            status: po.status,
            ceoApprovedByUserId: po.ceoApprovedByUserId,
            ceoApprovedAt: po.ceoApprovedAt,
            createdByUserId: po.createdByUserId,
            createdAt: po.createdAt,
            updatedAt: now
          })
        };

      });

      if (outcome.kind === 'not_cancelled' || outcome.kind === 'already') {
        return context.json({ error: outcome.message, code: outcome.code, status: outcome.status }, 422);
      }
      if (outcome.kind === 'evidenceChanged') {
        return context.json({ error: outcome.message, code: outcome.code }, 422);
      }
      return context.json({
        status: 'CANCELLED',
        event: outcome.event,
        purchaseOrder: outcome.purchaseOrder,
        acknowledgementKind: outcome.acknowledgementKind,
        replacementPaperLive: outcome.replacementPaperLive === true
      }, 201);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
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
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:accept_evidence', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    // A hold freezes the whole maker-PO workflow. Letting the paper advance
    // while the order stays behind makes release unable to catch up (M2).
    if (String(order.status) === 'CANCELLED') {
      return context.json({
        error: '取消終了した発注のメーカー発注書は操作できません',
        code: 'FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }
    if (isFrozenFilmOrderStatus(order.status)) {
      return context.json({
        error: '保留・見直し中の発注のメーカー発注書は進められません。状態を解決後に記録してください',
        code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }

    const body = await context.req.json().catch(() => null) as any;
    const acceptedAt = parseOptionalDate(body?.acceptedAt);
    if (!acceptedAt.ok) return context.json({ error: '受領日時が不正です', code: 'INVALID_DATE' }, 422);
    const acceptEvidenceId = optionalUuidInput(body?.evidenceDocumentVersionId);
    if (!acceptEvidenceId.ok) {
      return context.json({
        error: '引用された受領証跡のドキュメントバージョンIDが不正です',
        code: 'ACCEPT_EVIDENCE_DOCUMENT_VERSION_INVALID'
      }, 422);
    }

    // M8-OPER3: acceptance follows a proven send only, so the gate re-check
    // records its decision here — a withdrawal after the paper shipped is
    // recorded, never a retroactive refusal of work that already happened.
    const acceptRecheck = await dualApprovalRecheck({
      order: { id: order.id, projectId: order.projectId },
      orderStatus: order.status,
      poId,
      stage: 'maker_po:accept_evidence',
      actorUserId: user.id,
      now: new Date()
    });
    if (acceptRecheck) return context.json(acceptRecheck, 422);

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        await lockMakerPoOrderForProgressive(tx, {
          filmSupplyOrderId: existing.filmSupplyOrderId,
          expectedStatus: order.status
        });
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
          // M8-HARDEN FIX B2 (d): the acceptance evidence must be bound to THIS
          // maker PO — one order can hold a cancelled and a live paper, and the
          // two must never be closed by the same document.
          makerPurchaseOrderId: poId,
          snapshotOrder: { id: (po.snapshot as MakerPoSnapshot).order.id },
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

        // M8-OPERATOR FIX 2: the confirmation names the provisional records it
        // closes, so the paper trail shows the acceptance was first written down
        // by staff and only later confirmed by the representative.
        const provisionalEvents = await tx.select({ id: makerPoEvents.id })
          .from(makerPoEvents)
          .where(and(
            eq(makerPoEvents.makerPurchaseOrderId, poId),
            eq(makerPoEvents.provisional, true)
          ))
          .orderBy(makerPoEvents.recordedAt, makerPoEvents.id);
        const precededByProvisional = provisionalEvents.length > 0;
        const provisionalEventId = precededByProvisional ? provisionalEvents.at(-1)!.id : null;

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
          afterState: {
            status: 'MAKER_PO_ACCEPTED',
            event: acceptEvent,
            precededByProvisional,
            provisionalEventId
          },
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

        await mirrorMakerPoFilmOrderTransition(tx, {
          projectId: order.projectId,
          actorUserId: user.id,
          filmSupplyOrderId: po.filmSupplyOrderId,
          expectedStatus: order.status,
          nextStatus: 'MAKER_PO_ACCEPTED',
          operation: 'maker_po:accept_evidence',
          reason: 'maker_po_accepted',
          occurredAt: now
        });

        return {
          kind: 'applied' as const,
          status: 'MAKER_PO_ACCEPTED' as const,
          event: acceptEvent,
          precededByProvisional,
          provisionalEventId,
          purchaseOrder: buildMakerPoViewForRole(user.role, {
            id: poId,
            filmSupplyOrderId: po.filmSupplyOrderId,
            snapshot: po.snapshot as MakerPoSnapshot,
            snapshotSha256: po.snapshotSha256,
            status: 'MAKER_PO_ACCEPTED',
            ceoApprovedByUserId: po.ceoApprovedByUserId,
            ceoApprovedAt: po.ceoApprovedAt,
            createdByUserId: po.createdByUserId,
            createdAt: po.createdAt,
            updatedAt: now
          })
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
      return context.json({
        status: outcome.status,
        event: outcome.event,
        precededByProvisional: outcome.precededByProvisional,
        provisionalEventId: outcome.provisionalEventId,
        purchaseOrder: outcome.purchaseOrder
      }, 200);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {

        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  // M8-OPERATOR FIX 1: both maker PO reads answer by role (see maker-po-view.ts).
  // The rows are selected once and never rewritten; only the answer is narrowed,
  // so an admin still reads the frozen paper while staff and viewer cannot.
  app.get('/api/maker-purchase-orders/:poId', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

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
    return context.json({
      purchaseOrder: buildMakerPoViewForRole(user.role, po as MakerPoRecord),
      events: events.map((event) => buildMakerPoEventViewForRole(user.role, event as MakerPoEventRecord))
    });
  });

  app.get('/api/film-supply-orders/:orderId/maker-purchase-orders', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select({ projectId: filmSupplyOrders.projectId })
      .from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:read', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const rows = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, orderId))
      .orderBy(desc(makerPurchaseOrders.createdAt));
    return context.json({
      makerPurchaseOrders: rows.map((row) => buildMakerPoViewForRole(user.role, row as MakerPoRecord))
    });
  });

  // M8-OPERATOR FIX 2: the provisional acceptance. A staff member writes down
  // that the maker reported receipt; the event is flagged provisional, the PO
  // status never moves, and the representative's final acceptance later names
  // the provisional record it confirms. Nothing here can close the paper.
  app.post('/api/maker-purchase-orders/:poId/provisional-acceptance', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const poId = context.req.param('poId');
    if (!isUuid(poId)) {
      return context.json({
        error: '経路パラメータ（poId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [existing] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    if (!existing) return context.json({ error: 'メーカー発注書が見つかりません' }, 404);
    const [order] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, existing.filmSupplyOrderId)).limit(1);
    if (!order) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:accept_provisional', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    // A hold freezes the whole maker-PO workflow. Letting the paper advance
    // while the order stays behind makes release unable to catch up (M2).
    if (String(order.status) === 'CANCELLED') {
      return context.json({
        error: '取消終了した発注のメーカー発注書は操作できません',
        code: 'FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }
    if (isFrozenFilmOrderStatus(order.status)) {
      return context.json({
        error: '保留・見直し中の発注のメーカー発注書は進められません。状態を解決後に記録してください',
        code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED',
        orderStatus: order.status
      }, 409);
    }

    const body = await context.req.json().catch(() => null) as any;
    const acceptedAt = parseOptionalDate(body?.acceptedAt);
    if (!acceptedAt.ok) return context.json({ error: '受領日時が不正です', code: 'INVALID_DATE' }, 422);

    const now = new Date();
    try {
      const outcome = await db.transaction(async (tx) => {
        await lockMakerPoOrderForProgressive(tx, {
          filmSupplyOrderId: existing.filmSupplyOrderId,
          expectedStatus: order.status
        });
        const [po] = await tx.select().from(makerPurchaseOrders)
          .where(eq(makerPurchaseOrders.id, poId)).limit(1).for('update');
        if (!po) throw new MakerPoStateConflict();
        const poStatus = validateMakerPoStatus(po.status);
        if (!poStatus.ok) return { kind: 'error' as const, code: poStatus.code, message: poStatus.message };

        // A provisional acceptance only makes sense once the send is proven:
        // the same reachability the final acceptance requires, without the
        // status change.
        const reachable = transitionMakerPurchaseOrder(poStatus.value, 'MAKER_PO_ACCEPTED');
        if (!reachable.ok) {
          return {
            kind: 'blocked' as const,
            code: 'MAKER_PO_TRANSITION_BLOCKED' as const,
            from: poStatus.value,
            message: `a maker purchase order in ${poStatus.value} cannot record a provisional acceptance; a proven send comes first`
          };
        }

        const provisionalEvent = {
          id: uuidv7(now),
          makerPurchaseOrderId: poId,
          eventType: 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL' as const,
          sentAt: acceptedAt.date,
          verificationStatus: 'UNVERIFIED' as const,
          provisional: true,
          recordedByUserId: user.id,
          recordedAt: now
        };
        await tx.insert(makerPoEvents).values(provisionalEvent);

        await recordAuditEvent(tx, {
          projectId: order.projectId,
          id: uuidv7(now),
          actorUserId: user.id,
          action: 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL',
          entityType: 'maker_po_event',
          entityId: provisionalEvent.id,
          beforeState: { status: poStatus.value },
          afterState: {
            status: poStatus.value,
            eventType: provisionalEvent.eventType,
            provisional: true,
            recordedByUserId: user.id
          },
          occurredAt: now,
          requestMetadata: { operation: 'maker_po:accept_provisional', makerPurchaseOrderId: poId }
        });

        return {
          kind: 'applied' as const,
          event: provisionalEvent,
          purchaseOrder: buildMakerPoViewForRole(user.role, po as MakerPoRecord)
        };
      });

      if (outcome.kind === 'error') return context.json({ error: outcome.message, code: outcome.code }, 422);
      if (outcome.kind === 'blocked') {
        return context.json({ error: outcome.message, code: outcome.code, from: outcome.from }, 422);
      }
      return context.json({
        status: outcome.purchaseOrder.status,
        provisional: true,
        event: outcome.event,
        purchaseOrder: outcome.purchaseOrder
      }, 201);
    } catch (error) {
      if (isPostgresDeadlockError(error)) {
        return context.json({ error: '発注状態の処理でロック競合が発生しました', code: 'MAKER_PO_LOCK_CONFLICT' }, 409);
      }
      if (error instanceof MakerPoStateConflict) {

        return context.json({ error: 'メーカー発注書の状態が既に変わっています', code: 'MAKER_PO_STATE_CHANGED' }, 422);
      }
      throw error;
    }
  });

  // M8-OPERATOR FIX 3: the G6 payment gate as a read, so the 大代表承認 screen
  // can show 決済条件の状態 and the block reason before anyone tries to approve.
  // The gate answers only whether the recorded terms open the approval; it is
  // never a statement that money arrived.
  app.get('/api/film-supply-orders/:orderId/payment-gate', async (context) => {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return context.json({ error: '認証が必要です' }, 401);
    const orderId = context.req.param('orderId');
    if (!isUuid(orderId)) {
      return context.json({
        error: '経路パラメータ（orderId）はUUIDである必要があります',
        code: 'INVALID_PATH_PARAMETER'
      }, 400);
    }

    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    if (!order || order.deletedAt) return context.json({ error: 'フィルム発注が見つかりません' }, 404);
    const decision = canPerform(toActor(user), 'maker_po:read', 'F1', order.projectId);
    if (!decision.allowed) return context.json({ error: '権限がありません' }, 403);

    const paymentGate = evaluatePaymentGate({ paymentTerms: order.paymentTerms });
    return context.json({
      orderId,
      orderStatus: order.status,
      paymentTerms: paymentGate.paymentTerms,
      gate: paymentGate.ok
        ? { satisfied: true, gatedOn: paymentGate.gatedOn, code: null, reason: null }
        : {
            satisfied: false,
            gatedOn: null,
            code: paymentGate.code,
            reason: paymentGate.message
          },
      /**
       * 入金確認（檢証）is a separate manual step that no code path records
       * today. Recording paymentTerms='prepaid' is a *term*, never a
       * confirmation; this field stays null until a future explicit
       * confirmation action writes it.
       */
      paymentConfirmedAt: order.paymentConfirmedAt ?? null
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
