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
  | { kind: 'paper'; displayNumber: string | null };

/** P5 R3: the feed's `basis` of one row (server: auditBasisFor) — the cited version, the result, the reason, the paper. */
export interface AuditBasis {
  evidenceDocumentVersionId: string | null;
  result: string | null;
  reasonNote: string | null;
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
    reasonNote: text(basis.reasonNote)?.slice(0, 500) ?? null,
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
 * P5 R3: the decision a manual-check / document-check row recorded — 「確認」/「却下」 and the reason the
 * representative wrote (the server masks figures that read like money for every role but the representative).
 * Null when the row is not such a decision.
 */
export function decisionOf(event: Pick<AuditEventView, 'basis'>): { result: string; reasonNote: string | null } | null {
  const basis = auditBasisOf(event);
  if (!basis?.result) return null;
  return { result: DECISION_RESULT_LABELS[basis.result] ?? basis.result, reasonNote: basis.reasonNote };
}

/** P5 R3: the 監査履歴 asks for 納品の確認 too; its words (the shared ACTION_LABELS has none). */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  FILM_DELIVERY_CONFIRMED: '納品の確認を記録',
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
  const basis = auditBasisOf(event);
  const versionId = basis?.evidenceDocumentVersionId ?? text(event.afterState?.evidenceDocumentVersionId);
  if (!versionId) return basis?.makerPurchaseOrder ? { kind: 'paper', displayNumber: basis.makerPurchaseOrder.displayNumber } : { kind: 'none' };
  const found = index?.get(versionId);
  return found ? { kind: 'found', evidence: found } : { kind: 'unreadable' };
}

/** 何を: the order code and the maker paper number the record carries, if any. */
export function eventTargets(event: AuditEventView): { orderCode: string | null; displayNumber: string | null } {
  const after = event.afterState ?? {};
  return {
    orderCode: text(after.orderCode) ?? (event.entityType === 'film_supply_order' ? text(after.code) : null),
    displayNumber: text(after.displayNumber)
  };
}
