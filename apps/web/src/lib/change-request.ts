import { FILM_SUPPLY_ORDER_STATES } from '@kanei/core';
import type { ApprovalEventRecord, ApprovalGateView, ArtworkRevisionView, DocumentView, FilmSupplyOrderView } from './project-data';
import { knownStatus } from './project-data';
import { changeRequestKey } from './change-request-key';
import { shortId } from './short-id';

export { changeRequestKey };

/**
 * UI batch F (server R1-9 / F2, representative Q-A4): which revision form
 * submissions are a controlled change request, read from what the screen
 * already loaded. This is a convenience for the form only — the API decides
 * (`invalidatedApprovals`: the design has approval history), and the form
 * still lets the operator open the change fields by hand.
 */

/**
 * Designs with approval history: any approval decision recorded on any of the
 * design's revisions (the gate's per-organization state, or an approval record
 * — whose decision may be withheld from staff, so any record counts), or a
 * revision that already invalidated approvals (the history never goes away).
 */
export function approvalHistoryKeys(
  revisions: readonly ArtworkRevisionView[],
  approvalEvents: readonly ApprovalEventRecord[],
  gates: readonly (ApprovalGateView | null)[]
): string[] {
  const keys = new Set<string>();
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  for (const revision of revisions) {
    if (revision.invalidatedApprovals) keys.add(changeRequestKey(revision.filmSupplyOrderId, revision.designKey));
  }
  for (const event of approvalEvents) {
    const revision = revisionById.get(event.artworkRevisionId);
    if (revision) keys.add(changeRequestKey(revision.filmSupplyOrderId, revision.designKey));
  }
  for (const gate of gates) {
    if (!gate) continue;
    for (const design of gate.designs) {
      const touched = [design.customer, design.seven].some((state) =>
        state.valid
        || state.latestDecision !== null
        || state.revoked
        || state.invalidatedByNewerRevision
        || state.pendingEvidenceIdentifier);
      if (touched) keys.add(changeRequestKey(gate.orderId, design.designKey));
    }
  }
  return [...keys];
}

const PRINT_START_INDEX = FILM_SUPPLY_ORDER_STATES.indexOf('FILM_IN_PRODUCTION');

/**
 * Orders whose change needs the representative: printing has started
 * (FILM_IN_PRODUCTION or later). A hold or cancellation review is judged by the
 * state it left, as the API reads the audited origin; CHANGE_REVIEW itself is
 * not a print state.
 */
export function printingStartedOrderIds(orders: readonly FilmSupplyOrderView[]): string[] {
  return orders.filter((order) => {
    const status = knownStatus(order);
    if (status === null) return false;
    const effective = status === 'ON_HOLD' || status === 'CANCELLATION_REVIEW' ? order.lastNormalStatus : status;
    if (effective === null) return false;
    return FILM_SUPPLY_ORDER_STATES.indexOf(effective as typeof FILM_SUPPLY_ORDER_STATES[number]) >= PRINT_START_INDEX;
  }).map((order) => order.id);
}

export interface ChangeEvidenceChoice {
  value: string;
  label: string;
  orderId: string;
  /** null: the evidence is bound to the order only (valid for every design). */
  designKey: string | null;
}

/** The API accepts approval evidence bound to the same order (and design, when bound). */
export function changeEvidenceChoices(documents: readonly DocumentView[]): ChangeEvidenceChoice[] {
  return documents
    .filter((document) => document.documentType === 'approval_evidence' && document.filmSupplyOrderId !== null)
    .flatMap((document) => document.versions.map((version) => ({
      value: version.id,
      label: `${document.filename}（版${version.versionNumber}${document.designKey ? `／デザイン ${document.designKey}` : ''}／ID ${shortId(version.id)}）`,
      orderId: document.filmSupplyOrderId!,
      designKey: document.designKey
    })));
}
