import type { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { projectAssignments, projects, users } from '@kanei/db/schema';
import { uuidv7 } from '@kanei/db';
import { canPerform, type UserRole } from '@kanei/core';
import { getSessionUser, toActor, type AppDatabase } from './auth.js';
import type { AuditInput } from './p2-routes.js';

/**
 * P4 server routes. N1 (audit44 UNRESOLVED §N): 担当の割り当て. Until P4 a
 * project assignment could only be written by SQL, so a new staff member saw
 * 「あなたが開ける案件はありません」 and the representative had no way to fix it.
 *
 * - GET    /api/projects/:projectId/assignments          list (admin only)
 * - POST   /api/projects/:projectId/assignments          { userId } → 201
 * - DELETE /api/projects/:projectId/assignments/:userId  → 200
 *
 * Every route answers 401 before reading its target, decides permission with
 * the one authorization core (`project_assignment:manage`, admin only — the
 * assignment decides what staff, viewer and auditor may open, so it is the
 * representative's decision), and writes the change with its append-only
 * audit row (PROJECT_ASSIGNMENT_CREATED / PROJECT_ASSIGNMENT_REMOVED) in one
 * transaction. No amount is part of any answer. Writes carry Idempotency-Key
 * like every other write (app.ts middleware) and are covered by the
 * X-Kanei-Expected-Project check (project-context.ts, /api/projects/:id/…).
 */
export interface P4RouteDeps {
  db: AppDatabase;
  recordAuditEvent: (writer: Pick<AppDatabase, 'insert'>, input: AuditInput) => Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

/** The roles whose access is assignment-scoped. admin reads every project and is never assigned. */
export const ASSIGNABLE_ROLES: readonly UserRole[] = ['staff', 'viewer', 'auditor'];

export function registerP4Routes(app: Hono<any>, { db, recordAuditEvent }: P4RouteDeps): void {
  const unauthorized = { error: '認証が必要です', code: 'AUTH_REQUIRED' } as const;
  const ceoOnly = { error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' } as const;
  const badPath = (name: string) => ({ error: `経路パラメータ（${name}）はUUIDである必要があります`, code: 'INVALID_PATH_PARAMETER' });

  /** 401 → path → 403 → 404, in that order (no project existence leaks to non-admins). */
  async function authorize(context: any): Promise<
    | { ok: true; user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>; project: { id: string; code: string; name: string } }
    | { ok: false; response: Response }
  > {
    const user = await getSessionUser(context.req.raw, db);
    if (!user) return { ok: false, response: context.json(unauthorized, 401) };
    const projectId = context.req.param('projectId');
    if (!isUuid(projectId)) return { ok: false, response: context.json(badPath('projectId'), 400) };
    if (!canPerform(toActor(user), 'project_assignment:manage', 'F1', projectId).allowed) {
      return { ok: false, response: context.json(ceoOnly, 403) };
    }
    const [project] = await db.select({ id: projects.id, code: projects.code, name: projects.name, deletedAt: projects.deletedAt })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.deletedAt) {
      return { ok: false, response: context.json({ error: '案件が見つかりません', code: 'PROJECT_NOT_FOUND' }, 404) };
    }
    return { ok: true, user, project: { id: project.id, code: project.code, name: project.name } };
  }

  const assignmentView = (row: { id: string; userId: string; displayName: string; role: string; isActive: boolean; createdAt: Date }) => ({
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    assignedAt: row.createdAt
  });

  const assignmentColumns = {
    id: projectAssignments.id,
    userId: projectAssignments.userId,
    createdAt: projectAssignments.createdAt,
    displayName: users.displayName,
    role: users.role,
    isActive: users.isActive
  };

  app.get('/api/projects/:projectId/assignments', async (context) => {
    const access = await authorize(context);
    if (!access.ok) return access.response;
    const rows = await db.select(assignmentColumns).from(projectAssignments)
      .innerJoin(users, eq(users.id, projectAssignments.userId))
      .where(eq(projectAssignments.projectId, access.project.id))
      .orderBy(asc(projectAssignments.createdAt), asc(projectAssignments.id));
    return context.json({
      project: access.project,
      assignments: rows.map((row) => assignmentView({ ...row, role: String(row.role) })),
      assignableRoles: ASSIGNABLE_ROLES
    });
  });

  app.post('/api/projects/:projectId/assignments', async (context) => {
    const access = await authorize(context);
    if (!access.ok) return access.response;
    const body = await context.req.json().catch(() => null) as { userId?: unknown } | null;
    if (!isUuid(body?.userId)) {
      return context.json({ error: '割り当てる利用者を選んでください', code: 'ASSIGNMENT_USER_REQUIRED' }, 422);
    }
    const userId = body.userId;
    const [target] = await db.select({
      id: users.id, displayName: users.displayName, role: users.role, isActive: users.isActive, deletedAt: users.deletedAt
    }).from(users).where(eq(users.id, userId)).limit(1);
    // P4 review L-2: a logically deleted user (deleted_at set) is refused like
    // an inactive one, whatever is_active says.
    if (!target || !target.isActive || target.deletedAt !== null) {
      return context.json({ error: '割り当てる利用者が見つかりません（無効化された利用者は割り当てられません）', code: 'ASSIGNMENT_USER_NOT_FOUND' }, 422);
    }
    const role = String(target.role) as UserRole;
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return context.json({
        error: '代表者はすべての案件を開けるため、割り当ては不要です',
        code: 'ASSIGNMENT_ROLE_NOT_ASSIGNABLE',
        role
      }, 422);
    }

    const now = new Date();
    const assignment = { id: uuidv7(now), userId, projectId: access.project.id, createdAt: now };
    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(projectAssignments).values(assignment)
        .onConflictDoNothing({ target: [projectAssignments.userId, projectAssignments.projectId] })
        .returning({ id: projectAssignments.id });
      if (!inserted) return false;
      await recordAuditEvent(tx, {
        projectId: access.project.id,
        id: uuidv7(now),
        actorUserId: access.user.id,
        action: 'PROJECT_ASSIGNMENT_CREATED',
        entityType: 'project_assignment',
        entityId: assignment.id,
        afterState: { ...assignment, role, displayName: target.displayName },
        occurredAt: now,
        requestMetadata: { operation: 'project_assignment:manage' }
      });
      return true;
    });
    if (!created) {
      const [existing] = await db.select(assignmentColumns).from(projectAssignments)
        .innerJoin(users, eq(users.id, projectAssignments.userId))
        .where(and(eq(projectAssignments.projectId, access.project.id), eq(projectAssignments.userId, userId))).limit(1);
      return context.json({
        error: 'この利用者はすでにこの案件に割り当てられています',
        code: 'PROJECT_ASSIGNMENT_EXISTS',
        existing: existing ? assignmentView({ ...existing, role: String(existing.role) }) : null
      }, 409);
    }
    return context.json({
      project: access.project,
      assignment: assignmentView({ ...assignment, displayName: target.displayName, role, isActive: target.isActive })
    }, 201);
  });

  app.delete('/api/projects/:projectId/assignments/:userId', async (context) => {
    const access = await authorize(context);
    if (!access.ok) return access.response;
    const userId = context.req.param('userId');
    if (!isUuid(userId)) return context.json(badPath('userId'), 400);
    const now = new Date();
    const removed = await db.transaction(async (tx) => {
      const [row] = await tx.delete(projectAssignments)
        .where(and(eq(projectAssignments.projectId, access.project.id), eq(projectAssignments.userId, userId)))
        .returning();
      if (!row) return null;
      const [target] = await tx.select({ displayName: users.displayName, role: users.role, isActive: users.isActive })
        .from(users).where(eq(users.id, userId)).limit(1);
      const view = assignmentView({
        id: row.id,
        userId: row.userId,
        createdAt: row.createdAt,
        displayName: target?.displayName ?? '',
        role: String(target?.role ?? ''),
        isActive: target?.isActive ?? false
      });
      await recordAuditEvent(tx, {
        projectId: access.project.id,
        id: uuidv7(now),
        actorUserId: access.user.id,
        action: 'PROJECT_ASSIGNMENT_REMOVED',
        entityType: 'project_assignment',
        entityId: row.id,
        beforeState: { ...row, role: view.role, displayName: view.displayName },
        afterState: null,
        occurredAt: now,
        requestMetadata: { operation: 'project_assignment:manage' }
      });
      return view;
    });
    if (!removed) {
      return context.json({ error: 'この利用者はこの案件に割り当てられていません', code: 'PROJECT_ASSIGNMENT_NOT_FOUND' }, 404);
    }
    return context.json({ project: access.project, removed, removedAt: now });
  });
}
