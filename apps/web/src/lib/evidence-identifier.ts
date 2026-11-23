import type { AuditEventView } from './project-data';

/**
 * p5 R11: the evidence list's 「確認状態」 mixed two checks — the check of the FILE (documents.verification_status) and the check of an
 * approval's IDENTIFIER (自動 / 手動). An approval evidence that was read automatically still said 「未確認」. The identifier check
 * is read from the approval records the role may read (audit-history: ARTWORK_APPROVAL_RECORDED → evidenceIdentifierStatus, and
 * EVIDENCE_MANUAL_VERIFICATION_RECORDED → result), keyed by the cited document version. No amount, no free text.
 */
export type IdentifierState = 'auto_verified' | 'manual_pending' | 'manual_verified' | 'rejected' | 'not_applicable';

export const IDENTIFIER_STATE_TEXT: Readonly<Record<IdentifierState, string>> = {
  auto_verified: '自動確認済み',
  manual_pending: '手動確認待ち',
  manual_verified: '手動確認済み',
  rejected: '却下',
  not_applicable: '確認の対象外'
};

export const IDENTIFIER_HISTORY_ACTIONS = ['ARTWORK_APPROVAL_RECORDED', 'EVIDENCE_MANUAL_VERIFICATION_RECORDED'] as const;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

type Row = Pick<AuditEventView, 'action' | 'entityId' | 'occurredAt' | 'afterState'>;

/** Pure: document version id → the identifier state of the approval that cites it (the newest approval, its newest manual check). */
export function identifierStatesByVersion(events: readonly Row[]): Map<string, IdentifierState> {
  const checks = new Map<string, { result: string; at: string }>();
  for (const event of events) {
    if (event.action !== 'EVIDENCE_MANUAL_VERIFICATION_RECORDED') continue;
    const approvalId = text(event.afterState?.approvalEventId) ?? event.entityId;
    const result = text(event.afterState?.result);
    if (!approvalId || !result) continue;
    const known = checks.get(approvalId);
    if (!known || known.at <= event.occurredAt) checks.set(approvalId, { result, at: event.occurredAt });
  }
  const latest = new Map<string, { state: IdentifierState; at: string }>();
  for (const event of events) {
    if (event.action !== 'ARTWORK_APPROVAL_RECORDED') continue;
    const versionId = text(event.afterState?.evidenceDocumentVersionId);
    const status = text(event.afterState?.evidenceIdentifierStatus);
    if (!versionId || !status) continue;
    let state: IdentifierState;
    if (status === 'verified_in_document') state = 'auto_verified';
    else if (status === 'not_applicable') state = 'not_applicable';
    else if (status === 'pending_manual_verification') {
      const check = checks.get(event.entityId);
      state = check ? (check.result === 'verified' ? 'manual_verified' : check.result === 'rejected' ? 'rejected' : 'manual_pending') : 'manual_pending';
    } else continue;
    const known = latest.get(versionId);
    if (!known || known.at <= event.occurredAt) latest.set(versionId, { state, at: event.occurredAt });
  }
  return new Map([...latest].map(([versionId, entry]) => [versionId, entry.state]));
}
