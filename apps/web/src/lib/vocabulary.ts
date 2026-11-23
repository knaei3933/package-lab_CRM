import {
  APPROVAL_EVIDENCE_SOURCES,
  DOCUMENT_TYPES,
  FILM_UNITS,
  FILLING_UNITS,
  ISSUER_ENTITIES
} from '@kanei/core';
import { formatAmount } from './number-format';
import type {
  ApprovalEvidenceSource,
  DocumentType,
  FilmUnit,
  FillingUnit,
  IssuerEntity
} from '@kanei/core';

/**
 * M6 operator UI vocabulary. The Japanese status labels of the flow come from
 * the API surface (GET /api/status-labels) and are never re-spelled here — the
 * same rule as the M5 status page. The maps below cover only the vocabularies
 * the surface does not serve (document types, issuers, units, evidence
 * sources); the state keys themselves are imported from @kanei/core so a
 * vocabulary change fails to compile instead of silently breaking the UI.
 */

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  seven_po: 'セブン化学発注書',
  filling_quote_seven: 'セブン化学見積書',
  film_quote_kanei: 'カネイ見積書',
  proof: '校正ゲラ',
  approval_evidence: '承認証跡',
  send_evidence: '送信証跡',
  acceptance_evidence: '受領証跡（検収）',
  // P2 R22 (server document type 0030).
  artwork_submission: 'デザイン入稿データ'
};

export const ISSUER_ENTITY_LABELS: Readonly<Record<IssuerEntity, string>> = {
  seven: 'セブン化学',
  kanei: 'カネイ',
  maker: 'メーカー',
  customer_generated: '顧客作成',
  unknown: '不明'
};

export const FILM_UNIT_LABELS: Readonly<Record<FilmUnit, string>> = {
  rolls: 'ロール',
  meters: 'メートル',
  sheets: '枚'
};

export const FILLING_UNIT_LABELS: Readonly<Record<FillingUnit, string>> = {
  pods: 'ポッド',
  pieces: '個'
};

export const EVIDENCE_SOURCE_LABELS: Readonly<Record<ApprovalEvidenceSource, string>> = {
  email: 'メール',
  signed_document: '署名済み書類',
  other_verified: 'その他（確認済み）'
};

/**
 * The content types the API accepts for an upload (apps/api document-storage).
 * A JSON upload has to declare one of them, so the 文書 screen asks for it.
 */
export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/csv',
  // M8-HARDEN FIX C1 の受け入れ形式（apps/api document-storage）と同じ並び。
  // 送信証跡（send_evidence）は送信済みメールの原本 .eml である必要があるため、
  // 文書画面もこの形式を受け付ける。
  'message/rfc822'
] as const;

export const CONTENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF文書',
  'image/png': 'PNG画像',
  'image/jpeg': 'JPEG画像',
  'text/plain': 'テキスト（TXT）',
  'text/csv': 'CSVファイル',
  'message/rfc822': 'メール原文（EML）'
};

export function contentTypeChoices(): Array<{ value: string; label: string }> {
  return ALLOWED_CONTENT_TYPES.map((value) => ({
    value,
    label: `${CONTENT_TYPE_LABELS[value] ?? value}（${value}）`
  }));
}

export const VERIFICATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  unverified: '未検証',
  verified: '確認済み',
  mismatch: '相違あり'
};

/**
 * maker_po_events.verificationStatus の日本語（大文字キーは API の列挙値そのまま）。
 * PENDING_MANUAL_VERIFICATION は代表者の「手動確認」を待っている送信イベントで、
 * この画面から POST /api/maker-po-events/:id/send-manual-verification で確定させる。
 */
export const MAKER_PO_EVENT_VERIFICATION_LABELS: Readonly<Record<string, string>> = {
  VERIFIED: '自動検証済み（内容確認ずみ）',
  PENDING_MANUAL_VERIFICATION: '手動確認待ち（代表者の確認が必要）',
  UNVERIFIED: '未検証'
};

/** POST …/send-manual-verification の result 値（@kanei/core と同じ値）。 */
export const MAKER_PO_MANUAL_VERIFICATION_RESULTS = ['confirmed', 'rejected'] as const;

export const MAKER_PO_MANUAL_VERIFICATION_RESULT_LABELS: Readonly<Record<string, string>> = {
  confirmed: '確認（送信を確定する）',
  rejected: '却下（送信を確定しない）'
};

export const APPROVAL_DECISION_LABELS: Readonly<Record<string, string>> = {
  APPROVE: '承認',
  REVOKE: '取消'
};

/** The five readiness blockers of @kanei/core, in operator wording. */
export const READINESS_BLOCKING_LABELS: Readonly<Record<string, string>> = {
  FILM_DELIVERY_NOT_RECORDED: 'フィルム納品がまだ記録されていません',
  FILLING_DELIVERY_NOT_RECORDED: '充填製品納品がまだ記録されていません',
  SEVEN_PO_NOT_OFFICIALLY_REGISTERED: 'セブン化学発注書の本登録がありません',
  FILM_DELIVERY_PENDING_CONFIRMATION: 'フィルム納品の確認（受領証跡の確認）が未完了です',
  FILLING_DELIVERY_PENDING_CONFIRMATION: '充填製品納品の確認（受領証跡の確認）が未完了です',
  // P1 P-3 (API_CONTRACT §5-1): film-only projects are judged on every order's delivered quantity.
  FILM_ORDER_NOT_DELIVERED: '納品が記録されていないフィルム発注があります',
  FILM_DELIVERY_QUANTITY_INCOMPLETE: '発注数量に届いていない（一部だけ納品の）フィルム発注があります'
};

export function unitLabel(unit: string): string {
  const filmLabels = FILM_UNIT_LABELS as Readonly<Record<string, string>>;
  const fillingLabels = FILLING_UNIT_LABELS as Readonly<Record<string, string>>;
  return filmLabels[unit] ?? fillingLabels[unit] ?? unit;
}

export function unitChoices(domain: 'film' | 'filling'): Array<{ value: string; label: string }> {
  const units = domain === 'film' ? FILM_UNITS : FILLING_UNITS;
  const labels: Record<string, string> = domain === 'film'
    ? { ...FILM_UNIT_LABELS }
    : { ...FILLING_UNIT_LABELS };
  return units.map((unit) => ({
    value: unit,
    label: labels[unit] ?? unit
  }));
}

export function documentTypeChoices(): Array<{ value: string; label: string }> {
  return DOCUMENT_TYPES.map((value) => ({ value, label: DOCUMENT_TYPE_LABELS[value] }));
}

export function issuerEntityChoices(): Array<{ value: string; label: string }> {
  return ISSUER_ENTITIES.map((value) => ({ value, label: ISSUER_ENTITY_LABELS[value] }));
}

export function evidenceSourceChoices(): Array<{ value: string; label: string }> {
  return APPROVAL_EVIDENCE_SOURCES.map((value) => ({ value, label: EVIDENCE_SOURCE_LABELS[value] }));
}

/**
 * UI batch A (P1-5): every displayed timestamp is rendered in Japan time with
 * an explicit 「JST」 suffix, independent of the server process TZ. A UTC host
 * (the planned NAS) would otherwise shift every list and history 9 hours.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Tokyo';

const JP_DATETIME_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

const JP_DATE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/**
 * UI batch E (F-15): a value recorded from a date-only field (本登録日). The
 * form posts YYYY-MM-DD, which is stored as midnight UTC — 09:00 JST, a time
 * nobody entered. Such an instant (midnight UTC or midnight JST) reads as the
 * date alone; any other instant keeps its JST time.
 */
export function formatDateOrTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const utcMidnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  const jstMidnight = date.getUTCHours() === 15 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return utcMidnight || jstMidnight ? JP_DATE_FORMAT.format(date) : formatTimestamp(value);
}

/** Renders an API timestamp as a short Japanese datetime in JST (or a dash). */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${JP_DATETIME_FORMAT.format(date)} JST`;
}

const JP_DATETIME_SECONDS_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

/**
 * P4 M10①: a send / approval time to the second (「2026/11/23 09:10:49 JST」). The send
 * proof compares them strictly (core eml.ts, 0 s tolerance), so a minute-only time could
 * hide why a send waits for the representative.
 */
export function formatTimestampSeconds(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${JP_DATETIME_SECONDS_FORMAT.format(date)} JST`;
}

/**
 * P4 M10①: 「送信は代表承認の30秒前」 — the signed gap between two instants in words, or null
 * when one of them is missing. Whole seconds (the stored times carry milliseconds).
 */
export function sendApprovalGapText(sentAt: unknown, approvedAt: unknown): string | null {
  if (typeof sentAt !== 'string' || typeof approvedAt !== 'string') return null;
  const sent = Date.parse(sentAt);
  const approved = Date.parse(approvedAt);
  if (Number.isNaN(sent) || Number.isNaN(approved)) return null;
  const seconds = Math.round((sent - approved) / 1000);
  if (seconds === 0) return '送信は代表承認と同じ秒';
  const size = Math.abs(seconds);
  const amount = size < 60 ? `${size}秒` : size < 3600 ? `${Math.floor(size / 60)}分${size % 60 ? `${size % 60}秒` : ''}` : `${Math.floor(size / 3600)}時間${Math.floor((size % 3600) / 60)}分`;
  return seconds < 0 ? `送信は代表承認の${amount}前` : `送信は代表承認の${amount}後`;
}

/**
 * An amount as people write it. P4 N15: one formatter for every screen — lib/number-format
 * `formatAmount`; this keeps the older name and shows 「—」 for an empty amount.
 */
export function formatMoney(currency: string | null | undefined, amount: string | null | undefined): string {
  const raw = (amount ?? '').trim();
  if (raw.length === 0) return '—';
  // A value that is not a plain non-negative decimal is shown as recorded (never reinterpreted, review L8).
  if (!/^\d+(\.\d+)?$/.test(raw)) return raw;
  return formatAmount(currency, raw);
}
