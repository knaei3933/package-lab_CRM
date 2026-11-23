import { parseEml } from './eml.js';

/**
 * P4 N4, as amended by the 2026-11-23 decision N4(b) (docs/reports/CEO_DECISIONS):
 * a mail whose From domain differs from the organization's registered one is
 * never refused, but it no longer counts on its own either — like a PDF it waits
 * for the representative's manual check (senderDomainRequiresManualVerification).
 * Every other result stays a display / warning only. The step
 * slot an approval is recorded in decides its issuing organization (顧客 /
 * セブン化学), so the card's 「✓一致」 says "slot = organization", not "the file
 * came from that organization". For an EML evidence the server compares the
 * domain of the mail's own From header with the domain of the organization's
 * registered contact address (accounts.contact_email) and reports the result.
 *
 * Next to the staff approval-evidence choice contract (one of the four
 * representative-confirmed rules): its fields and its refusals are unchanged —
 * this only adds a warning. Turning a mismatch into a refusal is a
 * representative decision.
 */
export type EvidenceSenderDomainStatus =
  /** Not an email (PDF, image, plain note): nothing to compare. */
  | 'not_email'
  /**
   * An email whose From cannot be compared: no From address, or a domain that
   * is not plain ASCII (an IDN / homograph such as a Cyrillic "а" is reported
   * here, never silently compared). Shown as EVIDENCE_SENDER_UNVERIFIABLE.
   */
  | 'from_missing'
  /** P4 review L-1: more than one From header or address — which one sent it is ambiguous. */
  | 'multiple_from'
  /** The organization has no registered contact address to compare with. */
  | 'no_registered_domain'
  /** Round 2 (H-1): exactly the registered domain (lower case, trailing root dot dropped). A subdomain is a mismatch. */
  | 'match'
  /** Another domain: never a refusal; held for the representative's manual check (N4(b)). */
  | 'mismatch';

export interface EvidenceSenderDomainCheck {
  status: EvidenceSenderDomainStatus;
  fromAddress: string | null;
  fromDomain: string | null;
  registeredDomain: string | null;
}

export const EVIDENCE_SENDER_UNVERIFIABLE_MESSAGE =
  '承認証跡メールの差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）。発行元を確かめてから確認してください';

/** The warning (never a refusal) a check result asks the screen to show, or null. */
export function evidenceSenderDomainWarning(check: EvidenceSenderDomainCheck | null | undefined):
  | { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH' | 'EVIDENCE_SENDER_UNVERIFIABLE'; message: string; fromDomain: string | null; registeredDomain: string | null }
  | null {
  if (!check) return null;
  if (check.status === 'mismatch') {
    return { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: EVIDENCE_SENDER_DOMAIN_MISMATCH_MESSAGE, fromDomain: check.fromDomain, registeredDomain: check.registeredDomain };
  }
  if (check.status === 'from_missing' || check.status === 'multiple_from') {
    return { code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: EVIDENCE_SENDER_UNVERIFIABLE_MESSAGE, fromDomain: check.fromDomain, registeredDomain: check.registeredDomain };
  }
  return null;
}

export const EVIDENCE_SENDER_DOMAIN_MISMATCH_MESSAGE =
  '承認証跡メールの差出人のドメインが、発行元として登録されている取引先のドメインと一致しません。発行元を確かめてから確認してください';

/**
 * N4(b) (2026-11-23): the reason an approval whose mail came from another domain
 * waits in the representative's manual-check queue.
 */
export const EVIDENCE_SENDER_DOMAIN_MANUAL_CHECK_REASON = '差出人のドメインが登録先と違います';

/**
 * N4(b) round 2 (2026-11-23, p5-int review H-1): the reason a mail whose sender
 * cannot be read (no From, several, an unreadable domain, a broken header) waits
 * for the representative's check — a different sentence from the mismatch one.
 */
export const EVIDENCE_SENDER_UNVERIFIABLE_MANUAL_CHECK_REASON = '差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）';

/**
 * Round 3 (p5-int review2 H-R2-1): the reason an approval evidence that is not a
 * readable mail (a text body, a quoted / forwarded copy, a PDF, an image) waits
 * for the representative's check when the organization has a registered contact.
 */
export const EVIDENCE_NOT_A_MAIL_MANUAL_CHECK_REASON = 'メールとして確認できないため、代表の確認が必要です';

/**
 * N4(b) (2026-11-23) as an ALLOWLIST — round 2 (p5-int review H-1) and round 3
 * (review2 H-R2-1, conductor decision). When the issuing organization has a
 * registered contact address, an approval evidence counts by itself ONLY when it
 * is a readable mail whose one From address's normalized domain (lower case, a
 * trailing root dot dropped) is EXACTLY the registered domain (`match`).
 * Everything else waits for the representative's manual check (fail closed):
 * another domain, a subdomain, no / several / unreadable From, and — since round
 * 3 — evidence that is not a mail at all (`not_email`: a .txt body or a quoted
 * copy, a PDF, an image). The identifier substring rule therefore never counts
 * an approval of such an organization. Not a refusal. Without a registered
 * address the old meaning stays (warning / neutral, counted as before).
 * Next to the staff approval-evidence choice contract: its fields and refusals
 * are unchanged — only the counting condition is.
 */
export function senderDomainRequiresManualVerification(check: EvidenceSenderDomainCheck | null | undefined): boolean {
  if (!check || check.status === 'no_registered_domain') return false;
  if (check.registeredDomain === null) return false;
  return check.status !== 'match';
}

/** N4(b): the one-line reason a held evidence shows in the queue and on the check (null when it is not held). */
export function senderManualCheckReason(check: EvidenceSenderDomainCheck | null | undefined):
  | { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH' | 'EVIDENCE_SENDER_UNVERIFIABLE' | 'EVIDENCE_NOT_A_MAIL'; message: string }
  | null {
  if (!senderDomainRequiresManualVerification(check)) return null;
  if (check!.status === 'not_email') return { code: 'EVIDENCE_NOT_A_MAIL', message: EVIDENCE_NOT_A_MAIL_MANUAL_CHECK_REASON };
  return check!.status === 'mismatch'
    ? { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: EVIDENCE_SENDER_DOMAIN_MANUAL_CHECK_REASON }
    : { code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: EVIDENCE_SENDER_UNVERIFIABLE_MANUAL_CHECK_REASON };
}

/** Header names that only a mail carries: one of them makes the evidence a mail (round 2: no From and no Message-ID is still a mail). */
const MAIL_HEADER_NAMES = ['from', 'sender', 'reply-to', 'return-path', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'received', 'mime-version'] as const;

function domainOf(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
  // P4 review L-1: an address literal (a@[203.0.113.5], a@[IPv6:…]) is kept as
  // written, so it is compared — and, never equal to a registered name,
  // reported as a mismatch instead of disappearing as "no From".
  if (/^\[(?:ipv6:)?[0-9a-f:.]+\]$/.test(domain)) return domain;
  return /^[a-z0-9.-]+$/.test(domain) && domain.includes('.') ? domain : null;
}

/** Strips leading blank lines, which would otherwise end the header block before it starts. */
function withoutLeadingBlankLines(bytes: Buffer): Buffer {
  let start = 0;
  for (;;) {
    let end = start;
    while (end < bytes.length && (bytes[end] === 0x20 || bytes[end] === 0x09)) end += 1;
    if (bytes[end] === 0x0d && bytes[end + 1] === 0x0a) start = end + 2;
    else if (bytes[end] === 0x0a) start = end + 1;
    else break;
  }
  return start > 0 ? bytes.subarray(start) : bytes;
}

export function evaluateEvidenceSenderDomain(input: {
  bytes: Buffer;
  /** The issuing organization's registered contact address (accounts.contact_email). */
  registeredContactEmail: string | null | undefined;
  /** Round 2: the uploader's declared type / file name — message/rfc822 or *.eml is a mail even if its headers do not parse. */
  declaredMimeType?: string | null | undefined;
  filename?: string | null | undefined;
}): EvidenceSenderDomainCheck {
  const registeredDomain = domainOf(input.registeredContactEmail);
  const parsed = parseEml(withoutLeadingBlankLines(input.bytes));
  const headers = parsed.ok ? parsed.eml.headers : {};
  const declaredMail = (typeof input.declaredMimeType === 'string' && input.declaredMimeType.toLowerCase().startsWith('message/rfc822'))
    || (typeof input.filename === 'string' && /\.eml$/i.test(input.filename.trim()));
  // P4 review L-1 / round 2 (H-1): any mail header marks a mail — stripping From,
  // Message-ID and Received no longer turns a mail into "not an email".
  const looksLikeMail = declaredMail || (parsed.ok && MAIL_HEADER_NAMES.some((name) => headers[name] !== undefined));
  if (!looksLikeMail) {
    return { status: 'not_email', fromAddress: null, fromDomain: null, registeredDomain };
  }
  if (!parsed.ok) {
    // A declared mail whose header block cannot be read: who sent it is unknown.
    return { status: 'from_missing', fromAddress: null, fromDomain: null, registeredDomain };
  }
  const fromAddress = parsed.eml.from?.address?.toLowerCase() ?? null;
  // P4 review L-1: two From headers (or one From naming several addresses)
  // cannot say who sent the mail; the first one is never trusted alone.
  const fromHeaders = headers['from'] ?? [];
  const fromAddressCount = fromHeaders.reduce((count, value) => count + (value.match(/@/g)?.length ?? 0), 0);
  if (fromHeaders.length > 1 || fromAddressCount > 1) {
    return { status: 'multiple_from', fromAddress, fromDomain: domainOf(fromAddress), registeredDomain };
  }
  const fromDomain = domainOf(fromAddress);
  if (fromDomain === null) return { status: 'from_missing', fromAddress, fromDomain, registeredDomain };
  if (registeredDomain === null) return { status: 'no_registered_domain', fromAddress, fromDomain, registeredDomain };
  // Round 2 (H-1): exact equality only — a subdomain no longer counts by itself (it waits for the check).
  const matches = fromDomain === registeredDomain;
  return { status: matches ? 'match' : 'mismatch', fromAddress, fromDomain, registeredDomain };
}

/**
 * P4 server2 (p4-web2b review M-1): what the representative's approval card
 * says about one evidence's sender, decided by the server so the web draws it
 * as given. `not_recorded` = no check was stored with the approval (recorded
 * before P4 N4, or no evidence file). Display only: never a refusal, and the
 * dual approval and its counting do not change.
 */
export type EvidenceSenderVerdictCode =
  | 'match'
  | 'mismatch'
  | 'unverifiable'
  | 'no_registered_domain'
  | 'not_email'
  | 'not_recorded';

export interface EvidenceSenderVerdict {
  code: EvidenceSenderVerdictCode;
  /** ok = the sender domain was compared and matches; warning = show as a warning; neutral = not compared. */
  tone: 'ok' | 'warning' | 'neutral';
  label: string;
}

const SENDER_VERDICTS: Readonly<Record<EvidenceSenderVerdictCode, EvidenceSenderVerdict>> = {
  match: { code: 'match', tone: 'ok', label: '差出人のドメインが登録先と一致' },
  mismatch: { code: 'mismatch', tone: 'warning', label: '差出人のドメインが登録先と一致しません' },
  unverifiable: { code: 'unverifiable', tone: 'warning', label: '差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）' },
  no_registered_domain: { code: 'no_registered_domain', tone: 'neutral', label: '取引先のメールアドレスが未登録のため、差出人は照合していません' },
  not_email: { code: 'not_email', tone: 'neutral', label: 'メール以外の証跡のため、差出人は照合していません' },
  not_recorded: { code: 'not_recorded', tone: 'neutral', label: '差出人の照合記録がありません' }
};

export function evidenceSenderVerdict(check: EvidenceSenderDomainCheck | null | undefined): EvidenceSenderVerdict {
  if (!check) return SENDER_VERDICTS.not_recorded;
  switch (check.status) {
    case 'match': return SENDER_VERDICTS.match;
    case 'mismatch': return SENDER_VERDICTS.mismatch;
    case 'from_missing':
    case 'multiple_from': return SENDER_VERDICTS.unverifiable;
    case 'no_registered_domain': return SENDER_VERDICTS.no_registered_domain;
    case 'not_email': return SENDER_VERDICTS.not_email;
    default: return SENDER_VERDICTS.not_recorded;
  }
}

export type ApprovalEvidenceDeclarationLineCode =
  | 'issuer_differs'
  | 'shared_evidence'
  | 'declared_and_sender_match'
  | 'sender_domain_mismatch'
  | 'sender_unverifiable'
  | 'declared_only';

export interface ApprovalEvidenceDeclarationLine {
  code: ApprovalEvidenceDeclarationLineCode;
  tone: 'ok' | 'warning' | 'neutral';
  label: string;
}

/**
 * The one line the card shows next to 「発行元（登録時の申告）」. 「申告どおり」 is
 * said only when the declared issuer is the approving organization AND an
 * EML's From domain matched the organization's registered domain; a foreign
 * or unreadable sender is a warning, and an uncompared sender says so.
 */
export function approvalEvidenceDeclarationLine(input: {
  issuerMatchesOrganization: boolean;
  /** The recorder declared one shared evidence for both organizations (P0 R02). */
  sharedEvidence?: boolean;
  senderDomainCheck: EvidenceSenderDomainCheck | null | undefined;
}): ApprovalEvidenceDeclarationLine {
  if (!input.issuerMatchesOrganization) {
    return input.sharedEvidence
      ? { code: 'shared_evidence', tone: 'warning', label: '申告された発行元は承認組織と異なります（両組織の共通証跡として記録）' }
      : { code: 'issuer_differs', tone: 'warning', label: '申告された発行元が承認組織と異なります' };
  }
  const verdict = evidenceSenderVerdict(input.senderDomainCheck);
  if (verdict.code === 'match') {
    return { code: 'declared_and_sender_match', tone: 'ok', label: '申告どおり（差出人のドメインも一致）' };
  }
  if (verdict.code === 'mismatch') {
    return { code: 'sender_domain_mismatch', tone: 'warning', label: '申告は承認組織と一致・差出人のドメインは不一致' };
  }
  if (verdict.code === 'unverifiable') {
    return { code: 'sender_unverifiable', tone: 'warning', label: '申告は承認組織と一致・差出人を確認できません' };
  }
  return { code: 'declared_only', tone: 'neutral', label: '申告は承認組織と一致（差出人は照合していません）' };
}

/** Reads a stored check back from an audit row (jsonb); anything malformed is "not recorded". */
export function parseStoredEvidenceSenderDomainCheck(value: unknown): EvidenceSenderDomainCheck | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const statuses: readonly string[] = ['not_email', 'from_missing', 'multiple_from', 'no_registered_domain', 'match', 'mismatch'];
  if (typeof row.status !== 'string' || !statuses.includes(row.status)) return null;
  const text = (entry: unknown) => (typeof entry === 'string' ? entry : null);
  return {
    status: row.status as EvidenceSenderDomainStatus,
    fromAddress: text(row.fromAddress),
    fromDomain: text(row.fromDomain),
    registeredDomain: text(row.registeredDomain)
  };
}

/**
 * P4 server2 round 7 (p4-web3 review M-1): the sender facts of one approval
 * evidence, exactly as the representative's screens show them. The approval
 * card and the approval gate's pending manual verifications both answer this
 * one shape, so the 6th-step confirmation can never say 「一致」 where the card
 * warns. Display and warning only: no field here decides a refusal.
 */
export interface ApprovalEvidenceSenderFacts {
  fromAddress: string | null;
  senderDomainCheck: EvidenceSenderDomainCheck | null;
  senderVerdict: EvidenceSenderVerdict;
  declarationLine: ApprovalEvidenceDeclarationLine;
  warnings: Array<NonNullable<ReturnType<typeof evidenceSenderDomainWarning>>>;
}

export function approvalEvidenceSenderFacts(input: {
  issuerMatchesOrganization: boolean;
  sharedEvidence: boolean;
  senderDomainCheck: EvidenceSenderDomainCheck | null | undefined;
}): ApprovalEvidenceSenderFacts {
  const senderDomainCheck = input.senderDomainCheck ?? null;
  const warning = evidenceSenderDomainWarning(senderDomainCheck);
  return {
    fromAddress: senderDomainCheck?.fromAddress ?? null,
    senderDomainCheck,
    senderVerdict: evidenceSenderVerdict(senderDomainCheck),
    declarationLine: approvalEvidenceDeclarationLine({
      issuerMatchesOrganization: input.issuerMatchesOrganization,
      sharedEvidence: input.sharedEvidence,
      senderDomainCheck
    }),
    warnings: warning ? [warning] : []
  };
}
