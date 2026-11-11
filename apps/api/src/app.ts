import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { canPerform, validateProjectRoute } from '@kanei/core';
import { accounts, auditEvents, projects, sessions, users } from '@kanei/db/schema';
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

  return app;
}
