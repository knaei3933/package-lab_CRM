import type { Hono } from 'hono';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accounts, projects } from '@kanei/db/schema';
import { canPerform } from '@kanei/core';
import { getSessionUser, toActor, type AppDatabase } from './auth.js';
import type { AuditInput } from './p2-routes.js';
import { normalizeRecipientEmail } from './p2-routes.js';

/**
 * P5 R5 (audit44b REMAINING §1, the premise of N4): 取引先の連絡先. The sender
 * check of an approval mail compares its From domain with the issuing
 * organization's registered address (accounts.contact_email). Until P5 that
 * value could only be written by SQL, so every mail read 「照合していません」.
 *
 * - GET   /api/partner-accounts                         the customers and セブン化学 accounts (admin only)
 * - PATCH /api/partner-accounts/:accountId/contact-email { contactEmail: string | null } → 200
 *
 * The existing column only — no migration. Admin only (`partner_contact:manage`:
 * the registered domain decides which approval mails count by themselves, so
 * setting it is the representative's decision). Every change is written with
 * its append-only audit row (PARTNER_CONTACT_EMAIL_UPDATED, before → after) in
 * one transaction. Maker accounts keep their own page (/makers). No amount is
 * part of any answer. Writes carry Idempotency-Key like every other write
 * (app.ts middleware).
 */
export interface P5RouteDeps {
  db: AppDatabase;
  recordAuditEvent: (writer: Pick<AppDatabase, 'insert'>, input: AuditInput) => Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

/** The account roles whose contact address the sender check reads (顧客・セブン化学). */
export const PARTNER_ACCOUNT_ROLES = ['end_customer', 'seven'] as const;

export function registerP5Routes(app: Hono<any>, { db, recordAuditEvent }: P5RouteDeps): void {
  const unauthorized = { error: '認証が必要です', code: 'AUTH_REQUIRED' } as const;
  const ceoOnly = { error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' } as const;
  const notFound = { error: '取引先が見つかりません', code: 'PARTNER_ACCOUNT_NOT_FOUND' } as const;
  // Round 2 (p5-int review L-3): every answer of these routes — 200, 401, 403, 4xx — is private and never cached.
  const NO_STORE = { 'cache-control': 'private, no-store' } as const;
  const reply = (context: any, body: unknown, status: number) => context.json(body, status, NO_STORE);

  async function authorize(context: any) {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return { ok: false as const, response: reply(context, unauthorized, 401) };
    if (!canPerform(toActor(user), 'partner_contact:manage', 'F1').allowed) {
      return { ok: false as const, response: reply(context, ceoOnly, 403) };
    }
    return { ok: true as const, user };
  }

  app.get('/api/partner-accounts', async (context) => {
    const auth = await authorize(context);
    if (!auth.ok) return auth.response;
    const rows = await db.select({
      id: accounts.id,
      name: accounts.name,
      role: sql<string>`${accounts.role}::text`,
      externalCode: accounts.externalCode,
      contactEmail: accounts.contactEmail,
      isActive: accounts.isActive,
      updatedAt: accounts.updatedAt
    }).from(accounts)
      .where(and(inArray(accounts.role, [...PARTNER_ACCOUNT_ROLES]), isNull(accounts.deletedAt)))
      .orderBy(asc(accounts.role), asc(accounts.name), asc(accounts.id));
    // Which projects name each account (code only), so two 「株式会社…」 can be told apart.
    const used = rows.length === 0 ? [] : await db.select({
      code: projects.code,
      endCustomerAccountId: projects.endCustomerAccountId,
      sevenAccountId: projects.sevenAccountId
    }).from(projects).where(isNull(projects.deletedAt)).orderBy(asc(projects.code));
    return context.json({
      accounts: rows.map((row) => ({
        ...row,
        projectCodes: used
          .filter((project) => (row.role === 'seven' ? project.sevenAccountId : project.endCustomerAccountId) === row.id)
          .map((project) => project.code)
          .slice(0, 20)
      }))
    }, 200, NO_STORE);
  });

  app.patch('/api/partner-accounts/:accountId/contact-email', async (context) => {
    const auth = await authorize(context);
    if (!auth.ok) return auth.response;
    const accountId = context.req.param('accountId');
    if (!isUuid(accountId)) {
      return reply(context, { error: '経路パラメータ（accountId）はUUIDである必要があります', code: 'INVALID_PATH_PARAMETER' }, 400);
    }
    const body = await context.req.json().catch(() => null) as { contactEmail?: unknown } | null;
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'contactEmail')) {
      return reply(context, { error: '連絡先メールアドレス（contactEmail）を指定してください。消すときは null です', code: 'PARTNER_CONTACT_EMAIL_INVALID' }, 422);
    }
    let contactEmail: string | null = null;
    if (body.contactEmail !== null && !(typeof body.contactEmail === 'string' && body.contactEmail.trim().length === 0)) {
      const email = normalizeRecipientEmail(body.contactEmail);
      if (!email.ok) {
        return reply(context, { error: 'メールアドレスの形式で入力してください（例: approvals@customer.example.jp）', code: 'PARTNER_CONTACT_EMAIL_INVALID' }, 422);
      }
      contactEmail = email.email;
    }
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select({
        id: accounts.id, name: accounts.name, role: sql<string>`${accounts.role}::text`,
        contactEmail: accounts.contactEmail, deletedAt: accounts.deletedAt
      }).from(accounts).where(eq(accounts.id, accountId)).limit(1).for('update');
      if (!locked || locked.deletedAt || !(PARTNER_ACCOUNT_ROLES as readonly string[]).includes(locked.role)) return null;
      if (locked.contactEmail === contactEmail) return { changed: false as const, account: locked };
      await tx.update(accounts).set({ contactEmail, updatedAt: now }).where(eq(accounts.id, accountId));
      await recordAuditEvent(tx, {
        projectId: null,
        actorUserId: auth.user.id,
        action: 'PARTNER_CONTACT_EMAIL_UPDATED',
        entityType: 'account',
        entityId: accountId,
        beforeState: { id: accountId, role: locked.role, contactEmail: locked.contactEmail },
        afterState: { id: accountId, role: locked.role, contactEmail },
        occurredAt: now,
        requestMetadata: { operation: 'partner_contact:manage' }
      });
      return { changed: true as const, account: { ...locked, contactEmail } };
    });
    if (!outcome) return reply(context, notFound, 404);
    return reply(context, {
      id: outcome.account.id,
      name: outcome.account.name,
      role: outcome.account.role,
      contactEmail: outcome.account.contactEmail,
      changed: outcome.changed
    }, 200);
  });
}
