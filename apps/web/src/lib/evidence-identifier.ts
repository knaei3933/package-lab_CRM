import { EVIDENCE_VERIFICATION_RESULTS } from '@kanei/core';
import type { AuditEventView } from './project-data';

/**
 * p5 R11: the evidence list's 「確認状態」 mixed two checks — the check of the FILE (documents.verification_status) and the check of an
 * approval's IDENTIFIER (自動 / 手動). An approval evidence that was read automatically still said 「未確認」. The identifier check
 * is read from the approval records the role may read (audit-history: ARTWORK_APPROVAL_RECORDED → evidenceIdentifierStatus, and
 * EVIDENCE_MANUAL_VERIFICATION_RECORDED → result), keyed by the cited document version. No amount, no free text.
 *
 * p5 round 2 (review M-1): the server writes `confirmed` / `rejected` (core EVIDENCE_VERIFICATION_RESULTS) — the first round read `verified`,
 * so a checked evidence read 「手動確認待ち」 for every role. And a role whose audit rows carry no `result` (staff) used to fall back to
 * 「待ち」 too — a state nobody had. Now: a check ROW without a readable result is 「手動確認を記録済み」 (true), and for the staff the
 * result is read from the order's approval gate (which the role may read) when that is unambiguous (resolveFromGates).
 */
export type IdentifierState = 'auto_verified' | 'manual_pending' | 'manual_verified' | 'rejected' | 'not_applicable' | 'manual_recorded';

export const IDENTIFIER_STATE_TEXT: Readonly<Record<IdentifierState, string>> = {
  auto_verified: '自動確認済み',
  manual_pending: '手動確認待ち',
  manual_verified: '手動確認済み',
  rejected: '却下',
  not_applicable: '確認の対象外',
  manual_recorded: '手動確認を記録済み（結果は代表・監査が確認）'
};

export const IDENTIFIER_HISTORY_ACTIONS = ['ARTWORK_APPROVAL_RECORDED', 'EVIDENCE_MANUAL_VERIFICATION_RECORDED'] as const;
/** The audit-history read size of the evidence list (newest first): more records than this are not seen. */
export const IDENTIFIER_HISTORY_LIMIT = 500;

const [RESULT_CONFIRMED, RESULT_REJECTED] = EVIDENCE_VERIFICATION_RESULTS;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

type Row = Pick<AuditEventView, 'action' | 'entityId' | 'occurredAt' | 'afterState'>;

/** One approval record of the window, as far as the role reads it. */
export interface ApprovalRef {
  eventId: string;
  versionId: string;
  organization: string | null;
  designKey: string | null;
  revisionNo: number | null;
  at: string;
}

export interface IdentifierRead {
  /** document version id → the identifier state of the approval that cites it (the newest approval, its newest manual check). */
  states: Map<string, IdentifierState>;
  /** The approvals of the window (every status), for resolveFromGates. */
  approvals: ApprovalRef[];
}

/** Pure: the identifier states of the approval records. `result` absent on a check row (staff) = 「記録済み」, never 「待ち」. */
export function identifierStatesByVersion(events: readonly Row[]): Map<string, IdentifierState> {
  return readIdentifiers(events).states;
}

export function readIdentifiers(events: readonly Row[]): IdentifierRead {
  // approval event id → its newest manual check (the row exists for every role that reads the action; `result` only for some).
  const checks = new Map<string, { result: string | null; at: string }>();
  for (const event of events) {
    if (event.action !== 'EVIDENCE_MANUAL_VERIFICATION_RECORDED') continue;
    const approvalId = text(event.afterState?.approvalEventId) ?? event.entityId;
    if (!approvalId) continue;
    const known = checks.get(approvalId);
    if (!known || known.at <= event.occurredAt) checks.set(approvalId, { result: text(event.afterState?.result), at: event.occurredAt });
  }
  const latest = new Map<string, { state: IdentifierState; at: string }>();
  const approvals: ApprovalRef[] = [];
  for (const event of events) {
    if (event.action !== 'ARTWORK_APPROVAL_RECORDED') continue;
    const versionId = text(event.afterState?.evidenceDocumentVersionId);
    const status = text(event.afterState?.evidenceIdentifierStatus);
    if (!versionId || !status) continue;
    approvals.push({
      eventId: event.entityId, versionId, organization: text(event.afterState?.organization), designKey: text(event.afterState?.designKey),
      revisionNo: typeof event.afterState?.revisionNo === 'number' ? event.afterState.revisionNo : null, at: event.occurredAt
    });
    let state: IdentifierState;
    if (status === 'verified_in_document') state = 'auto_verified';
    else if (status === 'not_applicable') state = 'not_applicable';
    else if (status === 'pending_manual_verification') {
      const check = checks.get(event.entityId);
      if (!check) state = 'manual_pending';
      else if (check.result === RESULT_CONFIRMED) state = 'manual_verified';
      else if (check.result === RESULT_REJECTED) state = 'rejected';
      else state = 'manual_recorded';
    } else continue;
    const known = latest.get(versionId);
    if (!known || known.at <= event.occurredAt) latest.set(versionId, { state, at: event.occurredAt });
  }
  return { states: new Map([...latest].map(([versionId, entry]) => [versionId, entry.state])), approvals };
}

/** The part of an order's approval gate the resolution reads (a role-safe subset of ApprovalGateView). */
export interface GateLike {
  designs: ReadonlyArray<{
    designKey: string;
    currentRevisionNo: number;
    customer: SlotLike;
    seven: SlotLike;
  }>;
}
interface SlotLike {
  latestDecision: string | null;
  revoked: boolean;
  invalidatedByNewerRevision: boolean;
  manualVerification: { result: string } | null;
}

/**
 * Pure: for the evidence whose check ROW exists but whose result the role cannot read (staff), read the result from the order's
 * approval gate — only when it is unambiguous: the approval is the LATEST of its slot (order · design · organization · revision) among
 * the window, and the gate's slot for that revision still stands on a decision. Anything else stays 「手動確認を記録済み」.
 * `docOf` maps a cited version to its order code and design (from the evidence list). Returns a new map.
 */
export function resolveFromGates(
  states: ReadonlyMap<string, IdentifierState>,
  approvals: readonly ApprovalRef[],
  docOf: (versionId: string) => { orderCode: string | null; designKey: string | null } | null,
  gates: ReadonlyMap<string, GateLike | null>
): Map<string, IdentifierState> {
  const out = new Map(states);
  const slotKey = (ref: ApprovalRef): string | null => {
    const doc = docOf(ref.versionId);
    const designKey = ref.designKey ?? doc?.designKey ?? null;
    if (!doc?.orderCode || !designKey || !ref.organization || ref.revisionNo === null) return null;
    return `${doc.orderCode}|${designKey}|${ref.organization}|${ref.revisionNo}`;
  };
  const newest = new Map<string, ApprovalRef>();
  for (const ref of approvals) {
    const key = slotKey(ref);
    if (!key) continue;
    const known = newest.get(key);
    if (!known || known.at <= ref.at) newest.set(key, ref);
  }
  for (const ref of approvals) {
    if (out.get(ref.versionId) !== 'manual_recorded') continue;
    const key = slotKey(ref);
    if (!key || newest.get(key) !== ref) continue;
    const doc = docOf(ref.versionId);
    const gate = doc?.orderCode ? gates.get(doc.orderCode) ?? null : null;
    const design = gate?.designs.find((candidate) => candidate.designKey === (ref.designKey ?? doc?.designKey) && candidate.currentRevisionNo === ref.revisionNo);
    const slot = design && (ref.organization === 'customer' ? design.customer : ref.organization === 'seven' ? design.seven : null);
    if (!slot || slot.latestDecision !== 'APPROVE' || slot.revoked || slot.invalidatedByNewerRevision || !slot.manualVerification) continue;
    if (slot.manualVerification.result === RESULT_CONFIRMED) out.set(ref.versionId, 'manual_verified');
    else if (slot.manualVerification.result === RESULT_REJECTED) out.set(ref.versionId, 'rejected');
  }
  return out;
}
