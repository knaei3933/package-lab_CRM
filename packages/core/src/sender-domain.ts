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
