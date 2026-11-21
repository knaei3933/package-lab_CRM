import type { UserRole } from './authorization.js';

/**
 * P1 policy P-4 (representative's answer, 2026-11-21): the company runs with
 * one operator, so the representative (admin) may confirm evidence they
 * uploaded or recorded themselves. Who confirmed and when is never taken from
 * the request: the server writes the logged-in user and its own clock, and the
 * record says plainly that it was a self-verification.
 *
 * Staff keep the rules they already have: the role checks of each endpoint
 * (approval-evidence and send verification stay admin-only) are unchanged, and
 * this decision never widens what staff may do. A staff self-verification that
 * an endpoint already allows is still labelled, so the audit trail shows it.
 */
export interface SelfVerificationInput {
  role: UserRole;
  verifierUserId: string;
  /** Who uploaded the evidence or recorded the fact being confirmed (nulls ignored). */
  originatorUserIds: ReadonlyArray<string | null | undefined>;
}

export interface SelfVerificationDecision {
  allowed: true;
  selfVerification: boolean;
  /** Which rule made it acceptable — written to the audit row. */
  basis: 'independent_verifier' | 'admin_self_verification_p4' | 'existing_staff_rule';
}

export function evaluateSelfVerification(input: SelfVerificationInput): SelfVerificationDecision {
  const selfVerification = input.originatorUserIds.some((id) => typeof id === 'string' && id === input.verifierUserId);
  if (!selfVerification) return { allowed: true, selfVerification: false, basis: 'independent_verifier' };
  return {
    allowed: true,
    selfVerification: true,
    basis: input.role === 'admin' ? 'admin_self_verification_p4' : 'existing_staff_rule'
  };
}
