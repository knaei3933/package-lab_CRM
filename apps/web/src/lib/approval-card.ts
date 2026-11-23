import { callApi } from './api';
import { loadMakerPoDetail } from './maker-po-data';
import type { MakerPoViewRow } from './maker-po-data';
import { loadApprovalGate } from './project-data';
import type { ApprovalGateView, OrganizationApprovalStateView, SevenPurchaseOrderView } from './project-data';
import { formatAmount, formatQuantityWithUnit } from './number-format';
import { orderAmountDisplay, orderFactsFromApi } from './order-terms';
import { senderStatusOf, senderWarningsOf } from './sender-check';
import type { SenderCheckStatus, SenderWarning } from './sender-check';

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

export type EvidenceTone = 'ok' | 'warning' | 'neutral';

/** P4 server2 §1(4): one line the server decided (code, tone, Japanese label) — drawn as given. */
export interface EvidenceLine {
  code: string;
  tone: EvidenceTone;
  label: string;
}

export interface CardOrganization {
  state: SealState;
  eventTime: string | null;
  /** p4/web3 (server2 §9): the approval event the slot rests on — part of the evidence set the approval is pinned to. */
  approvalEventId?: string | null | undefined;
  evidence: {
    filename: string | null;
    issuerEntity: string | null;
    expectedIssuerEntity: string | null;
    issuerMatchesOrganization: boolean | null;
    evidenceSource: string | null;
    identifierStatus: string | null;
    /** p4/web3 (server2 §1(4)): the evidence version, who uploaded it and the mail's From (null: not answered). */
    documentVersionId?: string | null | undefined;
    uploadedBy?: string | null | undefined;
    uploadedAt?: string | null | undefined;
    fromAddress?: string | null | undefined;
    senderStatus?: SenderCheckStatus | null | undefined;
    /** The server's sender verdict and the line beside 「発行元（登録時の申告）」; null on an older API. */
    senderVerdict?: EvidenceLine | null | undefined;
    declarationLine?: EvidenceLine | null | undefined;
    warnings?: SenderWarning[] | undefined;
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
  /** P4 H4①: the film order's id (the 希望納期 is recorded on the order). Null when the card did not carry it. */
  orderId?: string | null | undefined;
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
  /** p4/web3: why the last approval from this card stopped (a short-lived notice; lib/approval-notice). */
  notice?: ApprovalNotice | null | undefined;
}

/** p4/web3: the reason a 代表承認 from this card stopped, kept across the redraw (lib/approval-notice). */
export type ApprovalNoticeReason = 'evidence_changed' | 'content_changed' | 'amount_required' | 'delivery_date_required';

export interface ApprovalNotice {
  poId: string;
  reason: ApprovalNoticeReason;
  /** When it stopped (ISO). */
  at: string;
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

const TONES: readonly string[] = ['ok', 'warning', 'neutral'];
/** A server label is plain text of bounded length (never markup; drawn as a React text node). */
const LINE_LABEL_MAX = 200;

/** Pure: a server-decided line ({ code, tone, label }), or null when it is missing or malformed. */
export function evidenceLineFrom(value: unknown): EvidenceLine | null {
  if (!isRecord(value)) return null;
  const code = text(value.code);
  const tone = text(value.tone);
  const label = text(value.label);
  if (!code || !tone || !TONES.includes(tone) || !label) return null;
  return { code, tone: tone as EvidenceTone, label: label.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LINE_LABEL_MAX) };
}

/**
 * p4/web3: the line drawn beside 「発行元（登録時の申告）」. The server's own line when the card carries it
 * (server2 §1(4)); on an older API only what the declaration itself says — never 「申告どおり」, which the
 * server says only when the mail's From domain was compared too (web2b review M-1).
 */
export function declarationLineOf(evidence: CardOrganization['evidence']): EvidenceLine | null {
  if (!evidence) return null;
  if (evidence.declarationLine) return evidence.declarationLine;
  if (evidence.issuerMatchesOrganization === false) {
    return { code: 'issuer_differs', tone: 'warning', label: '申告された発行元が承認組織と異なります' };
  }
  if (evidence.issuerMatchesOrganization === true) {
    return { code: 'declared_only', tone: 'neutral', label: '申告は承認組織と一致（差出人は照合していません）' };
  }
  return null;
}

function organizationFromServer(value: unknown): CardOrganization {
  const record = isRecord(value) ? value : {};
  const evidence = isRecord(record.evidence) ? record.evidence : null;
  const state = text(record.state) as SealState | null;
  return {
    state: state ?? 'missing',
    eventTime: text(record.eventTime),
    ...(text(record.approvalEventId) ? { approvalEventId: text(record.approvalEventId) } : {}),
    evidence: evidence
      ? {
          filename: text(evidence.filename),
          issuerEntity: text(evidence.issuerEntity),
          expectedIssuerEntity: text(evidence.expectedIssuerEntity),
          issuerMatchesOrganization: typeof evidence.issuerMatchesOrganization === 'boolean' ? evidence.issuerMatchesOrganization : null,
          evidenceSource: text(evidence.evidenceSource),
          identifierStatus: text(evidence.identifierStatus),
          documentVersionId: text(evidence.documentVersionId),
          uploadedBy: isRecord(evidence.uploadedBy) ? text(evidence.uploadedBy.displayName) : null,
          uploadedAt: text(evidence.uploadedAt),
          fromAddress: text(evidence.fromAddress),
          senderStatus: senderStatusOf(evidence.senderDomainCheck),
          senderVerdict: evidenceLineFrom(evidence.senderVerdict),
          declarationLine: evidenceLineFrom(evidence.declarationLine),
          warnings: senderWarningsOf(evidence.warnings)
        }
      : null
  };
}

/**
 * p4/web3 (server2 §9, web review (b)): the approval-evidence set the card was drawn with — per design and
 * organization the approval event and its evidence version, in a fixed order. The server pins the approval
 * to the same set (its hash; 409 MAKER_PO_SNAPSHOT_CHANGED when it moved); the web only compares this stamp
 * with a fresh card to say WHY the approval stopped. Null when the card carries no event ids (older API, web card).
 */
export function approvalEvidenceStamp(card: Pick<ApprovalCardView, 'source' | 'designs'>): string | null {
  if (card.source !== 'server') return null;
  const parts: string[] = [];
  let anyEvent = false;
  for (const design of card.designs) {
    for (const [organization, slot] of [['customer', design.customer], ['seven', design.seven]] as const) {
      if (slot.approvalEventId) anyEvent = true;
      parts.push([design.designKey, organization, slot.approvalEventId ?? '', slot.evidence?.documentVersionId ?? ''].join(':'));
    }
  }
  return anyEvent ? parts.sort().join('|') : null;
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
    orderId: text(order.id),
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
  orderId?: string | null | undefined;
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
    orderId: input.orderId ?? null,
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

/** p4/web3 (b): the server's answer when the paper or its approval-evidence set moved after the card was drawn (409). */
export const SNAPSHOT_CHANGED_CODE = 'MAKER_PO_SNAPSHOT_CHANGED';

/** P4 H4① (server rule): a 代表承認 needs both facts; the API answers a blocker with these codes. */
export const AMOUNT_REQUIRED_CODE = 'AMOUNT_REQUIRED';
export const DELIVERY_DATE_REQUIRED_CODE = 'DELIVERY_DATE_REQUIRED';

export interface ApprovalCardNeeds {
  /** 金額 is not on the paper: the representative types it on the card (no way to approve without it). */
  amount: boolean;
  /** 希望納期 is not on the order: it is recorded first, then the card is read again (it is part of the frozen paper). */
  requestedDeliveryDate: boolean;
  /** Blockers that are not one of the two inputs above (shown as 「承認できません」). */
  otherBlockers: Array<{ code: string; message: string }>;
  /** The approve form is shown: nothing but the amount (typed in the form itself) stands in the way. */
  canSubmitApproval: boolean;
}

/**
 * P4 H4①: what the card still needs from the representative. The old 「金額未入力のまま承認する」
 * check is gone — a missing amount or 希望納期 is something to enter, not something to accept.
 * Pure; the API decides the approval itself (422 AMOUNT_REQUIRED / DELIVERY_DATE_REQUIRED).
 */
export function approvalCardNeeds(card: Pick<ApprovalCardView, 'blockers' | 'amountDisplay' | 'status' | 'canApprove' | 'expectedPaymentTerms'>): ApprovalCardNeeds {
  const amount = card.blockers.some((blocker) => blocker.code === AMOUNT_REQUIRED_CODE) || card.amountDisplay === null;
  const requestedDeliveryDate = card.blockers.some((blocker) => blocker.code === DELIVERY_DATE_REQUIRED_CODE);
  const otherBlockers = card.blockers.filter((blocker) => blocker.code !== AMOUNT_REQUIRED_CODE && blocker.code !== DELIVERY_DATE_REQUIRED_CODE);
  const canSubmitApproval = card.status === 'DRAFT'
    && otherBlockers.length === 0
    && !requestedDeliveryDate
    && card.expectedPaymentTerms !== null
    && (card.canApprove || amount);
  return { amount, requestedDeliveryDate, otherBlockers, canSubmitApproval };
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
  return cardFromWeb({ paper, orderCode: input.orderCode, orderId: input.orderId, paymentTerms: input.paymentTerms, gate, sevenPo: input.sevenPo });
}
