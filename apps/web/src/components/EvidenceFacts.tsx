import { Bilingual } from './Bilingual';
import type { EvidenceLine, EvidenceTone, SenderCheckStatus, SenderWarning } from '../lib/sender-check';
import { senderStatusText } from '../lib/sender-check';

/**
 * p4/web4: the sender facts of one approval evidence, drawn the same way wherever the representative meets
 * them — the approval card's 押印欄 (ApprovalCard) and the step-6 manual check (EvidenceIssuerCheck). They
 * read the server's own lines (server2 §1(4), §13): 「申告どおり」 only when the server judged the declared
 * issuer AND the mail's From domain a match; a foreign or unreadable sender is a warning. Plain text only
 * (every label is a React text node).
 */
const TONE_MARK: Record<EvidenceTone, string> = { ok: '✓', warning: '⚠', neutral: '' };

/** One server-decided line with the mark of its tone (✓ / ⚠ / none). */
export function EvidenceLineText({ line, kind }: { line: EvidenceLine; kind: 'declaration' | 'sender' }) {
  const mark = TONE_MARK[line.tone];
  return (
    <span className={`p4w3-line p4w3-line--${line.tone}`} data-tone={line.tone} {...(kind === 'declaration' ? { 'data-declaration': line.code } : { 'data-sender': line.code })}>
      {mark ? <span aria-hidden="true">{mark} </span> : null}{line.label}
    </span>
  );
}

export interface SenderFactsInput {
  fromAddress?: string | null | undefined;
  senderStatus?: SenderCheckStatus | null | undefined;
  senderVerdict?: EvidenceLine | null | undefined;
  warnings?: readonly SenderWarning[] | undefined;
}

/** Whether the evidence carries anything to warn about (a warning declaration or a sender warning). */
export function hasEvidenceWarning(declaration: EvidenceLine | null, facts: SenderFactsInput): boolean {
  return declaration?.tone === 'warning' || (facts.warnings?.length ?? 0) > 0;
}

/** 「差出人 <From> ・ <verdict>」 — nothing when the server answered neither. */
export function SenderFromLine({ facts, className }: { facts: SenderFactsInput; className: string }) {
  if (!facts.fromAddress && !facts.senderVerdict) return null;
  return (
    <p className={className}>
      {/* web2b review L-2: with several From lines the server keeps the first one. */}
      {facts.fromAddress ? <>{facts.senderStatus === 'multiple_from' ? '差出人（1件目）' : '差出人'} <span translate="no">{facts.fromAddress}</span></> : null}
      {facts.fromAddress && facts.senderVerdict ? ' ・ ' : null}
      {facts.senderVerdict ? <EvidenceLineText line={facts.senderVerdict} kind="sender" /> : null}
    </p>
  );
}

/** What an older API's status says in one phrase, when the server gave no verdict line. */
export function SenderStatusNote({ facts, className }: { facts: SenderFactsInput; className: string }) {
  const statusText = senderStatusText(facts.senderStatus ?? null);
  if (facts.senderVerdict || !statusText) return null;
  return <p className={className}><Bilingual ja={statusText.ja} ko={statusText.ko} /></p>;
}

/** The sender warnings, one note each (role=note), in the dictionary's words. */
export function SenderWarningNotes({ warnings, className }: { warnings: readonly SenderWarning[]; className: string }) {
  return (
    <>
      {warnings.map((warning) => (
        <p key={warning.code} className={`field-warning ${className}`} role="note" data-warning={warning.code}>
          <span aria-hidden="true">⚠</span> <Bilingual ja={warning.ja} ko={warning.ko ?? ''} />
        </p>
      ))}
    </>
  );
}
