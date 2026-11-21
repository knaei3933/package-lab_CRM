import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
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

/**
 * P2 review M-3 (migration 0032): an auditor's session hash is stored with
 * this prefix. An API build that does not know the auditor role looks up the
 * bare hash and cannot find it, and the database refuses an auditor session
 * without the prefix, so such a build can never authenticate an auditor.
 */
export const ROLE_AWARE_SESSION_PREFIX = 'p2:';

/** The stored session hash for a role: prefixed for auditors, bare otherwise. */
export function sessionTokenHashForRole(tokenHash: string, role: UserRole): string {
  return role === 'auditor' ? `${ROLE_AWARE_SESSION_PREFIX}${tokenHash}` : tokenHash;
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
      sessionId: sessions.id,
      storedHash: sessions.tokenHash
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      inArray(sessions.tokenHash, [hashToken(token), `${ROLE_AWARE_SESSION_PREFIX}${hashToken(token)}`]),
      gt(sessions.expiresAt, new Date()),
      isNull(sessions.revokedAt),
      eq(users.isActive, true),
      isNull(users.deletedAt)
    ))
    .limit(1);

  if (!row) return null;
  // The stored form must match the role it was issued for (fail closed).
  if (row.storedHash !== sessionTokenHashForRole(hashToken(token), row.role)) return null;
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
