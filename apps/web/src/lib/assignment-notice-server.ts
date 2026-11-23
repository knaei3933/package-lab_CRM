import { cookies } from 'next/headers';
import { ASSIGNMENT_NOTICE_COOKIE, ASSIGNMENT_NOTICE_MAX_AGE_SECONDS, decodeAssignmentNotice, encodeAssignmentNotice } from './assignment-notice';
import type { AssignmentNotice } from './assignment-notice';

export async function readAssignmentNotice(projectId: string): Promise<AssignmentNotice | null> {
  try {
    return decodeAssignmentNotice((await cookies()).get(ASSIGNMENT_NOTICE_COOKIE)?.value, projectId);
  } catch {
    return null;
  }
}

/** Set from the add / remove actions only. */
export async function rememberAssignmentChange(projectId: string, kind: AssignmentNotice['kind'], userId: string, now: Date = new Date()): Promise<void> {
  try {
    (await cookies()).set(ASSIGNMENT_NOTICE_COOKIE, encodeAssignmentNotice({ projectId, kind, userId, at: now.toISOString() }), {
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: ASSIGNMENT_NOTICE_MAX_AGE_SECONDS
    });
  } catch {
    // Display only: the removal itself is recorded; only its status line is lost.
  }
}
