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
  | { kind: 'found'; evidence: EvidenceRef };

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

/** 根拠: no evidence id on the record, the matching evidence, or an honest "could not read". */
export function evidenceCell(event: AuditEventView, index: Map<string, EvidenceRef> | null): EvidenceCell {
  const versionId = text(event.afterState?.evidenceDocumentVersionId);
  if (!versionId) return { kind: 'none' };
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
