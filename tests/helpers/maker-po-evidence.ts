import { createHash } from 'node:crypto';

/**
 * M8-HARDEN FIX C1: test helper for the maker-PO send evidence, which is now
 * the original .eml of the production-order mail.
 *
 * `buildMakerPoEml` produces a minimal but genuine message — the headers the
 * verification reads (From, To, Date, Message-ID, Subject with the order code)
 * and, when asked, one base64 attachment whose bytes are the approved artwork
 * so its hash matches the frozen snapshot.
 *
 * M8-HARDEN2 FIX 1: that attachment match is the gate on VERIFIED. A send is
 * only ever verified when the message carries the approved artifact, so a test
 * that wants a VERIFIED send passes `attachmentBytes` — the exact bytes the
 * approved artwork revision freezes. The negative cases (no attachment, a
 * wrong attachment, a mail that only names a download link) pass no attachment
 * at all, or a different body text, and land in PENDING_MANUAL_VERIFICATION
 * with their attachment reason.
 *
 * `sendMakerPoEmlEvidence` registers the message through the send-evidence
 * endpoint's contentBase64 intake.
 */

export const MAKER_PO_TEST_RECIPIENT = 'maker-po@example.com';
export const MAKER_PO_TEST_SENDER = 'staff@kanei.example';

/**
 * FIX C2: a send recorded before the CEO approval — or more than ten minutes
 * ahead of the server clock — is not a plausible send, so the helper records a
 * send one minute ahead of the server clock: after the approval the test has
 * just recorded, and inside the ten-minute skew tolerance FIX C2 allows.
 */
export function plausibleTestSentAt(): string {
  return new Date(Date.now() + 60 * 1000).toISOString();
}

export interface MakerPoEmlInput {
  /** The film supply order code the frozen paper carries; goes into the subject. */
  orderCode: string;
  recipientAddress?: string;
  /** Overrides the recipient list the request declares (the hard gate). */
  requestRecipients?: string[];
  senderAddress?: string;
  /** ISO instant the send is recorded with and the Date header carries. */
  sentAtIso?: string;
  /** Overrides the Date header alone (an EML that contradicts the recorded sentAt). */
  dateHeaderIso?: string;
  messageId?: string;
  /** Overrides the subject entirely (use to test a subject without the code). */
  subject?: string;
  /** Header-level overrides for the negative cases. */
  headers?: Record<string, string | null>;
  /**
   * Attachment bytes; their sha256 must match an approved artwork file hash for
   * the send to verify (M8-HARDEN2 FIX 1). Omitted: no attachment at all.
   */
  attachmentBytes?: string;
  /** Overrides the message body text (the attachment_link_only negative case). */
  bodyText?: string;
}

export interface BuiltMakerPoEml {
  eml: string;
  contentBase64: string;
  sha256: string;
  attachmentSha256: string | null;
  senderAddress: string;
  recipientAddress: string;
  sentAtIso: string;
}

export function buildMakerPoEml(input: MakerPoEmlInput): BuiltMakerPoEml {
  const senderAddress = input.senderAddress ?? MAKER_PO_TEST_SENDER;
  const recipientAddress = input.recipientAddress ?? MAKER_PO_TEST_RECIPIENT;
  const sentAtIso = input.sentAtIso ?? plausibleTestSentAt();
  const messageId = input.messageId ?? `<maker-po-${input.orderCode}@mail.kanei.example>`;
  const subject = input.subject ?? `製造先発注書 ${input.orderCode}`;
  const headers: Array<[string, string]> = [
    ['From', `KANEI 担当 <${senderAddress}>`],
    ['To', `Maker Inc. <${recipientAddress}>`],
    ['Subject', subject],
    ['Date', new Date(input.dateHeaderIso ?? sentAtIso).toUTCString()],
    ['Message-ID', messageId],
    ['MIME-Version', '1.0']
  ];
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const index = headers.findIndex(([existing]) => existing === name);
    if (index >= 0) {
      if (value === null) headers.splice(index, 1);
      else headers[index] = [name, value];
    } else if (value !== null) {
      headers.push([name, value]);
    }
  }

  const attachment = input.attachmentBytes;
  let attachmentSha256: string | null = null;
  let body: string;
  if (attachment === undefined) {
    headers.push(['Content-Type', 'text/plain; charset=UTF-8'], ['Content-Transfer-Encoding', '8bit']);
    body = `${input.bodyText ?? `発注コード ${input.orderCode} の製造先発注書を送付します。`}\r\n`;
  } else {
    const boundary = '------------kanei-m8-harden-boundary';
    headers.push(['Content-Type', `multipart/mixed; boundary="${boundary}"`]);
    const attachmentBase64 = Buffer.from(attachment, 'utf8').toString('base64');
    attachmentSha256 = createHash('sha256').update(Buffer.from(attachment, 'utf8')).digest('hex');
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      `発注コード ${input.orderCode} の製造先発注書を添付します。`,
      '',
      `--${boundary}`,
      `Content-Type: ${attachment.startsWith('%PDF-') ? 'application/pdf' : 'text/plain'}; name="maker-po${attachment.startsWith('%PDF-') ? '.pdf' : '.txt'}"`,
      `Content-Disposition: attachment; filename="maker-po${attachment.startsWith('%PDF-') ? '.pdf' : '.txt'}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachmentBase64,
      '',
      `--${boundary}--`,
      ''
    ].join('\r\n');
  }

  const eml = [
    ...headers.map(([name, value]) => `${name}: ${value}`),
    '',
    body
  ].join('\r\n');
  const bytes = Buffer.from(eml, 'utf8');
  return {
    eml,
    contentBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    attachmentSha256,
    senderAddress,
    recipientAddress,
    sentAtIso
  };
}

export type MakerPoPoster = (url: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** Registers one send with an .eml payload, the way the screens' staff would. */
export async function sendMakerPoEmlEvidence(
  post: MakerPoPoster,
  poId: string,
  input: MakerPoEmlInput
): Promise<{ status: number; body: unknown; built: BuiltMakerPoEml }> {
  const built = buildMakerPoEml(input);
  const response = await post(`/api/maker-purchase-orders/${poId}/send-evidence`, {
    contentBase64: built.contentBase64,
    senderAddress: built.senderAddress,
    recipients: input.requestRecipients ?? [built.recipientAddress],
    sentAt: built.sentAtIso
  });
  return { status: response.status, body: response.body, built };
}
