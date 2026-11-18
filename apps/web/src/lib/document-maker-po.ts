// Pure helpers only: imported by a client component, so no server-only imports (api.ts, maker-po-data.ts values).
import type { Choice } from './types';
import type { MakerPoViewRow } from './maker-po-data';
import { shortId } from './short-id';

/** Document types that are about one maker purchase order (API intake: makerPurchaseOrderId). */
export const MAKER_PO_BOUND_DOCUMENT_TYPES: readonly string[] = ['acceptance_evidence', 'send_evidence'];

export function isMakerPoBoundDocumentType(documentType: string): boolean {
  return MAKER_PO_BOUND_DOCUMENT_TYPES.includes(documentType);
}

/**
 * UI batch E (F-07): mirror of @kanei/core OFFICIAL_ARTIFACT_DOCUMENT_TYPES —
 * the types the API registers only with a verified セブン化学発注書 link
 * (SEVEN_PO_REQUIRED). Pinned equal by tests/web-ui-batch-e.test.tsx.
 */
export const SEVEN_PO_REQUIRED_DOCUMENT_TYPES: readonly string[] = ['proof', 'approval_evidence', 'send_evidence', 'acceptance_evidence'];

export function requiresSevenPo(documentType: string): boolean {
  return SEVEN_PO_REQUIRED_DOCUMENT_TYPES.includes(documentType);
}

/** A selectable セブン化学発注書, tagged with whether it opens the gate (registered + verified, no review). */
export interface SevenPoChoice extends Choice {
  ready: boolean;
}

/**
 * UI batch E (F-07): the PO preselected for a document that needs one — the
 * only ready PO of the project, or none when there are several (the operator
 * chooses) or none ready.
 */
export function defaultSevenPoId(choices: readonly SevenPoChoice[]): string {
  const ready = choices.filter((choice) => choice.ready);
  return ready.length === 1 ? ready[0]!.value : '';
}

/** A selectable maker PO, tagged with the film supply order the API requires it to be bound with. */
export interface MakerPoChoice extends Choice {
  filmSupplyOrderId: string;
}

/** Cancelled papers are history only; every other status can still be the target of evidence. */
export function toMakerPoChoices(
  orders: ReadonlyArray<{ id: string; code: string }>,
  rowsByOrderId: ReadonlyMap<string, readonly MakerPoViewRow[]>,
  statusLabels: Readonly<Record<string, string>>
): MakerPoChoice[] {
  const choices: MakerPoChoice[] = [];
  for (const order of orders) {
    for (const row of rowsByOrderId.get(order.id) ?? []) {
      if (row.status === 'CANCELLED') continue;
      choices.push({
        value: row.id,
        filmSupplyOrderId: order.id,
        label: `${order.code} / ${shortId(row.id)}（${statusLabels[row.status] ?? row.status}）`
      });
    }
  }
  return choices;
}
