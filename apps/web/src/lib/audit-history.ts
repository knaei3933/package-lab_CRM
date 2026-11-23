import { documentTypeText, issuerText, shortHash } from './evidence-data';
import type { EvidenceDocumentView, EvidenceVersionView } from './evidence-data';
import type { AuditEventView } from './project-data';

/**
 * P2 P-2: one row of the auditor's 監査履歴 — who, when, what, and the
 * evidence behind it. Built only from keys the API lets an auditor read
 * (contract §7); no amount, no snapshot, no free-form note is ever read.
 */
export interface EvidenceRef {
  documentId: string;
  label: string;
  filename: string | null;
  filenameHidden: boolean;
  hash: string | null;
}

export type EvidenceCell =
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'found'; evidence: EvidenceRef }
  /** P5 R3: the 代表承認 of a maker paper rests on the paper itself (its content snapshot), not on a file. */
  | { kind: 'paper'; displayNumber: string | null }
  /** p6 R3: a 完了 (FILM_RECEIPT_ASSUMPTION_RECORDED) rests on confirmed deliveries, or on nothing but the operator's consent. */
  | { kind: 'closure'; basis: ReceiptClosureBasis };

export type ReceiptClosureBasis = 'delivery_confirmations' | 'evidence_free_acknowledgment';

/** P5 R3: the feed's `basis` of one row (server: auditBasisFor) — the cited version, the result, the reason, the paper. */
export interface AuditBasis {
  evidenceDocumentVersionId: string | null;
  result: string | null;
  makerPurchaseOrder: { displayNumber: string | null } | null;
}

export function auditBasisOf(event: Pick<AuditEventView, 'basis'>): AuditBasis | null {
  const raw = event.basis;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const basis = raw as Record<string, unknown>;
  const paper = typeof basis.makerPurchaseOrder === 'object' && basis.makerPurchaseOrder !== null ? basis.makerPurchaseOrder as Record<string, unknown> : null;
  return {
    evidenceDocumentVersionId: text(basis.evidenceDocumentVersionId),
    result: text(basis.result),
    // Round 2 (p5-int review H-2): a written reason is never read here (the 監査履歴 is not the representative's screen).
    makerPurchaseOrder: paper ? { displayNumber: text(paper.displayNumber) } : null
  };
}

const DECISION_RESULT_LABELS: Readonly<Record<string, string>> = {
  confirmed: '確認',
  rejected: '却下',
  verified: '確認済み',
  needs_review: '要確認'
};

/**
 * P5 R3: the decision a manual-check / document-check row recorded — 「確認」/「却下」. Round 2 (H-2): the reason the
 * representative wrote is not part of it (the server sends it to the representative only). Null when the row is
 * not such a decision.
 */
export function decisionOf(event: Pick<AuditEventView, 'basis'>): { result: string } | null {
  const basis = auditBasisOf(event);
  if (!basis?.result) return null;
  return { result: DECISION_RESULT_LABELS[basis.result] ?? basis.result };
}

const RECEIPT_CLOSURE_ACTION = 'FILM_RECEIPT_ASSUMPTION_RECORDED';

/** Operations the server stamps on the audit row (requestMetadata.operation — the one key every role's feed carries). */
const CLOSURE_OPERATIONS: Readonly<Record<string, ReceiptClosureBasis>> = {
  'film_order:close_receipt_on_confirmed_deliveries': 'delivery_confirmations',
  'film_order:assume_receipt': 'evidence_free_acknowledgment'
};

/**
 * p6 R3: what a 完了 row rests on. The representative's feed carries `afterState.closureBasis`; the auditor's does not (its key
 * list has neither that nor the ids of the confirmed deliveries), but both feeds carry `requestMetadata.operation`, which the
 * server sets from the same decision. A row that says neither is a closure from before P4 — all of those were evidence-free
 * (lib/receipt-closure). Null for any other action.
 */
export function receiptClosureOf(event: Pick<AuditEventView, 'action' | 'afterState' | 'requestMetadata'>): { basis: ReceiptClosureBasis } | null {
  if (event.action !== RECEIPT_CLOSURE_ACTION) return null;
  return { basis: statedClosureBasis(event) ?? 'evidence_free_acknowledgment' };
}

/**
 * The basis a 完了 row SAYS (its own closureBasis, else its operation name); null when the feed of this role says nothing (a
 * viewer's feed carries neither) — there the caller must not guess. Pre-P4 closures say neither but are all evidence-free:
 * that default belongs to `receiptClosureOf`, for the feeds that do carry the operation.
 */
export function statedClosureBasis(event: Pick<AuditEventView, 'afterState' | 'requestMetadata'>): ReceiptClosureBasis | null {
  const stated = event.afterState?.closureBasis;
  if (stated === 'delivery_confirmations' || stated === 'evidence_free_acknowledgment') return stated;
  const operation = text(event.requestMetadata?.operation);
  return operation ? CLOSURE_OPERATIONS[operation] ?? null : null;
}

/** p6 R3: the row's name by what the completion rests on (the shared 「問題なしで完了を記録」 said nothing about it). */
export function receiptClosureActionLabel(basis: ReceiptClosureBasis): string {
  return basis === 'delivery_confirmations' ? '確認済みの納品で完了を記録' : '証跡なしで完了を記録';
}

/** P5 R3: the 監査履歴 asks for 納品の確認 too; its words (the shared ACTION_LABELS has none). */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  FILM_DELIVERY_CONFIRMED: '納品の確認を記録',
  // Round 2 (p5-int review M-2): a change of this project's customer / セブン化学 contact address.
  PARTNER_CONTACT_EMAIL_UPDATED: '取引先の連絡先を変更',
  FILLING_DELIVERY_CONFIRMED: '充填製品納品の確認を記録'
};

export function evidenceIndex(documents: readonly EvidenceDocumentView[]): Map<string, EvidenceRef> {
  const index = new Map<string, EvidenceRef>();
  for (const doc of documents) {
    doc.versions.forEach((version: EvidenceVersionView) => {
      if (!version.versionId) return;
      const filename = doc.filenameHidden ? null : (version.originalFilename ?? doc.originalFilename);
      index.set(version.versionId, {
        documentId: doc.documentId,
        label: `${documentTypeText(doc.documentType)}（${issuerText(doc.issuerEntity)}）`,
        filename,
        filenameHidden: filename === null,
        hash: shortHash(version.sha256)
      });
    });
  }
  return index;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 根拠: no evidence id on the record, the matching evidence, or an honest "could not read". P5 R3: the
 * representative's decisions cite their evidence through the feed's `basis` (送信確認・最終受入・書類確認 and the
 * manual checks); a 代表承認 rests on its paper.
 */
export function evidenceCell(event: AuditEventView, index: Map<string, EvidenceRef> | null): EvidenceCell {
  const closure = receiptClosureOf(event);
  if (closure) return { kind: 'closure', ...closure };
  const basis = auditBasisOf(event);
  const versionId = basis?.evidenceDocumentVersionId ?? text(event.afterState?.evidenceDocumentVersionId);
  if (!versionId) return basis?.makerPurchaseOrder ? { kind: 'paper', displayNumber: basis.makerPurchaseOrder.displayNumber } : { kind: 'none' };
  const found = index?.get(versionId);
  return found ? { kind: 'found', evidence: found } : { kind: 'unreadable' };
}

/** The 何を column's words for a row: the shared label, except a 完了 which says what it rests on (p6 R3). */
export function auditActionLabel(event: Pick<AuditEventView, 'action' | 'afterState' | 'requestMetadata'>, fallback: string | undefined): string {
  const closure = receiptClosureOf(event);
  if (closure) return receiptClosureActionLabel(closure.basis);
  return AUDIT_ACTION_LABELS[event.action] ?? fallback ?? '記録';
}

/** Round 2 (M-2): 「連絡先: 前 → 後」 of a PARTNER_CONTACT_EMAIL_UPDATED row (null for any other row). */
export function contactChangeOf(event: AuditEventView): { before: string | null; after: string | null } | null {
  if (event.action !== 'PARTNER_CONTACT_EMAIL_UPDATED') return null;
  return { before: text(event.beforeState?.contactEmail), after: text(event.afterState?.contactEmail) };
}

/** 何を: the order code and the maker paper number the record carries, if any. */
export function eventTargets(event: AuditEventView): { orderCode: string | null; displayNumber: string | null } {
  const after = event.afterState ?? {};
  return {
    orderCode: text(after.orderCode) ?? (event.entityType === 'film_supply_order' ? text(after.code) : null),
    displayNumber: text(after.displayNumber)
  };
}
