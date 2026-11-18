import type { FilmOrderStatus, MakerPurchaseOrderStatus } from '@kanei/core';

/**
 * UI batch C (2-⑤): one tone per status a screen shows as a badge. A tone is a
 * tint of an existing token plus a written symbol, so a badge never depends on
 * colour alone (the Japanese label always follows the symbol).
 *
 * - done: finished (✓)
 * - active: in progress on our side (●)
 * - waiting: waiting for someone's decision or record (…)
 * - blocked: stopped, refused or needs attention (✕)
 * - neutral: a value this table does not know (○)
 * - hidden: the role may not read the value (—)
 */
export type StatusTone = 'done' | 'active' | 'waiting' | 'blocked' | 'neutral' | 'hidden';

export const STATUS_TONES: readonly StatusTone[] = ['done', 'active', 'waiting', 'blocked', 'neutral', 'hidden'];

export const TONE_SYMBOLS: Readonly<Record<StatusTone, string>> = {
  done: '✓',
  active: '●',
  waiting: '…',
  blocked: '✕',
  neutral: '○',
  hidden: '—'
};

/**
 * Film supply order (core state machine: 14 normal states + 3 exceptions, and
 * CANCELLED — the terminal end of a cancellation review resolved as cancel).
 */
export const FILM_ORDER_STATUS_TONES: Readonly<Record<FilmOrderStatus, StatusTone>> = {
  DRAFT: 'active',
  SEVEN_PO_VERIFIED: 'active',
  ARTWORK_RECEIVED: 'active',
  PROOF_READY: 'active',
  APPROVAL_PENDING: 'waiting',
  DUAL_APPROVED: 'active',
  MAKER_PO_READY: 'active',
  APPROVED_FOR_MANUAL_SEND: 'waiting',
  MAKER_PO_SENT_MANUALLY: 'active',
  MAKER_PO_ACCEPTED: 'active',
  FILM_IN_PRODUCTION: 'active',
  FILM_SHIPPED: 'active',
  FILM_DELIVERED: 'active',
  FILM_RECEIPT_ASSUMED_NO_ISSUE: 'done',
  ON_HOLD: 'blocked',
  CHANGE_REVIEW: 'blocked',
  CANCELLATION_REVIEW: 'blocked',
  // 取消終了: stopped for good — the ✕ mark with キャンセル終了, never neutral ○.
  CANCELLED: 'blocked'
};

/** Maker purchase order (every key of MAKER_PO_STATUS_LABELS). */
export const MAKER_PO_STATUS_TONES: Readonly<Record<MakerPurchaseOrderStatus, StatusTone>> = {
  DRAFT: 'waiting',
  APPROVED_FOR_MANUAL_SEND: 'active',
  SEND_UNVERIFIED: 'blocked',
  MAKER_PO_SENT_MANUALLY: 'waiting',
  MAKER_PO_ACCEPTED: 'done',
  SNAPSHOT_VOIDED: 'waiting',
  CANCELLED: 'blocked'
};

/** Human check of a document / seven PO (VERIFICATION_STATUS_LABELS). */
export const VERIFICATION_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  unverified: 'waiting',
  verified: 'done',
  mismatch: 'blocked'
};

/** Delivery confirmation (fillingDeliveryConfirmationStates). */
export const DELIVERY_CONFIRMATION_TONES: Readonly<Record<string, StatusTone>> = {
  PENDING_CONFIRMATION: 'waiting',
  CONFIRMED: 'done'
};

/** Commission readiness (commissionReadinessStates). */
export const READINESS_STATE_TONES: Readonly<Record<string, StatusTone>> = {
  MISSING_DATA: 'blocked',
  PENDING_VERIFICATION: 'waiting',
  READY: 'done'
};

export type StatusDomain = 'filmOrder' | 'makerPo' | 'verification' | 'deliveryConfirmation' | 'readiness';

const DOMAIN_TONES: Readonly<Record<StatusDomain, Readonly<Record<string, StatusTone>>>> = {
  filmOrder: FILM_ORDER_STATUS_TONES,
  makerPo: MAKER_PO_STATUS_TONES,
  verification: VERIFICATION_STATUS_TONES,
  deliveryConfirmation: DELIVERY_CONFIRMATION_TONES,
  readiness: READINESS_STATE_TONES
};

/**
 * The tone of one status. `null` / `undefined` is a value the role may not
 * read (hidden); a value outside the table is neutral, never a guess.
 */
export function statusTone(domain: StatusDomain, status: string | null | undefined): StatusTone {
  if (status === null || status === undefined) return 'hidden';
  const tones = DOMAIN_TONES[domain];
  return Object.prototype.hasOwnProperty.call(tones, status) ? tones[status]! : 'neutral';
}
