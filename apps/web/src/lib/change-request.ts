import { FILM_SUPPLY_ORDER_STATES } from '@kanei/core';
import type { ApprovalEventRecord, ApprovalGateView, ArtworkRevisionView, DocumentView, FilmSupplyOrderView } from './project-data';
import { knownStatus } from './project-data';
import { changeRequestKey } from './change-request-key';
import { shortId } from './short-id';

export { changeRequestKey };

/**
 * UI batch F (server R1-9 / F2, representative Q-A4): which revision form
 * submissions are a controlled change request, read from what the screen
 * already loaded. The API decides (server-batch-f4 M-6, core
 * `hasApprovalHistoryForDesign`) and answers it as `invalidatedApprovals`; the
 * form mirrors that rule and still lets the operator open the change fields by
 * hand, and the action reads the API's answer back (actions.ts).
 */

/**
 * Designs with approval history, by the API contract (server-batch-f4 M-6):
 * any recorded approval decision — APPROVE or REVOKE — on any revision of the
 * design within the order. A REVOKE-only history counts. The rule is read on
 * the approval records the screen loaded, whatever their decision value (the
 * API counts every decision; staff, the role that registers revisions, sees
 * artworkRevisionId on every record).
 *
 * Two more signals are read only as proof that such a record exists, for when
 * the record list did not reach the screen (the audit read is capped at 500
 * rows): a revision that already invalidated approvals (admin only — the flag
 * is off the staff audit allowlist), and a gate state that saw a decision on
 * the current revision (valid, latest decision, revoked, invalidated by a
 * newer revision, pending identifier — each needs a recorded decision).
 * Neither can make the form stricter than the API: a stricter form would send
 * change facts that the API does not store. A looser form is answered by the
 * API's 422 CHANGE_REQUEST_ORGANIZATION_REQUIRED, which the action reads back.
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
