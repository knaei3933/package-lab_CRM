import { callApi } from './api';
import { loadMakerPoDetail } from './maker-po-data';
import type { MakerPoViewRow } from './maker-po-data';
import { loadApprovalGate } from './project-data';
import type { ApprovalGateView, OrganizationApprovalStateView, SevenPurchaseOrderView } from './project-data';
import { formatAmount, formatQuantityWithUnit } from './number-format';
import { orderAmountDisplay, orderFactsFromApi } from './order-terms';

/**
 * P1 R24: the representative's approval card (REDESIGN §5-4) — every fact the
 * approval rests on, on one card: the amount (required), the 支払条件, the
 * lines and the approved 版 of the frozen paper (snapshot items / artworkFiles),
 * each organization's approval with the evidence's issuer, the セブン化学発注書,
 * and the recipient.
 *
 * Contract adapter (p1-server API_CONTRACT §2): the card is read from
 * GET /api/maker-purchase-orders/:poId/approval-card when the API has it; until
 * then (the route answers 404 without a code) the same card is built from the
 * reads the web already makes (the paper's own snapshot, the approval gate).
 * Either way the API decides the approval itself.
 */
export type SealState = 'approved' | 'pending_manual_verification' | 'rejected' | 'revoked' | 'missing';

export interface CardOrganization {
  state: SealState;
  eventTime: string | null;
  evidence: {
    filename: string | null;
    issuerEntity: string | null;
    expectedIssuerEntity: string | null;
    issuerMatchesOrganization: boolean | null;
    evidenceSource: string | null;
    identifierStatus: string | null;
  } | null;
}

export interface CardDesign {
  designKey: string;
  revisionNo: number | null;
  customer: CardOrganization;
  seven: CardOrganization;
}

export interface ApprovalCardView {
  source: 'server' | 'web';
  poId: string;
  displayNumber: string | null;
  status: string;
  orderCode: string;
  paymentTerms: string | null;
  amountDisplay: string | null;
  items: Array<{ lineNumber: number; description: string; quantityDisplay: string }>;
  artworkFiles: Array<{ designKey: string; revisionNo: number; sha256: string; filename: string | null; matchesApprovedRevision: boolean | null }>;
  /**
   * P2 contract v1.1 L2: whether the address is an active master address of the
   * project's maker (true / false); absent or null when the card did not say.
   */
  recipient: { address: string | null; isEmail: boolean; inMakerMaster?: boolean | null | undefined };
  /**
   * P2 R30 / P-8: the 希望納期・納品予定日 of the order and the セブン化学発注書
   * quantity and amount (the card is admin-only). Absent or null on the web
   * fallback card, which has no such data — the card then shows 「—」.
   * A date is `YYYY-MM-DD`, null when not recorded, undefined when not answered.
   */
  deliveryTerms?: CardDeliveryTerms | null | undefined;
  /**
   * P2 verifier M1 (contract §3-2, security review L1): when the 納期・数量 shown on
   * this card last changed — `order.updatedAt|orderFacts.updatedAt` of the server card.
   * They are not in the snapshot hash, so the approval re-reads the card and stops
   * when this moved (the representative never approves terms they did not see).
   * Absent when the card has no such data (web fallback card, an older API).
   */
  termsStamp?: string | undefined;
  sevenPo: { poNumber: string | null; officialRegisteredAt: string | null; verificationStatus: string | null } | null;
  designs: CardDesign[];
  dualApproved: boolean;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  canApprove: boolean;
  canReturn: boolean;
  /** For the approval request: the 支払条件 and (server card) the snapshot hash the card showed. */
  expectedPaymentTerms: string | null;
  expectedSnapshotSha256: string | null;
}

export interface CardDeliveryTerms {
  requestedDeliveryDate: string | null | undefined;
  plannedDeliveryDate: string | null | undefined;
  /** 'unlinked' = no セブン化学発注書; 'unknown' = the card did not carry its order-facts. */
  sevenPo: 'unlinked' | 'unknown' | { quantityDisplay: string | null; amountDisplay: string | null };
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: the server card's dates and order-facts (contract §3). */
export function deliveryTermsFromServer(order: Record<string, unknown>, seven: Record<string, unknown> | null): CardDeliveryTerms {
  const date = (key: string): string | null | undefined => {
    if (!Object.hasOwn(order, key)) return undefined;
    const value = order[key];
    return typeof value === 'string' && CALENDAR_DATE.test(value) ? value : null;
  };
  const facts = seven && isRecord(seven.orderFacts) ? orderFactsFromApi(seven.orderFacts, 'admin') : null;
  return {
    requestedDeliveryDate: date('requestedDeliveryDate'),
    plannedDeliveryDate: date('plannedDeliveryDate'),
    sevenPo: !seven ? 'unlinked' : facts ? { quantityDisplay: facts.quantityDisplay, amountDisplay: orderAmountDisplay(facts.amount) } : 'unknown'
  };
}

/**
 * P2 verifier M1, pure: the change stamp of the card's 納期・数量 — the order's
 * updatedAt and the セブン化学発注書 order-facts' updatedAt (empty when none recorded).
 * Null when the card does not carry the order's updatedAt (nothing to compare).
 */
/** P2 verifier M1: the 納期・数量 changed after the card was drawn. */
export const TERMS_CHANGED_MESSAGE = '承認カードを開いたあとに納期またはセブン化学発注書の数量・金額が変わりました。承認は止めました。画面を再読み込みして、新しい内容を確かめてから承認してください。';
/** P2 verifier M1: the card could not be read again, so the terms could not be compared. */
export const TERMS_UNREADABLE_MESSAGE = '納期・数量を確かめ直せなかったため、承認を止めました。少し待ってから画面を再読み込みしてください。';

export function deliveryTermsStamp(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.order)) return null;
  const orderUpdatedAt = text(data.order.updatedAt);
  if (!orderUpdatedAt) return null;
  const seven = isRecord(data.sevenPurchaseOrder) ? data.sevenPurchaseOrder : null;
  const facts = seven && isRecord(seven.orderFacts) ? seven.orderFacts : null;
  return `${orderUpdatedAt}|${facts ? text(facts.updatedAt) ?? '' : ''}`;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Whether a 404 is "this route does not exist yet" (no API code) rather than a refusal. */
export function isMissingRoute(result: { ok: boolean; status: number; data: unknown }): boolean {
  return !result.ok && result.status === 404 && !(isRecord(result.data) && typeof result.data.code === 'string');
}

function organizationFromServer(value: unknown): CardOrganization {
  const record = isRecord(value) ? value : {};
  const evidence = isRecord(record.evidence) ? record.evidence : null;
  const state = text(record.state) as SealState | null;
  return {
    state: state ?? 'missing',
    eventTime: text(record.eventTime),
    evidence: evidence
      ? {
          filename: text(evidence.filename),
          issuerEntity: text(evidence.issuerEntity),
          expectedIssuerEntity: text(evidence.expectedIssuerEntity),
          issuerMatchesOrganization: typeof evidence.issuerMatchesOrganization === 'boolean' ? evidence.issuerMatchesOrganization : null,
          evidenceSource: text(evidence.evidenceSource),
          identifierStatus: text(evidence.identifierStatus)
        }
      : null
  };
}

/** Pure: the server card (contract §2-1) in the screen's shape. */
export function cardFromServer(poId: string, data: unknown): ApprovalCardView | null {
  if (!isRecord(data) || !isRecord(data.makerPurchaseOrder) || !isRecord(data.order) || !isRecord(data.snapshot)) return null;
  const paper = data.makerPurchaseOrder;
  const order = data.order;
  const snapshot = data.snapshot;
  const amounts = isRecord(snapshot.amounts) ? snapshot.amounts : null;
  const approvals = isRecord(data.approvals) ? data.approvals : {};
  const seven = isRecord(data.sevenPurchaseOrder) ? data.sevenPurchaseOrder : null;
  const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);
  const notes = (value: unknown) => list(value).map((entry) => ({ code: text(entry.code) ?? '', message: text(entry.message) ?? '' }));
  const recipient = isRecord(snapshot.recipient) ? snapshot.recipient : {};
  return {
    source: 'server',
    poId,
    displayNumber: text(paper.displayNumber),
    status: text(paper.status) ?? 'DRAFT',
    orderCode: text(order.code) ?? '',
    paymentTerms: text(order.paymentTerms),
    amountDisplay: amounts ? text(amounts.display) ?? formatAmount(text(amounts.currency), text(amounts.totalAmount)) : null,
    items: list(snapshot.items).map((item) => ({
      lineNumber: typeof item.lineNumber === 'number' ? item.lineNumber : 0,
      description: text(item.description) ?? '',
      quantityDisplay: text(item.quantityDisplay) ?? formatQuantityWithUnit(text(item.orderedQuantity), text(item.unit))
    })),
    artworkFiles: list(snapshot.artworkFiles).map((file) => ({
      designKey: text(file.designKey) ?? '',
      revisionNo: typeof file.revisionNo === 'number' ? file.revisionNo : 0,
      sha256: text(file.fileSha256) ?? '',
      filename: text(file.filename),
      matchesApprovedRevision: typeof file.matchesApprovedRevision === 'boolean' ? file.matchesApprovedRevision : null
    })),
    recipient: {
      address: text(recipient.address),
      isEmail: recipient.isEmail === true,
      ...(typeof recipient.inMakerMaster === 'boolean' ? { inMakerMaster: recipient.inMakerMaster } : {})
    },
    deliveryTerms: deliveryTermsFromServer(order, seven),
    ...(deliveryTermsStamp(data) ? { termsStamp: deliveryTermsStamp(data)! } : {}),
    sevenPo: seven ? { poNumber: text(seven.poNumber), officialRegisteredAt: text(seven.officialRegisteredAt), verificationStatus: text(seven.verificationStatus) } : null,
    designs: list(approvals.designs).map((design) => {
      const organizations = isRecord(design.organizations) ? design.organizations : {};
      return {
        designKey: text(design.designKey) ?? '',
        revisionNo: typeof design.currentRevisionNo === 'number' ? design.currentRevisionNo : null,
        customer: organizationFromServer(organizations.customer),
        seven: organizationFromServer(organizations.seven)
      };
    }),
    dualApproved: approvals.dualApproved === true,
    blockers: notes(data.blockers),
    warnings: notes(data.warnings),
    canApprove: data.canApprove === true,
    canReturn: data.canReturn === true,
    expectedPaymentTerms: text(order.paymentTerms),
    expectedSnapshotSha256: text(paper.approvalSnapshotSha256)
  };
}

function organizationFromGate(state: OrganizationApprovalStateView | undefined): CardOrganization {
  if (!state) return { state: 'missing', eventTime: null, evidence: null };
  const sealed: SealState = state.valid
    ? 'approved'
    : state.revoked
      ? 'revoked'
      : state.pendingEvidenceIdentifier
        ? 'pending_manual_verification'
        : state.manualVerification?.result === 'rejected'
          ? 'rejected'
          : 'missing';
  return { state: sealed, eventTime: null, evidence: null };
}

/** Pure: the card built from the web's own reads (before the server card exists). */
export function cardFromWeb(input: {
  paper: MakerPoViewRow;
  orderCode: string;
  paymentTerms: string | null;
  gate: ApprovalGateView | null;
  sevenPo: SevenPurchaseOrderView | null;
}): ApprovalCardView {
  const { paper, gate } = input;
  const snapshot = paper.snapshot;
  const amountDisplay = snapshot?.amounts?.totalAmount ? formatAmount(snapshot.amounts.currency, snapshot.amounts.totalAmount) : null;
  const address = snapshot?.recipient?.address ?? paper.recipientAddress ?? null;
  const blockers: Array<{ code: string; message: string }> = [];
  if (paper.status !== 'DRAFT') blockers.push({ code: 'MAKER_PO_TRANSITION_BLOCKED', message: 'この発注書は代表承認前の状態ではありません。' });
  if (!input.paymentTerms || input.paymentTerms === 'undetermined') {
    blockers.push({ code: 'PAYMENT_GATE_UNSATISFIED', message: '支払条件が「未定」のため代表承認できません。' });
  }
  if (gate && !gate.dualApproved) blockers.push({ code: 'DUAL_APPROVAL_REQUIRED', message: '顧客とセブン化学の承認がそろっていません。' });
  // A missing amount is a warning (the API only warns): the card asks for an explicit confirmation instead.
  const warnings = amountDisplay ? [] : [{ code: 'MAKER_PO_AMOUNT_MISSING', message: '' }];
  return {
    source: 'web',
    poId: paper.id,
    displayNumber: null,
    status: paper.status,
    orderCode: input.orderCode,
    paymentTerms: input.paymentTerms,
    amountDisplay,
    items: (snapshot?.items ?? []).map((item) => ({
      lineNumber: item.lineNumber,
      description: item.description,
      quantityDisplay: formatQuantityWithUnit(item.orderedQuantity, item.unit)
    })),
    artworkFiles: (snapshot?.specs?.artworkFiles ?? []).map((file) => {
      const design = gate?.designs.find((candidate) => candidate.designKey === file.designKey);
      return {
        designKey: file.designKey,
        revisionNo: file.revisionNo,
        sha256: file.fileSha256,
        filename: null,
        matchesApprovedRevision: design ? design.currentRevisionNo === file.revisionNo && design.fileSha256 === file.fileSha256 : null
      };
    }),
    recipient: { address, isEmail: address ? EMAIL.test(address) : false },
    // P2 R30: the web's own reads carry no dates / order-facts for the card — shown as 「—」.
    deliveryTerms: null,
    sevenPo: input.sevenPo
      ? {
          poNumber: input.sevenPo.poNumberHidden ? null : input.sevenPo.poNumber,
          officialRegisteredAt: input.sevenPo.officialRegisteredAt,
          verificationStatus: input.sevenPo.verificationStatus
        }
      : null,
    designs: (gate?.designs ?? []).map((design) => ({
      designKey: design.designKey,
      revisionNo: design.currentRevisionNo,
      customer: organizationFromGate(design.customer),
      seven: organizationFromGate(design.seven)
    })),
    dualApproved: gate?.dualApproved ?? false,
    blockers,
    warnings,
    canApprove: blockers.length === 0,
    canReturn: paper.status === 'DRAFT',
    expectedPaymentTerms: input.paymentTerms,
    expectedSnapshotSha256: null
  };
}

export async function loadApprovalCard(input: {
  paper: MakerPoViewRow;
  orderId: string;
  orderCode: string;
  paymentTerms: string | null;
  sevenPo: SevenPurchaseOrderView | null;
}): Promise<ApprovalCardView> {
  const server = await callApi<unknown>(`/api/maker-purchase-orders/${encodeURIComponent(input.paper.id)}/approval-card`);
  if (server.ok) {
    const card = cardFromServer(input.paper.id, server.data);
    if (card) {
      return card;
    }
  }
  const [detail, gate] = await Promise.all([
    input.paper.snapshot ? Promise.resolve(null) : loadMakerPoDetail(input.paper.id),
    loadApprovalGate(input.orderId)
  ]);
  const paper = detail?.purchaseOrder ?? input.paper;
  return cardFromWeb({ paper, orderCode: input.orderCode, paymentTerms: input.paymentTerms, gate, sevenPo: input.sevenPo });
}
