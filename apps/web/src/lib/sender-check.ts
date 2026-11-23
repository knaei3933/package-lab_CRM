import { webErrorText } from './error-dictionary';

/**
 * P4 N4: the sender check of an approval-evidence mail (p4-server REPORT §2-4/§2-5). The server compares
 * the mail's From domain with the registered account's domain and only WARNS — it never refuses, and
 * the approval counts as before. The web shows the warning, the file name, the From address and who
 * uploaded it, so the person who confirms the evidence sees what the 「✓一致」 never said: the issuer
 * is what the person registering it declared (発行元（登録時の申告）), not something read from the file.
 */
/**
 * 「✓一致」 only says the slot the file was put in is the organization's: the issuer is what the person who
 * registered the evidence declared, not something read from the file. The label says so.
 */
export const ISSUER_DECLARED_LABEL = '発行元（登録時の申告）';

export const SENDER_WARNING_CODES: readonly string[] = ['EVIDENCE_SENDER_DOMAIN_MISMATCH', 'EVIDENCE_SENDER_UNVERIFIABLE'];

export interface SenderWarning {
  code: string;
  ja: string;
  ko: string | null;
}

export type SenderCheckStatus = 'not_email' | 'from_missing' | 'multiple_from' | 'no_registered_domain' | 'match' | 'mismatch';

const STATUSES: readonly string[] = ['not_email', 'from_missing', 'multiple_from', 'no_registered_domain', 'match', 'mismatch'];

/** What the status says in one short phrase (null: nothing to add — a match or not a mail). */
const STATUS_TEXT: Readonly<Partial<Record<SenderCheckStatus, { ja: string; ko: string }>>> = {
  from_missing: { ja: '差出人（From）がありません', ko: '발신자(From)가 없습니다' },
  multiple_from: { ja: '差出人（From）が複数あります', ko: '발신자(From)가 여러 개입니다' },
  mismatch: { ja: '差出人のドメインが登録と違います', ko: '발신자 도메인이 등록과 다릅니다' },
  no_registered_domain: { ja: '取引先のメールアドレスが未登録で、差出人を照合できません', ko: '거래처 메일 주소가 미등록이라 발신자를 대조할 수 없습니다' }
};

export function senderStatusOf(value: unknown): SenderCheckStatus | null {
  const status = typeof value === 'object' && value !== null ? (value as { status?: unknown }).status : value;
  return typeof status === 'string' && STATUSES.includes(status) ? (status as SenderCheckStatus) : null;
}

export function senderStatusText(status: SenderCheckStatus | null): { ja: string; ko: string } | null {
  return status ? STATUS_TEXT[status] ?? null : null;
}

/** Pure: the warnings array of an answer (approval record, queue item) in the dictionary's words. */
export function senderWarningsOf(value: unknown): SenderWarning[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SenderWarning[] = [];
  for (const entry of value) {
    const code = typeof entry === 'object' && entry !== null ? (entry as { code?: unknown }).code : null;
    if (typeof code !== 'string' || !SENDER_WARNING_CODES.includes(code) || seen.has(code)) continue;
    seen.add(code);
    const text = webErrorText(code);
    out.push({ code, ja: text.message, ko: text.messageKo ?? null });
  }
  return out;
}

/** The sentence added to the 「承認を記録しました」 line when the server warned about the sender. */
export function senderWarningSentence(warnings: readonly SenderWarning[]): string {
  return warnings.length === 0 ? '' : ` ⚠ ${warnings.map((warning) => warning.ja).join(' ')}`;
}

// ---------------------------------------------------------------------------
// p4/web4: the server's evidence lines — one parser and one fallback for every screen that draws them
// (the approval card's 押印欄 and the step-6 manual check both read them here).
// ---------------------------------------------------------------------------

export type EvidenceTone = 'ok' | 'warning' | 'neutral';

/** P4 server2 §1(4)/§13: one line the server decided (code, tone, Japanese label) — drawn as given. */
export interface EvidenceLine {
  code: string;
  tone: EvidenceTone;
  label: string;
}

const TONES: readonly string[] = ['ok', 'warning', 'neutral'];
/**
 * The only codes the server gives the 「ok」 tone (core `approvalEvidenceDeclarationLine` /
 * `evidenceSenderVerdict`): 「申告どおり」 is said only when the declared issuer is the approving organization
 * AND the mail's From domain matched. A line that claims ok under any other code is not drawn.
 */
const OK_CODES: readonly string[] = ['declared_and_sender_match', 'match'];
/** A server label is plain text of bounded length (never markup; drawn as a React text node). */
const LINE_LABEL_MAX = 200;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pure: a server-decided line ({ code, tone, label }), or null when it is missing or malformed. */
export function evidenceLineFrom(value: unknown): EvidenceLine | null {
  const record = recordOf(value);
  if (!record) return null;
  const code = textOf(record.code);
  const tone = textOf(record.tone);
  const label = textOf(record.label);
  if (!code || !tone || !TONES.includes(tone) || !label) return null;
  if (tone === 'ok' && !OK_CODES.includes(code)) return null;
  return { code, tone: tone as EvidenceTone, label: label.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LINE_LABEL_MAX) };
}

/**
 * The line drawn beside 「発行元（登録時の申告）」 / 「照合」. The server's own line when it answered one; on an
 * older API only what the declaration itself says — never 「申告どおり」, which the server says only when the
 * mail's From domain was compared too (web2b review M-1).
 */
export function declarationLineOf(
  evidence: { declarationLine?: EvidenceLine | null | undefined; issuerMatchesOrganization?: boolean | null | undefined } | null | undefined
): EvidenceLine | null {
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
