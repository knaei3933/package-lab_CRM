import { ACTION_LABELS } from './dashboard';
import type { AuditEventView } from './project-data';
import { DOCUMENT_TYPE_LABELS } from './vocabulary';

/**
 * P1 R21: one line of the order screen's 記録 list — what was recorded, in the
 * screens' words, with the new state for a transition. Never an amount (the
 * audit read is the role's own answer; amounts are not read from it).
 */
export function orderRecordText(event: Pick<AuditEventView, 'action' | 'entityType' | 'afterState'>, stateLabel: (key: string) => string): string {
  const base = ACTION_LABELS[event.action] ?? '記録';
  const status = event.afterState && typeof event.afterState.status === 'string' ? event.afterState.status : null;
  // P2: a delivery-date record carries the order's status but does not move it.
  if (event.entityType === 'film_supply_order' && status && event.action !== 'FILM_SUPPLY_ORDER_CREATED' && event.action !== 'FILM_SUPPLY_ORDER_DELIVERY_DATES_UPDATED') {
    return `${base}（→「${stateLabel(status)}」）`;
  }
  return base;
}

/** What a record row adds under its words: the registered file (R15) and the memo the operator typed (M4). */
export interface OrderRecordDetail {
  /** 「受領証跡（検収）」 — the kind of document, when the record names one. */
  documentKind: string | null;
  filename: string | null;
  memo: string | null;
}

const DOCUMENT_ACTIONS: ReadonlySet<string> = new Set(['DOCUMENT_CREATED', 'DOCUMENT_VERSION_UPLOADED']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * p5 R15 / M4: only keys the role's own answer carries are read (a trimmed state says nothing — nothing is invented).
 * The memo is the transition's `evidenceNote` (saved since P0, shown nowhere until now); the file name is the document's
 * (`filename`) or the version's (`originalFilename`). No amount is ever read.
 */
export function orderRecordDetail(event: Pick<AuditEventView, 'action' | 'afterState'>): OrderRecordDetail | null {
  const after = event.afterState && typeof event.afterState === 'object' ? (event.afterState as Record<string, unknown>) : null;
  if (!after) return null;
  const memo = event.action === 'FILM_SUPPLY_ORDER_TRANSITIONED' ? text(after.evidenceNote) : null;
  const filename = DOCUMENT_ACTIONS.has(event.action) ? text(after.originalFilename) ?? text(after.filename) : null;
  const type = DOCUMENT_ACTIONS.has(event.action) ? text(after.documentType) : null;
  const documentKind = type ? DOCUMENT_TYPE_LABELS[type as keyof typeof DOCUMENT_TYPE_LABELS] ?? null : null;
  if (!memo && !filename && !documentKind) return null;
  return { documentKind, filename, memo };
}
