import { parseEml } from './eml.js';

/**
 * P4 N4 (conductor decision: display and warn only, never refuse). The step
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
  /** Same domain, or a subdomain of the registered one. */
  | 'match'
  /** Another domain: shown as a warning, never a refusal. */
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
}): EvidenceSenderDomainCheck {
  const registeredDomain = domainOf(input.registeredContactEmail);
  const parsed = parseEml(withoutLeadingBlankLines(input.bytes));
  const headers = parsed.ok ? parsed.eml.headers : {};
  // P4 review L-1: a From header alone marks a mail too. A mail stripped of
  // Message-ID, Date and Received is still compared (warning side), not
  // waved through as "not an email".
  const looksLikeMail = parsed.ok && (
    (headers['message-id'] ?? []).length > 0
    || headers['received'] !== undefined
    || headers['from'] !== undefined
  );
  if (!parsed.ok || !looksLikeMail) {
    return { status: 'not_email', fromAddress: null, fromDomain: null, registeredDomain };
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
  const matches = fromDomain === registeredDomain || fromDomain.endsWith(`.${registeredDomain}`);
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
