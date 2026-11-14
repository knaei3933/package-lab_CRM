import type { UserRole } from '@kanei/core';

/**
 * M8-OPERATOR FIX 1: role-based shaping of the maker purchase-order answers.
 *
 * The maker PO row freezes the paper the maker receives — order identity, items
 * with quantities, the artwork hashes, the amounts and the recipient address —
 * so a single row carries the money numbers of the whole deal. admin, staff and
 * viewer all read the same row; only the *answer* differs, and the rows are
 * never rewritten here (the same contract as audit-view.ts: one function, so
 * the three answers can never drift apart, and explicit allowlists rather than
 * denylists — a field that appears tomorrow is hidden by default until it is
 * added here on purpose).
 *
 * - admin (the representative): the whole frozen paper — amounts, totals, the
 *   snapshot digest, the recipient — plus the full event trail.
 * - staff: what the work needs — identity, order linkage, status, the dates,
 *   and the delivery key (the recipient address a send must prove). No
 *   amounts, no totals, no costs, no snapshot body, and no digest of a body
 *   staff cannot read.
 * - viewer: a non-sensitive status summary — identity and status only.
 */

/** One maker_purchase_orders row exactly as the endpoints select it. */
export interface MakerPoRecord {
  id: string;
  filmSupplyOrderId: string;
  snapshot: unknown;
  snapshotSha256: string;
  status: string;
  ceoApprovedByUserId: string | null;
  ceoApprovedAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One maker_po_events row exactly as the endpoints select it. */
export interface MakerPoEventRecord {
  id: string;
  makerPurchaseOrderId: string;
  eventType: string;
  evidenceDocumentVersionId: string | null;
  senderAddress: string | null;
  recipients: unknown;
  sentAt: Date | null;
  attachmentHashes: unknown;
  verificationStatus: string;
  provisional: boolean;
  recordedByUserId: string;
  recordedAt: Date;
}

/** The maker PO parts of the snapshot a staff answer is allowed to carry. */
interface MakerPoSnapshotWorkFacts {
  orderCode: string | null;
  recipientAddress: string | null;
}

function snapshotWorkFacts(snapshot: unknown): MakerPoSnapshotWorkFacts {
  const source = (snapshot ?? {}) as {
    order?: { code?: unknown };
    recipient?: { address?: unknown };
  };
  return {
    orderCode: typeof source.order?.code === 'string' ? source.order.code : null,
    recipientAddress: typeof source.recipient?.address === 'string' ? source.recipient.address : null
  };
}

/** admin: the row as it is stored. Nothing is added, nothing is removed. */
export interface MakerPoAdminView extends MakerPoRecord {}

/** staff: the work view. Amounts, costs, the snapshot body and its digest stay out. */
export interface MakerPoStaffView {
  id: string;
  filmSupplyOrderId: string;
  orderCode: string | null;
  status: string;
  /** The delivery key of the paper: where a send has to be proven to go. */
  recipientAddress: string | null;
  ceoApprovedAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** viewer: the non-sensitive status summary (identity, status, occurred dates). */
export interface MakerPoViewerView {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MakerPoView = MakerPoAdminView | MakerPoStaffView | MakerPoViewerView;

/** admin: the event as it is stored. */
export interface MakerPoEventAdminView extends MakerPoEventRecord {}

/** staff: which event happened, its verification state and its dates. */
export interface MakerPoEventStaffView {
  id: string;
  eventType: string;
  verificationStatus: string;
  /** True only for a provisional acceptance a staff member recorded. */
  provisional: boolean;
  sentAt: Date | null;
  recordedAt: Date;
}

/** viewer: which event happened, and when it was written down. */
export interface MakerPoEventViewerView {
  id: string;
  eventType: string;
  recordedAt: Date;
}

export type MakerPoEventView =
  | MakerPoEventAdminView
  | MakerPoEventStaffView
  | MakerPoEventViewerView;

export function buildMakerPoViewForRole(role: UserRole, po: MakerPoRecord): MakerPoView {
  if (role === 'viewer') {
    return {
      id: po.id,
      status: po.status,
      createdAt: po.createdAt,
      updatedAt: po.updatedAt
    };
  }

  if (role === 'staff') {
    const facts = snapshotWorkFacts(po.snapshot);
    return {
      id: po.id,
      filmSupplyOrderId: po.filmSupplyOrderId,
      orderCode: facts.orderCode,
      status: po.status,
      recipientAddress: facts.recipientAddress,
      ceoApprovedAt: po.ceoApprovedAt,
      createdByUserId: po.createdByUserId,
      createdAt: po.createdAt,
      updatedAt: po.updatedAt
    };
  }

  return { ...po };
}

export function buildMakerPoEventViewForRole(
  role: UserRole,
  event: MakerPoEventRecord
): MakerPoEventView {
  if (role === 'viewer') {
    return { id: event.id, eventType: event.eventType, recordedAt: event.recordedAt };
  }

  if (role === 'staff') {
    return {
      id: event.id,
      eventType: event.eventType,
      verificationStatus: event.verificationStatus,
      provisional: event.provisional,
      sentAt: event.sentAt,
      recordedAt: event.recordedAt
    };
  }

  return { ...event };
}
