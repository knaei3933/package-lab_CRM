'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { FILM_UNITS } from '@kanei/core';
import { refuseIfProjectSwitched, writeProjectOf } from '../lib/project-guard';
import { offsetDateTimeField } from '../lib/datetime';
import { isRouteCode, orderPath } from '../lib/project-route';
import { alreadyAt, answeredOrderStatus, answerId, AUTO_TRANSITION_CODES, autoAdvanceRequest, runChain, uploadedVersionId, withAnswer } from '../lib/step-chain';
import type { ChainStep } from '../lib/step-chain';
import { RECIPIENT_EMAIL_INVALID_MESSAGE } from '../lib/form-messages';
import { isPlainAmount, normalizeAmountText } from '../lib/amount';
import { STEP_REFUSALS } from '../lib/step-messages';
import { DUPLICATE_CODE, duplicateFromAnswer } from '../lib/duplicate-check';
import { deliveryDatesFromForm } from '../lib/delivery-dates';
import { RECIPIENT_CHOICE_INVALID_MESSAGE, RECIPIENT_UNAVAILABLE_CODE, recipientChoiceOf } from '../lib/maker-master';
import { EVIDENCE_NOTE_FIELD } from '../lib/transition-evidence';
import type { ActionState } from '../lib/types';

/**
 * P1 R21–R23: the step panel's actions on the order screen. Each one is one
 * submit for the operator; behind it, the API writes the step needs, in order
 * (lib/step-chain — each write checked by the API on its own, with a derived
 * Idempotency-Key). The document type, issuer and bindings of an evidence file
 * are fixed by the step (R22) — the form posts the file and the facts only.
 *
 * The project is the URL's (the form's rendered project, P1 R20); every action
 * refuses a form without it first (P0 R03, fail closed).
 */

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(formData: FormData, key: string): string | undefined {
  const value = field(formData, key);
  return value.length > 0 ? value : undefined;
}

function flag(formData: FormData, key: string): boolean {
  const value = formData.get(key);
  return value === 'on' || value === 'true';
}

const missing = (message: string): ActionState => ({ ok: false, message });

const id = encodeURIComponent;

const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv', 'message/rfc822'];

interface UploadedFile {
  filename: string;
  contentBase64: string;
  contentType: string;
  mailMessageId: string | null;
  mailDate: string | null;
}

/** The file a StepFileField posted, or why there is none. */
function uploadedFile(formData: FormData): UploadedFile | ActionState {
  const contentBase64 = field(formData, 'contentBase64');
  const filename = field(formData, 'filename');
  const contentType = field(formData, 'contentType');
  if (contentBase64.length === 0 || filename.length === 0) return missing('ファイルを選択してください。');
  if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) return missing('この形式のファイルは登録できません。PDF・PNG・JPEG・メール（.eml）・CSV・テキストを選んでください。');
  return {
    filename,
    contentBase64,
    contentType,
    mailMessageId: optional(formData, 'mailMessageId') ?? null,
    mailDate: optional(formData, 'mailDate') ?? null
  };
}

function isFile(value: UploadedFile | ActionState): value is UploadedFile {
  return 'contentBase64' in value;
}

function guard(formData: FormData): Promise<ActionState | null> {
  return refuseIfProjectSwitched(formData);
}

/** The order screen this form was drawn on (display link after a success; never trusted for a write). */
function orderLink(formData: FormData, label = 'この発注の画面を見る'): ActionState['link'] {
  const projectCode = field(formData, 'projectCode');
  const orderCode = field(formData, 'orderCode');
  return isRouteCode(projectCode) && isRouteCode(orderCode) ? { href: orderPath(projectCode, orderCode), label } : null;
}

// ---------------------------------------------------------------------------
// 1–3 発注書の受付・照合・発注内容 (the new-order wizard: one submit)
// ---------------------------------------------------------------------------

function parseLines(raw: string): Array<{ lineNumber: number; description: string; orderedQuantity: number; unit: string }> | ActionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return missing('明細を読み取れませんでした。もう一度入力してください。');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return missing('明細を1行以上入力してください。');
  const lines: Array<{ lineNumber: number; description: string; orderedQuantity: number; unit: string }> = [];
  for (const entry of parsed) {
    const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    const quantity = Number(typeof row.orderedQuantity === 'string' ? row.orderedQuantity : row.orderedQuantity);
    const unit = typeof row.unit === 'string' ? row.unit : '';
    if (description.length === 0) return missing(`明細${lines.length + 1}の説明を入力してください。`);
    if (!Number.isFinite(quantity) || quantity <= 0) return missing(`明細${lines.length + 1}の数量は正の数で入力してください。`);
    if (!(FILM_UNITS as readonly string[]).includes(unit)) return missing(`明細${lines.length + 1}の単位を選んでください。`);
    lines.push({ lineNumber: lines.length + 1, description, orderedQuantity: quantity, unit });
  }
  return lines;
}

const CHECKLIST_FLAGS = [
  'issuerNameRecorded', 'documentNumberRecorded', 'issueDateRecorded', 'sendingChannelRecorded',
  'pastTransactionCompared', 'quoteCompared', 'confirmationReplyRecorded'
] as const;

export async function startFilmOrderAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await guard(formData);
  if (switched) return switched;
  const projectId = writeProjectOf(formData)!;
  const existingPoId = optional(formData, 'existingPoId');
  // An existing PO whose 照合 is not recorded yet gets it in this submit (the form asks for it).
  const checkExisting = Boolean(existingPoId) && field(formData, 'runChecklist') === 'true';
  const poNumber = field(formData, 'poNumber');
  const registeredAt = field(formData, 'officialRegisteredAt');
  const code = field(formData, 'code');
  const paymentTerms = field(formData, 'paymentTerms');
  if (!existingPoId) {
    if (poNumber.length === 0) return missing('セブン化学発注書の発注番号を入力してください。');
    if (registeredAt.length === 0) return missing('本登録日を入力してください。');
  }
  if (code.length === 0) return missing('発注コードを入力してください。');
  if (!['prepaid', 'on_delivery', 'undetermined'].includes(paymentTerms)) return missing('支払条件を選んでください（前払い・納品後払い・未定）。');
  const lines = parseLines(field(formData, 'lines'));
  if (!Array.isArray(lines)) return lines;
  // P2 R30: the optional 希望納期・納品予定日 go with the order (an empty field is not sent).
  const dates = deliveryDatesFromForm(formData);
  if ('error' in dates) return missing(dates.error);
  const file = field(formData, 'contentBase64') ? uploadedFile(formData) : null;
  if (file && !isFile(file)) return file;

  const checklist: Record<string, unknown> = {
    issuerName: optional(formData, 'issuerName'),
    documentNumber: optional(formData, 'documentNumber'),
    issueDate: optional(formData, 'issueDate'),
    sendingChannel: optional(formData, 'sendingChannel'),
    pastTransactionNote: optional(formData, 'pastTransactionNote'),
    quoteMatchesPo: field(formData, 'quoteMatchesPo') === 'true',
    quoteComparisonNote: optional(formData, 'quoteComparisonNote'),
    tamperHints: optional(formData, 'tamperHints'),
    uncertain: flag(formData, 'uncertain'),
    confirmationReplyNote: optional(formData, 'confirmationReplyNote'),
    verificationNote: optional(formData, 'verificationNote')
  };
  for (const name of CHECKLIST_FLAGS) checklist[name] = flag(formData, name);

  // answers[0] = the created PO (or null when an existing one is used).
  const poIdOf = (answers: readonly unknown[]): string | null => existingPoId ?? answerId(answers[0]);
  const steps: ChainStep[] = [
    {
      label: 'セブン化学発注書の受付',
      request: () => existingPoId ? null : {
        path: `/api/projects/${id(projectId)}/seven-purchase-orders`,
        body: { poNumber, officialRegisteredAt: registeredAt }
      }
    },
    {
      label: '発注書PDFの登録',
      request: (answers) => !file || existingPoId ? null : withAnswer(poIdOf(answers), (poId) => ({
        path: `/api/projects/${id(projectId)}/documents`,
        body: {
          documentType: 'seven_po',
          issuerEntity: 'seven',
          sevenPurchaseOrderId: poId,
          filename: file.filename,
          contentBase64: file.contentBase64,
          contentType: file.contentType
        }
      }))
    },
    {
      label: '発注書の照合',
      request: (answers) => existingPoId && !checkExisting ? null : withAnswer(poIdOf(answers), (poId) => ({
        path: `/api/seven-purchase-orders/${id(poId)}/verification-checklist`,
        body: checklist
      }))
    },
    {
      label: 'フィルム発注の作成',
      request: (answers) => withAnswer(poIdOf(answers), (poId) => ({
        path: `/api/projects/${id(projectId)}/film-supply-orders`,
        body: { code, lines, sevenPurchaseOrderId: poId, paymentTerms, ...dates.body }
      }))
    },
    {
      label: '発注内容の確定',
      // R23 contract: the API may confirm it itself on creation (status in the answer).
      request: (answers) => alreadyAt(answeredOrderStatus(answers[3]), 'SEVEN_PO_VERIFIED') ? null : withAnswer(answerId(answers[3]), (orderId) => ({
        path: `/api/film-supply-orders/${id(orderId)}/transitions`,
        body: { to: 'SEVEN_PO_VERIFIED' }
      }))
    }
  ];
  const projectCode = field(formData, 'projectCode');
  const result = await runChain(formData, steps, {
    success: `フィルム発注 ${code} を作成し、発注内容を確定しました。`,
    // P4 N3: a stop after the PO was registered hands its id back (the wizard re-opens on it).
    partialId: (answers) => (existingPoId ? null : answerId(answers[0])),
    // P4 H7①: a number that is already registered says where (a link to the record), not only 「登録済み」.
    refusal: (refusedCode, index, data) => refusedCode === DUPLICATE_CODE && (index === 0 || index === 3)
      ? duplicateFromAnswer(index === 0 ? 'seven_po' : 'film_order', data, {
        projectId,
        projectCode: isRouteCode(projectCode) ? projectCode : null,
        value: index === 0 ? poNumber : code
      })
      : STEP_REFUSALS(refusedCode)
  });
  // The order's own screen is the next place to work (R21); a refusal stays on the wizard.
  if (result.ok && isRouteCode(projectCode) && isRouteCode(code)) redirect(`${orderPath(projectCode, code)}?started=1`);
  return result;
}

// ---------------------------------------------------------------------------
// 5 校正: the proof file → 版 → 校正準備完了 → 校了確認待ち (one submit)
// ---------------------------------------------------------------------------

export async function submitProofStepAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await guard(formData);
  if (switched) return switched;
  const projectId = writeProjectOf(formData)!;
  const orderId = field(formData, 'orderId');
  const poId = field(formData, 'sevenPurchaseOrderId');
  const designKey = field(formData, 'designKey');
  const status = field(formData, 'currentStatus');
  if (orderId.length === 0) return missing('フィルム発注が見つかりません。');
  if (poId.length === 0) return missing('セブン化学発注書が紐付いていません。発注一覧で確認してください。');
  if (designKey.length === 0) return missing('デザイン名を入力してください（例: 表面A）。');
  const file = uploadedFile(formData);
  if (!isFile(file)) return file;
  const lotMarking = optional(formData, 'lotMarking');
  const steps: ChainStep[] = [
    {
      label: '校正ファイルの登録',
      request: () => ({
        path: `/api/projects/${id(projectId)}/documents`,
        body: {
          documentType: 'proof',
          issuerEntity: 'maker',
          sevenPurchaseOrderId: poId,
          filmSupplyOrderId: orderId,
          designKey,
          filename: file.filename,
          contentBase64: file.contentBase64,
          contentType: file.contentType
        }
      })
    },
    {
      label: '版の登録',
      request: (answers) => withAnswer(uploadedVersionId(answers[0]), (versionId) => ({
        path: `/api/film-supply-orders/${id(orderId)}/artwork-revisions`,
        body: lotMarking ? { designKey, fileDocumentVersionId: versionId, lotMarking } : { designKey, fileDocumentVersionId: versionId }
      }))
    },
    {
      label: '校正準備完了',
      // R23 contract: the 版 registration advances the order itself (answer status); the
      // manual move is then skipped, and a refusal AUTO_TRANSITION_ONLY becomes auto-advance.
      request: (answers) => status === 'ARTWORK_RECEIVED' && !alreadyAt(answeredOrderStatus(answers[1]), 'PROOF_READY')
        ? { path: `/api/film-supply-orders/${id(orderId)}/transitions`, body: { to: 'PROOF_READY' } }
        : null,
      fallback: { codes: AUTO_TRANSITION_CODES, request: () => autoAdvanceRequest(orderId, projectId) }
    },
    {
      label: '校了確認待ちへ',
      request: (answers) => (status === 'ARTWORK_RECEIVED' || status === 'PROOF_READY')
        && !alreadyAt(answeredOrderStatus(answers[1]), 'APPROVAL_PENDING')
        && !alreadyAt(answeredOrderStatus(answers[2]), 'APPROVAL_PENDING')
        ? { path: `/api/film-supply-orders/${id(orderId)}/transitions`, body: { to: 'APPROVAL_PENDING' } }
        : null,
      fallback: { codes: AUTO_TRANSITION_CODES, request: () => autoAdvanceRequest(orderId, projectId) }
    }
  ];
  return runChain(formData, steps, {
    success: `校正（${designKey}）を登録し、校了の確認待ちにしました。次は顧客とセブン化学の承認です。`,
    link: orderLink(formData, '次: 6 校了（承認の記録）'),
    refusal: STEP_REFUSALS
  });
}

// ---------------------------------------------------------------------------
// 6 校了: one organization's approval mail → evidence → approval (one submit)
// ---------------------------------------------------------------------------

const ORGANIZATION_ISSUER: Readonly<Record<string, string>> = {
  customer: 'customer_generated',
  seven: 'seven'
};

export async function recordApprovalStepAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await guard(formData);
  if (switched) return switched;
  const projectId = writeProjectOf(formData)!;
  const orderId = field(formData, 'orderId');
  const poId = field(formData, 'sevenPurchaseOrderId');
  const revisionId = field(formData, 'revisionId');
  const designKey = field(formData, 'designKey');
  const organization = field(formData, 'organization');
  const issuer = ORGANIZATION_ISSUER[organization];
  if (!issuer) return missing('承認組織が不正です。');
  if (orderId.length === 0 || revisionId.length === 0 || designKey.length === 0) return missing('承認する版が見つかりません。画面を再読み込みしてください。');
  if (poId.length === 0) return missing('セブン化学発注書が紐付いていません。発注一覧で確認してください。');
  const file = uploadedFile(formData);
  if (!isFile(file)) return file;
  const isMail = file.contentType === 'message/rfc822';
  // The identifier of the approval: the mail's own Message-ID, else the one typed for a PDF/image.
  const identifier = (isMail ? file.mailMessageId : null) ?? optional(formData, 'evidenceIdentifier') ?? '';
  if (identifier.length < 8) {
    return missing(isMail
      ? 'このメールから Message-ID を読み取れませんでした。承認メールの原本（.eml）を選んでください。'
      : '承認証跡識別子を8文字以上で入力してください（書類の番号や押印欄の記載など）。');
  }
  const eventTime = (isMail ? file.mailDate : null) ?? optional(formData, 'eventTime') ?? new Date().toISOString();
  // The 押印 slot fixes the issuer: a セブン化学 slot only takes a paper セブン化学 issued (B2, P-1).
  const steps: ChainStep[] = [
    {
      label: '承認証跡の登録',
      request: () => ({
        path: `/api/projects/${id(projectId)}/documents`,
        body: {
          documentType: 'approval_evidence',
          issuerEntity: issuer,
          sevenPurchaseOrderId: poId,
          filmSupplyOrderId: orderId,
          designKey,
          filename: file.filename,
          contentBase64: file.contentBase64,
          contentType: file.contentType
        }
      })
    },
    {
      label: '承認の記録',
      request: (answers) => withAnswer(uploadedVersionId(answers[0]), (versionId) => ({
        path: `/api/artwork-revisions/${id(revisionId)}/approvals`,
        body: {
          organization,
          decision: 'APPROVE',
          evidenceDocumentVersionId: versionId,
          evidenceIdentifier: identifier,
          evidenceSource: isMail ? 'email' : 'signed_document',
          eventTime,
          ...(optional(formData, 'approverName') ? { externalApproverName: optional(formData, 'approverName') } : {})
        }
      }))
    }
  ];
  const name = organization === 'customer' ? '顧客' : 'セブン化学';
  return runChain(formData, steps, {
    success: isMail
      ? `${name}の承認を記録しました（メールの識別子は原本で確認されます）。`
      : `${name}の承認を記録しました。PDF・画像の証跡は代表の確認を待ちます。`,
    refusal: STEP_REFUSALS
  });
}

// ---------------------------------------------------------------------------
// 7 メーカー発注書 (representative): メーカー発注準備完了 → the paper (one submit)
// ---------------------------------------------------------------------------

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(value);
}

export async function createMakerPoStepAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await guard(formData);
  if (switched) return switched;
  const orderId = field(formData, 'orderId');
  const currency = field(formData, 'currency') || 'JPY';
  const totalAmount = normalizeAmountText(field(formData, 'totalAmount'));
  if (orderId.length === 0) return missing('フィルム発注が見つかりません。');
  // P2 R33: a master address (its id only) or the typed address (checked as an e-mail) — never both.
  const recipient = recipientChoiceOf(formData);
  if (recipient.kind === 'bad_id') return missing(RECIPIENT_CHOICE_INVALID_MESSAGE);
  if (recipient.kind === 'typed' && !isEmail(recipient.recipientAddress)) return missing(RECIPIENT_EMAIL_INVALID_MESSAGE);
  const recipientBody = recipient.kind === 'id'
    ? { recipientAddressId: recipient.recipientAddressId }
    : { recipientAddress: recipient.recipientAddress };
  // R24: the amount is required — the representative never approves a paper without one.
  // The amount is optional (the API only warns; the approval card asks the representative to
  // confirm a paper without one). When typed it must be a plain number.
  if (totalAmount.length > 0 && !isPlainAmount(totalAmount)) return missing('金額は数字で入力してください（例 480000）。');
  const needsReady = field(formData, 'needsReadyTransition') === 'true';
  const steps: ChainStep[] = [
    {
      label: 'メーカー発注準備完了',
      request: () => needsReady
        ? { path: `/api/film-supply-orders/${id(orderId)}/transitions`, body: { to: 'MAKER_PO_READY' } }
        : null,
      // R23 contract: DUAL_APPROVED + decided 支払条件 advances by itself; a manual move is refused.
      fallback: { codes: AUTO_TRANSITION_CODES, request: () => autoAdvanceRequest(orderId, writeProjectOf(formData)) }
    },
    {
      label: 'メーカー発注書の作成',
      request: () => ({
        path: `/api/film-supply-orders/${id(orderId)}/maker-purchase-orders`,
        body: totalAmount.length > 0 ? { ...recipientBody, amounts: { currency, totalAmount } } : recipientBody
      })
    }
  ];
  const result = await runChain(formData, steps, {
    success: 'メーカー発注書（下書き）を作成しました。代表の承認を待ちます。',
    refusal: STEP_REFUSALS
  });
  // P2 R33: the chosen address is gone — the screen is read again so the list is current.
  if (!result.ok && result.code === RECIPIENT_UNAVAILABLE_CODE) revalidatePath('/', 'layout');
  return result;
}

// ---------------------------------------------------------------------------
// 4 デザイン入稿: the design data file (bound to the order) → デザイン受領 (one submit)
// ---------------------------------------------------------------------------

/** P2 R22: the memo is what records the receipt when there is no file. */
const ARTWORK_NOTE_REQUIRED = 'ファイルがないときは、受け取ったデザインのメモを入力してください（例: 11/20 に顧客からメールで受領）。';

/**
 * P2 R22 (contract §6, DESIGN §9): the customer's design data is registered as
 * 「デザイン入稿データ」 (documentType artwork_submission) bound to this order —
 * the API attaches the order's own セブン化学発注書 (none is sent) — and the order
 * moves to デザイン受領, in one submit. 「ファイルがなく、受領だけを記録する」 keeps
 * the P1 way: the move with the memo only.
 */
export async function submitArtworkStepAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await guard(formData);
  if (switched) return switched;
  const projectId = writeProjectOf(formData)!;
  const orderId = field(formData, 'orderId');
  if (orderId.length === 0) return missing('フィルム発注が見つかりません。');
  const note = optional(formData, EVIDENCE_NOTE_FIELD);
  const designKey = optional(formData, 'designKey');
  const hasFile = field(formData, 'contentBase64').length > 0;
  if (!hasFile && !flag(formData, 'noFile')) return missing('ファイルを選択してください。');
  if (!hasFile && !note) return missing(ARTWORK_NOTE_REQUIRED);
  const file = hasFile ? uploadedFile(formData) : null;
  if (file && !isFile(file)) return file;
  const upload = file as UploadedFile | null;
  const steps: ChainStep[] = [
    {
      label: 'デザイン入稿データの登録',
      request: () => upload ? {
        path: `/api/projects/${id(projectId)}/documents`,
        body: {
          documentType: 'artwork_submission',
          issuerEntity: 'customer_generated',
          filmSupplyOrderId: orderId,
          ...(designKey ? { designKey } : {}),
          filename: upload.filename,
          contentBase64: upload.contentBase64,
          contentType: upload.contentType
        }
      } : null
    },
    {
      label: 'デザイン受領',
      request: () => ({
        path: `/api/film-supply-orders/${id(orderId)}/transitions`,
        body: note ? { to: 'ARTWORK_RECEIVED', evidenceNote: note } : { to: 'ARTWORK_RECEIVED' }
      })
    }
  ];
  return runChain(formData, steps, {
    success: upload
      ? `デザイン入稿データ（${upload.filename}）を登録し、デザイン受領にしました。`
      : 'デザインの受領を記録しました（ファイルなし・メモは履歴に残ります）。',
    link: orderLink(formData, '次: 5 校正の登録'),
    refusal: STEP_REFUSALS
  });
}

// ---------------------------------------------------------------------------
// 10 メーカー受注確認: acceptance evidence → 仮 (staff) / 確認 → 最終 (representative)
// ---------------------------------------------------------------------------

export async function recordAcceptanceStepAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await guard(formData);
  if (switched) return switched;
  const projectId = writeProjectOf(formData)!;
  const orderId = field(formData, 'orderId');
  const makerPoId = field(formData, 'poId');
  const poId = field(formData, 'sevenPurchaseOrderId');
  const final = field(formData, 'mode') === 'final';
  const existingVersionId = optional(formData, 'evidenceDocumentVersionId');
  const existingDocumentId = optional(formData, 'evidenceDocumentId');
  const existingVerified = field(formData, 'evidenceVerified') === 'true';
  if (orderId.length === 0 || makerPoId.length === 0) return missing('メーカー発注書が見つかりません。');
  const file = existingVersionId ? null : uploadedFile(formData);
  if (file && !isFile(file)) return file;
  if (!existingVersionId && !file) return missing('メーカーの受注確認（受領証跡）のファイルを選択してください。');
  const upload = file as UploadedFile | null;
  const versionOf = (answers: readonly unknown[]): string | null => existingVersionId ?? uploadedVersionId(answers[0]);
  const documentOf = (answers: readonly unknown[]): string | null => {
    if (existingDocumentId) return existingDocumentId;
    const answer = answers[0] as { document?: { id?: unknown } } | null;
    return typeof answer?.document?.id === 'string' ? answer.document.id : null;
  };
  const steps: ChainStep[] = [
    {
      label: '受領証跡の登録',
      request: () => upload ? {
        path: `/api/projects/${id(projectId)}/documents`,
        body: {
          documentType: 'acceptance_evidence',
          issuerEntity: 'maker',
          sevenPurchaseOrderId: poId || undefined,
          filmSupplyOrderId: orderId,
          makerPurchaseOrderId: makerPoId,
          filename: upload.filename,
          contentBase64: upload.contentBase64,
          contentType: upload.contentType
        }
      } : null
    },
    {
      label: '受入記録（仮）',
      request: () => final ? null : { path: `/api/maker-purchase-orders/${id(makerPoId)}/provisional-acceptance`, body: {} }
    },
    {
      // P-4 (1-person operation): the representative may confirm the evidence they
      // uploaded themself; the API records who and when. Staff keep the existing rule.
      label: '受領証跡の確認',
      request: (answers) => !final || existingVerified ? null : withAnswer(documentOf(answers), (documentId) => ({
        path: `/api/documents/${id(documentId)}/verify`,
        body: { verificationStatus: 'verified' }
      }))
    },
    {
      label: '最終受入の記録',
      request: (answers) => !final ? null : withAnswer(versionOf(answers), (versionId) => ({
        path: `/api/maker-purchase-orders/${id(makerPoId)}/accept-evidence`,
        body: { evidenceDocumentVersionId: versionId }
      }))
    }
  ];
  return runChain(formData, steps, {
    success: final
      ? 'メーカーの受注を確定しました（最終受入）。次は製造開始の記録です。'
      : '受入記録（仮）を残しました。代表の最終確認を待ちます。',
    refusal: STEP_REFUSALS
  });
}

// ---------------------------------------------------------------------------
// 12 納品: every line's delivered quantity → 納品済み (one submit)
// ---------------------------------------------------------------------------

export async function recordDeliveryStepAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await guard(formData);
  if (switched) return switched;
  const orderId = field(formData, 'orderId');
  if (orderId.length === 0) return missing('フィルム発注が見つかりません。');
  const lineIds = formData.getAll('lineId').filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (lineIds.length === 0) return missing('納品する明細がありません。');
  // P4 N15: the date + time inputs post an explicit-offset value (with the wall-clock fallback).
  const deliveredAt = offsetDateTimeField(formData, 'deliveredAt') || optional(formData, 'deliveredAt');
  const deliveries: Array<{ lineId: string; unit: string; quantity: number }> = [];
  for (const [index, lineId] of lineIds.entries()) {
    const raw = field(formData, `quantity_${lineId}`).replace(/[,，\s]/g, '').replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
    const quantity = Number(raw);
    if (raw.length === 0 || !Number.isFinite(quantity) || quantity <= 0) return missing(`明細${index + 1}の納品数量は正の数で入力してください。`);
    deliveries.push({ lineId, unit: field(formData, `unit_${lineId}`), quantity });
  }
  const steps: ChainStep[] = [
    ...deliveries.map((delivery, index): ChainStep => ({
      label: `明細${index + 1}の納品`,
      request: () => ({
        path: `/api/film-supply-orders/${id(orderId)}/deliveries`,
        body: {
          filmSupplyOrderLineId: delivery.lineId,
          unit: delivery.unit,
          deliveredQuantity: delivery.quantity,
          ...(deliveredAt ? { deliveredAt } : {})
        }
      })
    })),
    {
      label: '納品済み',
      request: () => ({ path: `/api/film-supply-orders/${id(orderId)}/transitions`, body: { to: 'FILM_DELIVERED' } })
    }
  ];
  return runChain(formData, steps, {
    success: '納品を記録しました。最後に受け取りの確認をします。',
    refusal: STEP_REFUSALS
  });
}
