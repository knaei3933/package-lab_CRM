import {
  APPROVAL_EVIDENCE_SOURCES,
  DOCUMENT_TYPES,
  FILM_UNITS,
  FILLING_UNITS,
  ISSUER_ENTITIES
} from '@kanei/core';
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
  acceptance_evidence: '受領証跡（検収）'
};

export const ISSUER_ENTITY_LABELS: Readonly<Record<IssuerEntity, string>> = {
  seven: 'セブン化学',
  kanei: 'カネイ',
  maker: '製造先',
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
  'text/csv'
] as const;

export const CONTENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF文書',
  'image/png': 'PNG画像',
  'image/jpeg': 'JPEG画像',
  'text/plain': 'テキスト（TXT）',
  'text/csv': 'CSVファイル'
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

export const APPROVAL_DECISION_LABELS: Readonly<Record<string, string>> = {
  APPROVE: '承認',
  REVOKE: '取消'
};

/** The five readiness blockers of @kanei/core, in operator wording. */
export const READINESS_BLOCKING_LABELS: Readonly<Record<string, string>> = {
  FILM_DELIVERY_NOT_RECORDED: 'フィルム納品がまだ記録されていません',
  FILLING_DELIVERY_NOT_RECORDED: '充填製品納品がまだ記録されていません',
  SEVEN_PO_NOT_OFFICIALLY_REGISTERED: 'セブン化学発注書の公式登録がありません',
  FILM_DELIVERY_PENDING_CONFIRMATION: 'フィルム納品の確認（受領証跡の確認）が未完了です',
  FILLING_DELIVERY_PENDING_CONFIRMATION: '充填製品納品の確認（受領証跡の確認）が未完了です'
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

const JP_DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
};

/** Renders an API timestamp as a short Japanese datetime (or a dash). */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', JP_DATETIME_OPTIONS).format(date);
}
