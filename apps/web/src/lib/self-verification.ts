import { normalizeRole } from './permissions';

/**
 * P1 P-4 (API_CONTRACT v3 §4, 1-person operation): a staff member never confirms
 * evidence they registered themselves — the API refuses SELF_VERIFICATION_FORBIDDEN,
 * and the screen does not offer the button. The representative may confirm their own
 * evidence (the API records the verifier and the time itself, selfVerification: true).
 * Display only: the API decides.
 */
export const SELF_VERIFICATION_NOTICE = '自分で登録した証跡は自分で確認できません。代表者または別の担当者が確認します。';

export function isOwnEvidenceOfStaff(role: string | null | undefined, userId: string | null, uploadedByUserId: string | null | undefined): boolean {
  return normalizeRole(role) === 'staff' && Boolean(userId) && userId === uploadedByUserId;
}

/** The uploader ids of a document: the row's creator and every version's uploader (API_CONTRACT §4 「本人」). */
export function uploaderIdsOf(document: { uploadedByUserId?: string | null | undefined; versions: ReadonlyArray<{ uploadedByUserId?: string | null | undefined }> }): string[] {
  return [document.uploadedByUserId, ...document.versions.map((version) => version.uploadedByUserId)]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** A document a staff member may not confirm: they created it or uploaded any version of it. */
export function isOwnDocumentOfStaff(role: string | null | undefined, userId: string | null, document: Parameters<typeof uploaderIdsOf>[0]): boolean {
  return normalizeRole(role) === 'staff' && Boolean(userId) && uploaderIdsOf(document).includes(userId!);
}
