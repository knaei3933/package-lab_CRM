'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { FILM_UNITS, FILLING_UNITS, OFFICIAL_ARTIFACT_DOCUMENT_TYPES } from '@kanei/core';
import { callApi, PROJECT_COOKIE, readSelectedProjectId } from '../lib/api';
import { offsetDateTimeField } from '../lib/datetime';
import { ARTWORK_REVISION_LIVE_PAPER_REFUSAL } from '../lib/maker-po-data';
import type { ActionState } from '../lib/types';
import { unitLabel } from '../lib/vocabulary';

/**
 * M6 operator UI server actions: thin forms-over-API adapters. Each action
 * reads the form, posts to the existing apps/api endpoint with the operator's
 * session cookie, and reports the API's own Japanese message back to the
 * screen. Nothing here re-implements a rule the API already enforces; the UI
 * only passes data through and refreshes the list after a write.
 */

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function flag(formData: FormData, key: string): boolean {
  const value = formData.get(key);
  return value === 'on' || value === 'true';
}

function optionalField(formData: FormData, key: string): string | undefined {
  const value = field(formData, key);
  return value.length > 0 ? value : undefined;
}

function numberField(formData: FormData, key: string): number | null {
  const raw = field(formData, key);
  if (raw.length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const dateTimeField = offsetDateTimeField;

async function requireProjectId(): Promise<string | ActionState> {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return { ok: false, message: '案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。' };
  }
  return projectId;
}

function isProjectId(value: string | ActionState): value is string {
  return typeof value === 'string';
}

function refresh(): void {
  revalidatePath('/', 'layout');
}

/**
 * Recheck 7 Low-7 (c): API refusals whose message is not Japanese (the hold
 * reason checks answer in Korean) are shown in operator Japanese, by code.
 * Recheck 8 Low-5: the live-paper artwork block answers 「受入まで完了して
 * ください」, but accepted paper is live too and keeps the block — the
 * operator is told the one way out the API takes.
 */
function localizedRefusal(code: string | null): ActionState | null {
  switch (code) {
    case 'HOLD_REASON_REQUIRED':
      return { ok: false, message: '保留にする理由は必須です。' };
    case 'HOLD_REASON_TOO_LONG':
      return { ok: false, message: '保留にする理由は1000字以内で入力してください。' };
    case 'MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED':
      return { ok: false, message: ARTWORK_REVISION_LIVE_PAPER_REFUSAL };
    default:
      return null;
  }
}

function apiCode(data: unknown): string | null {
  return typeof data === 'object' && data !== null && typeof (data as { code?: unknown }).code === 'string'
    ? (data as { code: string }).code
    : null;
}

/**
 * UI batch E2: DELIVERY_UNIT_MISMATCH (server db4bd88, 422) answers
 * 「納品単位は明細単位（sheets）と一致させてください」 with the line's unit code in
 * the brackets. The operator reads both units in Japanese and the one fix; when
 * the bracket cannot be read, the same fix without the unit names.
 */
function deliveryUnitMismatchRefusal(data: unknown, submittedUnit: string): ActionState {
  const raw = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
    ? (data as { error: string }).error
    : '';
  const lineUnit = /（([^（）]+)）/.exec(raw)?.[1]?.trim();
  const units = lineUnit
    ? `納品単位（${unitLabel(submittedUnit)}）が明細の単位（${unitLabel(lineUnit)}）と異なります。`
    : '納品単位が明細の単位と異なります。';
  // The fixed tail is what lib/form-messages maps to the 単位 field.
  return { ok: false, message: `${units}単位を明細と同じ単位に直して、もう一度記録してください。` };
}

async function post(
  path: string,
  body: unknown,
  refusal?: (code: string | null, data: unknown) => ActionState | null
): Promise<ActionState> {
  const result = await callApi(path, { method: 'POST', body });
  if (result.ok) {
    return { ok: true, message: '記録しました。' };
  }
  const specific = refusal?.(apiCode(result.data), result.data);
  if (specific) return specific;
  const localized = localizedRefusal(apiCode(result.data));
  if (localized) return localized;
  return { ok: false, message: result.error ?? `APIがステータス ${result.status} を返しました。` };
}

function parseLines(raw: string, units: readonly string[], label: string):
  { ok: true; lines: Array<{ lineNumber: number; description: string; orderedQuantity: number; unit: string }> }
  | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: `${label}の明細データを読み取れませんでした。もう一度入力してください。` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, message: `${label}の明細を1行以上入力してください。` };
  }
  const lines: Array<{ lineNumber: number; description: string; orderedQuantity: number; unit: string }> = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, message: `${label}の明細の形式が不正です。` };
    }
    const row = entry as Record<string, unknown>;
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    const quantity = typeof row.orderedQuantity === 'string' ? Number(row.orderedQuantity) : row.orderedQuantity;
    const unit = typeof row.unit === 'string' ? row.unit : '';
    if (description.length === 0) {
      return { ok: false, message: `${label}の明細の説明が入力されていません。` };
    }
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, message: `${label}の明細の数量は正の数で入力してください。` };
    }
    if (!units.includes(unit)) {
      return { ok: false, message: `${label}の明細の単位が正しくありません。` };
    }
    lines.push({ lineNumber: lines.length + 1, description, orderedQuantity: quantity, unit });
  }
  return { ok: true, lines };
}

// ---------------------------------------------------------------------------
// Project selection (web-local convenience; the API stays project-scoped).
// ---------------------------------------------------------------------------

export async function selectProjectAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  // M8-UI3: the selector is a dropdown of the projects the operator may open.
  // The direct-input field stays for a project that is not in the list; the
  // dropdown wins when both are filled, so the recorded choice is never
  // ambiguous.
  const projectId = field(formData, 'projectId') || field(formData, 'directProjectId');
  if (projectId.length === 0) {
    return { ok: false, message: '案件を選択するか、案件IDを入力してください。' };
  }
  const result = await callApi<{ code: string; name: string }>(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!result.ok || !result.data) {
    return { ok: false, message: result.error ?? `案件が取得できませんでした（${result.status}）。` };
  }
  const store = await cookies();
  store.set(PROJECT_COOKIE, projectId, { path: '/', httpOnly: true, sameSite: 'lax' });
  refresh();
  return { ok: true, message: `案件 ${result.data.code}（${result.data.name}）を選択しました。` };
}

// ---------------------------------------------------------------------------
// Seven purchase orders (M2): intake, official registration, checklist.
// ---------------------------------------------------------------------------

export async function createSevenPurchaseOrderAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const projectId = await requireProjectId();
  if (!isProjectId(projectId)) return projectId;
  const poNumber = field(formData, 'poNumber');
  if (poNumber.length === 0) return { ok: false, message: '発注番号を入力してください。' };
  const body: Record<string, unknown> = { poNumber };
  const registeredAt = field(formData, 'officialRegisteredAt');
  // Date and time inputs are passed through as entered: the API parses them on
  // the same host, so the operator's wall-clock value is what gets recorded.
  if (registeredAt.length > 0) body.officialRegisteredAt = registeredAt;
  return post(`/api/projects/${encodeURIComponent(projectId)}/seven-purchase-orders`, body);
}

export async function registerSevenPurchaseOrderAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const poId = field(formData, 'poId');
  const registeredAt = field(formData, 'officialRegisteredAt');
  if (poId.length === 0) return { ok: false, message: 'セブン発注書が選択されていません。' };
  if (registeredAt.length === 0) return { ok: false, message: '公式登録日を入力してください。' };
  return post(`/api/seven-purchase-orders/${encodeURIComponent(poId)}/register-official`, {
    officialRegisteredAt: registeredAt
  });
}

export async function verifySevenPurchaseOrderAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const poId = field(formData, 'poId');
  if (poId.length === 0) return { ok: false, message: 'セブン発注書が選択されていません。' };
  const body: Record<string, unknown> = {
    issuerNameRecorded: flag(formData, 'issuerNameRecorded'),
    issuerName: optionalField(formData, 'issuerName'),
    documentNumberRecorded: flag(formData, 'documentNumberRecorded'),
    documentNumber: optionalField(formData, 'documentNumber'),
    issueDateRecorded: flag(formData, 'issueDateRecorded'),
    issueDate: optionalField(formData, 'issueDate'),
    sendingChannelRecorded: flag(formData, 'sendingChannelRecorded'),
    sendingChannel: optionalField(formData, 'sendingChannel'),
    pastTransactionCompared: flag(formData, 'pastTransactionCompared'),
    pastTransactionNote: optionalField(formData, 'pastTransactionNote'),
    quoteCompared: flag(formData, 'quoteCompared'),
    quoteMatchesPo: field(formData, 'quoteMatchesPo') === 'true',
    quoteComparisonNote: optionalField(formData, 'quoteComparisonNote'),
    tamperHints: optionalField(formData, 'tamperHints'),
    uncertain: flag(formData, 'uncertain'),
    confirmationReplyRecorded: flag(formData, 'confirmationReplyRecorded'),
    confirmationReplyNote: optionalField(formData, 'confirmationReplyNote'),
    verificationNote: optionalField(formData, 'verificationNote')
  };
  return post(`/api/seven-purchase-orders/${encodeURIComponent(poId)}/verification-checklist`, body);
}

// ---------------------------------------------------------------------------
// Film / filling supply orders (M1) and their lifecycle transitions.
// ---------------------------------------------------------------------------

export async function createFilmSupplyOrderAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const projectId = await requireProjectId();
  if (!isProjectId(projectId)) return projectId;
  const code = field(formData, 'code');
  if (code.length === 0) return { ok: false, message: '発注コードを入力してください。' };
  const lines = parseLines(field(formData, 'lines'), FILM_UNITS, 'フィルム発注');
  if (!lines.ok) return { ok: false, message: lines.message };
  const body: Record<string, unknown> = { code, lines: lines.lines };
  // UI batch E (F-05): a film order without its PO can never leave DRAFT and the
  // link cannot be added later, so the screen requires it (the API still decides).
  const sevenPurchaseOrderId = optionalField(formData, 'sevenPurchaseOrderId');
  if (!sevenPurchaseOrderId) return { ok: false, message: 'セブン化学発注書を選択してください。' };
  body.sevenPurchaseOrderId = sevenPurchaseOrderId;
  // M8-OPER2 FIX 1: the G6 transaction terms are chosen at creation. Omitted
  // means the API's default (undetermined — the term that keeps G6 closed).
  const paymentTerms = field(formData, 'paymentTerms');
  if (paymentTerms.length > 0) body.paymentTerms = paymentTerms;
  return post(`/api/projects/${encodeURIComponent(projectId)}/film-supply-orders`, body);
}

/**
 * M8-OPER2 FIX 1: the G6 transaction terms recorded from the /orders screen.
 * The API allows the write only while the order is a DRAFT and reports its own
 * refusal otherwise. Recording a term is never an 入金確認: the payment
 * confirmation is a separate manual step with no writer today.
 */
export async function updateFilmPaymentTermsAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const paymentTerms = field(formData, 'paymentTerms');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が選択されていません。' };
  if (!['prepaid', 'on_delivery', 'undetermined'].includes(paymentTerms)) {
    return { ok: false, message: '決済条件（prepaid／on_delivery／undetermined）を選択してください。' };
  }
  const result = await callApi(`/api/film-supply-orders/${encodeURIComponent(orderId)}/payment-terms`, {
    method: 'PATCH',
    body: { paymentTerms }
  });
  refresh();
  if (result.ok) {
    return { ok: true, message: `決済条件を記録しました（${paymentTerms}）。記録は入金確認ではありません。` };
  }
  return { ok: false, message: result.error ?? `APIがステータス ${result.status} を返しました。` };
}

/**
 * M8-OPER2 FIX 2: the representative's manual verification of a pending
 * evidence identifier (binary PDF/image approval evidence). Posts the NEW
 * append-only verification event; the API refuses every role but admin and
 * refuses any approval that is not actually waiting for this check.
 */
export async function verifyEvidenceManualAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const approvalEventId = field(formData, 'approvalEventId');
  const result = field(formData, 'result');
  const verifierName = field(formData, 'verifierName');
  const verifiedAt = dateTimeField(formData, 'verifiedAt');
  const reasonNote = field(formData, 'reasonNote');
  if (approvalEventId.length === 0) return { ok: false, message: '確認対象の承認イベントが見つかりません。' };
  if (result !== 'confirmed' && result !== 'rejected') {
    return { ok: false, message: '検証結果（確認／却下）を選択してください。' };
  }
  if (verifierName.length === 0) return { ok: false, message: '検証者名を入力してください。' };
  if (verifiedAt.length === 0) return { ok: false, message: '検証日時を入力してください。' };
  if (reasonNote.length === 0) {
    return { ok: false, message: '根拠を入力してください（原本証跡のどこで識別子を確認したか）。' };
  }
  return post(`/api/artwork-approval-events/${encodeURIComponent(approvalEventId)}/verification`, {
    result,
    verifierName,
    verifiedAt,
    reasonNote
  });
}

export async function createFillingOrderAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const projectId = await requireProjectId();
  if (!isProjectId(projectId)) return projectId;
  const code = field(formData, 'code');
  if (code.length === 0) return { ok: false, message: '発注コードを入力してください。' };
  const lines = parseLines(field(formData, 'lines'), FILLING_UNITS, '充填発注');
  if (!lines.ok) return { ok: false, message: lines.message };
  return post(`/api/projects/${encodeURIComponent(projectId)}/filling-orders`, { code, lines: lines.lines });
}

export async function transitionFilmSupplyOrderAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const to = field(formData, 'to');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が選択されていません。' };
  if (to.length === 0) return { ok: false, message: '遷移先の状態を選択してください。' };
  // The API requires a reason to put an order on hold (HOLD_REASON_REQUIRED);
  // the other targets take none, so the field is sent only for ON_HOLD.
  if (to === 'ON_HOLD') {
    const holdReason = reasonField(formData, 'holdReason', '保留にする理由');
    // The literal (not the reasonField template) so the form can map it to its field.
    if (!holdReason.ok) return { ok: false, message: '保留にする理由は必須です。' };
    return post(`/api/film-supply-orders/${encodeURIComponent(orderId)}/transitions`, { to, holdReason: holdReason.text });
  }
  return post(`/api/film-supply-orders/${encodeURIComponent(orderId)}/transitions`, { to });
}

/**
 * A required reason. Only emptiness is checked here: the API counts its
 * 1000-character limit after its own normalisation (control characters and
 * runs of spaces removed), so a length rule here could refuse a reason the API
 * accepts. An over-long reason gets the API's own message, shown verbatim.
 */
function reasonField(
  formData: FormData,
  key: string,
  label: string
): { ok: true; text: string } | { ok: false; state: ActionState } {
  const text = field(formData, key);
  if (text.length === 0) return { ok: false, state: { ok: false, message: `${label}は必須です。` } };
  return { ok: true, text };
}

/**
 * Hold release (admin only, reason required). The API resumes the order in
 * the state it left — read from its own hold audit row. resumeStatus is sent
 * only when the operator picked one, which the form offers for a legacy hold
 * whose origin is not on record (the API answers HOLD_ORIGIN_UNKNOWN without
 * it, and refuses any value that differs from a recorded origin).
 */
export async function releaseFilmOrderHoldAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が選択されていません。' };
  const reason = reasonField(formData, 'reason', '保留解除の理由');
  if (!reason.ok) return reason.state;
  const resumeStatus = optionalField(formData, 'resumeStatus');
  return post(`/api/film-supply-orders/${encodeURIComponent(orderId)}/hold-release`, {
    reason: reason.text,
    ...(resumeStatus ? { resumeStatus } : {})
  });
}

/**
 * Cancellation review resolution (admin only, reason required): resume (the
 * API returns the order to the state it left) or cancel (取消終了, terminal).
 */
export async function resolveCancellationReviewAction(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const outcome = field(formData, 'outcome');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が選択されていません。' };
  if (outcome !== 'resume' && outcome !== 'cancel') {
    return { ok: false, message: '処理（再開する／取消で終了する）を選択してください。' };
  }
  const reason = reasonField(formData, 'reason', '取消レビューの処理理由');
  if (!reason.ok) return reason.state;
  // Legacy review without a recorded origin: the resume target the operator picked (resume only).
  const resumeStatus = outcome === 'resume' ? optionalField(formData, 'resumeStatus') : undefined;
  return post(`/api/film-supply-orders/${encodeURIComponent(orderId)}/cancellation-review-resolve`, {
    outcome,
    reason: reason.text,
    ...(resumeStatus ? { resumeStatus } : {})
  });
}

export async function assumeFilmReceiptAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const note = field(formData, 'note');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が選択されていません。' };
  if (note.length === 0) return { ok: false, message: '受領確認のメモは必須です。' };
  if (!flag(formData, 'acknowledgeNoEvidence')) {
    return { ok: false, message: '「証跡なしで問題なしとみなす」の確認にチェックを入れてください。' };
  }
  return post(`/api/film-supply-orders/${encodeURIComponent(orderId)}/receipt-assumption`, {
    note,
    acknowledgeNoEvidence: true
  });
}

// ---------------------------------------------------------------------------
// Documents (M2/M3/M4): intake and human verification.
// ---------------------------------------------------------------------------

/** UI batch E (F-07): the document types the API registers only with a verified PO link. */
const PO_REQUIRED_DOCUMENT_TYPES: readonly string[] = OFFICIAL_ARTIFACT_DOCUMENT_TYPES;

export async function uploadDocumentAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const projectId = await requireProjectId();
  if (!isProjectId(projectId)) return projectId;
  const filename = field(formData, 'filename');
  const contentBase64 = field(formData, 'contentBase64');
  if (filename.length === 0) return { ok: false, message: 'ファイル名を入力してください。' };
  if (contentBase64.length === 0) return { ok: false, message: 'ファイルを選択してください。' };
  const body: Record<string, unknown> = {
    documentType: field(formData, 'documentType'),
    issuerEntity: field(formData, 'issuerEntity'),
    filename,
    contentBase64,
    // JSON uploads carry the declared MIME type: the API checks it against its
    // allow-list (application/pdf, image/png, image/jpeg, text/plain, text/csv)
    // before anything is persisted.
    contentType: field(formData, 'contentType')
  };
  const sevenPurchaseOrderId = optionalField(formData, 'sevenPurchaseOrderId');
  // UI batch E (F-07): the API refuses an official artifact without a verified
  // PO link (SEVEN_PO_REQUIRED); say so on the field before the upload is sent.
  if (!sevenPurchaseOrderId && PO_REQUIRED_DOCUMENT_TYPES.includes(String(body.documentType))) {
    return { ok: false, message: 'セブン化学発注書を選択してください（校正ゲラ・各種証跡では必須です）。' };
  }
  if (sevenPurchaseOrderId) body.sevenPurchaseOrderId = sevenPurchaseOrderId;
  const filmSupplyOrderId = optionalField(formData, 'filmSupplyOrderId');
  if (filmSupplyOrderId) body.filmSupplyOrderId = filmSupplyOrderId;
  const makerPurchaseOrderId = optionalField(formData, 'makerPurchaseOrderId');
  if (makerPurchaseOrderId) body.makerPurchaseOrderId = makerPurchaseOrderId;
  const designKey = optionalField(formData, 'designKey');
  if (designKey) body.designKey = designKey;
  const note = optionalField(formData, 'note');
  if (note) body.note = note;
  return post(`/api/projects/${encodeURIComponent(projectId)}/documents`, body);
}

export async function verifyDocumentAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const documentId = field(formData, 'documentId');
  const verificationStatus = field(formData, 'verificationStatus');
  if (documentId.length === 0) return { ok: false, message: '書類が選択されていません。' };
  if (verificationStatus !== 'verified' && verificationStatus !== 'mismatch') {
    return { ok: false, message: '検証結果（確認済み／相違あり）を選択してください。' };
  }
  const body: Record<string, unknown> = { verificationStatus };
  const verificationNote = optionalField(formData, 'verificationNote');
  if (verificationNote) body.verificationNote = verificationNote;
  return post(`/api/documents/${encodeURIComponent(documentId)}/verify`, body);
}

// ---------------------------------------------------------------------------
// Artwork revisions and the dual approval (M3).
// ---------------------------------------------------------------------------

export async function registerArtworkRevisionAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const designKey = field(formData, 'designKey');
  const fileDocumentVersionId = field(formData, 'fileDocumentVersionId');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注を選択してください。' };
  if (designKey.length === 0) return { ok: false, message: 'デザインキーを入力してください。' };
  if (fileDocumentVersionId.length === 0) return { ok: false, message: '版ファイル（校正ゲラのバージョン）を選択してください。' };
  const body: Record<string, unknown> = { designKey, fileDocumentVersionId };
  const lotMarking = optionalField(formData, 'lotMarking');
  if (lotMarking) body.lotMarking = lotMarking;
  const note = optionalField(formData, 'note');
  if (note) body.note = note;
  return post(`/api/film-supply-orders/${encodeURIComponent(orderId)}/artwork-revisions`, body);
}

export async function recordArtworkApprovalAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const revisionId = field(formData, 'revisionId');
  const organization = field(formData, 'organization');
  const evidenceDocumentVersionId = field(formData, 'evidenceDocumentVersionId');
  const evidenceIdentifier = field(formData, 'evidenceIdentifier');
  const evidenceSource = field(formData, 'evidenceSource');
  const eventTime = dateTimeField(formData, 'eventTime');
  if (revisionId.length === 0) return { ok: false, message: '校了対象の版が見つかりません。' };
  if (organization !== 'customer' && organization !== 'seven') {
    return { ok: false, message: '承認組織（顧客／セブン化学）を選んでください。' };
  }
  if (evidenceDocumentVersionId.length === 0) {
    return { ok: false, message: '承認証跡の書類バージョンを選択してください。' };
  }
  // M7 security fix S2: the identifier says which approval message or signature
  // block this decision rests on, per organization.
  if (evidenceIdentifier.trim().length < 8) {
    return { ok: false, message: '承認証跡識別子を8文字以上で入力してください（例：メールのMessage-ID）。' };
  }
  if (evidenceSource.length === 0) return { ok: false, message: '証跡の入手経路を選択してください。' };
  if (eventTime.length === 0) return { ok: false, message: '承認日時を入力してください。' };
  const body: Record<string, unknown> = {
    organization,
    decision: 'APPROVE',
    evidenceDocumentVersionId,
    evidenceIdentifier: evidenceIdentifier.trim(),
    evidenceSource,
    eventTime
  };
  const externalApproverName = optionalField(formData, 'approverName') ?? optionalField(formData, 'externalApproverName');
  if (externalApproverName) body.externalApproverName = externalApproverName;
  const externalApproverOrg = optionalField(formData, 'externalApproverOrg');
  if (externalApproverOrg) body.externalApproverOrg = externalApproverOrg;
  const supersedesEventId = optionalField(formData, 'supersedesEventId');
  if (supersedesEventId) body.supersedesEventId = supersedesEventId;
  return post(`/api/artwork-revisions/${encodeURIComponent(revisionId)}/approvals`, body);
}

// ---------------------------------------------------------------------------
// Deliveries, delivery confirmation and commission readiness (M5).
// ---------------------------------------------------------------------------

export async function recordDeliveryAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const kind = field(formData, 'kind');
  const orderId = field(formData, 'orderId');
  const lineId = field(formData, 'lineId');
  const unit = field(formData, 'unit');
  const quantity = numberField(formData, 'deliveredQuantity');
  if (kind !== 'film' && kind !== 'filling') return { ok: false, message: '納品種別が不正です。' };
  if (orderId.length === 0) return { ok: false, message: '発注を選択してください。' };
  if (lineId.length === 0) return { ok: false, message: '納品する明細を選択してください。' };
  if (quantity === null || quantity <= 0) return { ok: false, message: '納品数量は正の数で入力してください。' };
  const body: Record<string, unknown> = {
    [kind === 'film' ? 'filmSupplyOrderLineId' : 'fillingOrderLineId']: lineId,
    unit,
    deliveredQuantity: quantity
  };
  const deliveredAt = dateTimeField(formData, 'deliveredAt');
  if (deliveredAt.length > 0) body.deliveredAt = deliveredAt;
  const carrierReference = optionalField(formData, 'carrierReference');
  if (carrierReference) body.carrierReference = carrierReference;
  const note = optionalField(formData, 'note');
  if (note) body.note = note;
  const path = kind === 'film'
    ? `/api/film-supply-orders/${encodeURIComponent(orderId)}/deliveries`
    : `/api/filling-orders/${encodeURIComponent(orderId)}/deliveries`;
  return post(path, body, (code, data) =>
    code === 'DELIVERY_UNIT_MISMATCH' ? deliveryUnitMismatchRefusal(data, unit) : null);
}

export async function confirmDeliveryAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const kind = field(formData, 'kind');
  const deliveryId = field(formData, 'deliveryId');
  const evidenceDocumentVersionId = field(formData, 'evidenceDocumentVersionId');
  if (kind !== 'film' && kind !== 'filling') return { ok: false, message: '納品種別が不正です。' };
  if (deliveryId.length === 0) return { ok: false, message: '納品行が見つかりません。' };
  if (evidenceDocumentVersionId.length === 0) {
    return { ok: false, message: '確認に使う受領証跡（確認済みの書類バージョン）を選択してください。' };
  }
  const body: Record<string, unknown> = { evidenceDocumentVersionId };
  const note = optionalField(formData, 'note');
  if (note) body.note = note;
  const path = kind === 'film'
    ? `/api/film-deliveries/${encodeURIComponent(deliveryId)}/confirmation`
    : `/api/filling-deliveries/${encodeURIComponent(deliveryId)}/confirmation`;
  return post(path, body);
}

export async function evaluateCommissionReadinessAction(_prev: ActionState | null, _formData: FormData): Promise<ActionState> {
  const projectId = await requireProjectId();
  if (!isProjectId(projectId)) return projectId;
  const result = await callApi<{
    readinessState: string;
    isReady: boolean;
    blocking: string[];
    commissionCalculationAllowed: boolean;
  }>(`/api/projects/${encodeURIComponent(projectId)}/commission-readiness`, { method: 'POST', body: {} });
  refresh();
  if (!result.ok || !result.data) {
    return { ok: false, message: result.error ?? `手数料準備状態の評価が失敗しました（${result.status}）。` };
  }
  return {
    ok: true,
    message: result.data.isReady
      ? '準備状態：手数料計算可能です。'
      : `準備状態：${result.data.readinessState}（未達の要件があります）。`
  };
}
