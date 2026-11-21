import type { UserRole } from './authorization.js';

/**
 * P1 policy P-4 (representative's answers, 2026-11-21): the company runs with
 * one operator, so the representative (admin) may confirm evidence they
 * uploaded or recorded themselves. Who confirmed and when is never taken from
 * the request: the server writes the logged-in user and its own clock, and the
 * record says plainly that it was a self-verification.
 *
 * Staff keep the rule that a confirmation is someone else's act: a staff member
 * may not confirm evidence they uploaded (document verification, delivery
 * confirmation) — SELF_VERIFICATION_FORBIDDEN. The role checks of each
 * endpoint (approval-evidence and send verification are admin-only) are
 * unchanged; this decision never widens what staff may do.
 */
export interface SelfVerificationInput {
  role: UserRole;
  verifierUserId: string;
  /** Who uploaded the evidence or recorded the fact being confirmed (nulls ignored). */
  originatorUserIds: ReadonlyArray<string | null | undefined>;
}

export type SelfVerificationDecision =
  | {
      allowed: true;
      selfVerification: boolean;
      /** Which rule made it acceptable — written to the audit row. */
      basis: 'independent_verifier' | 'admin_self_verification_p4';
    }
  | { allowed: false; selfVerification: true; code: 'SELF_VERIFICATION_FORBIDDEN'; message: string };

export function evaluateSelfVerification(input: SelfVerificationInput): SelfVerificationDecision {
  const selfVerification = input.originatorUserIds.some((id) => typeof id === 'string' && id === input.verifierUserId);
  if (!selfVerification) return { allowed: true, selfVerification: false, basis: 'independent_verifier' };
  if (input.role === 'admin') return { allowed: true, selfVerification: true, basis: 'admin_self_verification_p4' };
  return {
    allowed: false,
    selfVerification: true,
    code: 'SELF_VERIFICATION_FORBIDDEN',
    message: '自分で登録した証跡は自分で確認できません。代表者または別の担当者に確認を依頼してください'
  };
}
