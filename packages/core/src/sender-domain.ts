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
  /** An email without a usable From address. */
  | 'from_missing'
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

export const EVIDENCE_SENDER_DOMAIN_MISMATCH_MESSAGE =
  '承認証跡メールの差出人のドメインが、発行元として登録されている取引先のドメインと一致しません。発行元を確かめてから確認してください';

function domainOf(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
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
  const looksLikeMail = parsed.ok && (
    (headers['message-id'] ?? []).length > 0
    || headers['received'] !== undefined
    || (headers['from'] !== undefined && headers['date'] !== undefined)
  );
  if (!parsed.ok || !looksLikeMail) {
    return { status: 'not_email', fromAddress: null, fromDomain: null, registeredDomain };
  }
  const fromAddress = parsed.eml.from?.address?.toLowerCase() ?? null;
  const fromDomain = domainOf(fromAddress);
  if (fromDomain === null) return { status: 'from_missing', fromAddress, fromDomain, registeredDomain };
  if (registeredDomain === null) return { status: 'no_registered_domain', fromAddress, fromDomain, registeredDomain };
  const matches = fromDomain === registeredDomain || fromDomain.endsWith(`.${registeredDomain}`);
  return { status: matches ? 'match' : 'mismatch', fromAddress, fromDomain, registeredDomain };
}
