import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { projectAssignments, sessions, users } from '@kanei/db/schema';
import type { AuthenticatedActor, UserRole } from '@kanei/core';

export const SESSION_COOKIE = 'kanei_mvp_session';

export type AppDatabase = NodePgDatabase<typeof import('@kanei/db/schema')>;

export function issueToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const prefix = `${SESSION_COOKIE}=`;
  return header.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export interface SessionUser {
  id: string;
  role: UserRole;
  isActive: boolean;
  assignedProjectIds: string[];
}

export async function getSessionUser(request: Request, db: AppDatabase): Promise<SessionUser | null> {
  const token = readSessionToken(request);
  if (!token) return null;

  const [row] = await db
    .select({
      userId: users.id,
      role: users.role,
      isActive: users.isActive,
      sessionId: sessions.id
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      eq(sessions.tokenHash, hashToken(token)),
      gt(sessions.expiresAt, new Date()),
      isNull(sessions.revokedAt),
      eq(users.isActive, true),
      isNull(users.deletedAt)
    ))
    .limit(1);

  if (!row) return null;
  const assignments = await db
    .select({ projectId: projectAssignments.projectId })
    .from(projectAssignments)
    .where(eq(projectAssignments.userId, row.userId));
  return {
    id: row.userId,
    role: row.role,
    isActive: row.isActive,
    assignedProjectIds: assignments.map((assignment) => assignment.projectId)
  };
}

export function toActor(user: SessionUser): AuthenticatedActor {
  return {
    id: user.id,
    role: user.role,
    isActive: user.isActive,
    assignedProjectIds: user.assignedProjectIds
  };
}
