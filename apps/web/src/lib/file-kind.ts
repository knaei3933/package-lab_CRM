/**
 * P1 R22: the content type of an uploaded file is read from the file itself
 * (its first bytes, then its name) — the operator never picks 「PDF文書
 * （application/pdf）」 again. The API checks the same signatures
 * (apps/api document-storage detectMimeType) and refuses a mismatch, so this is
 * the convenience; the API stays the rule. Client-safe and pure.
 */

export type DetectedKind =
  | { ok: true; contentType: string; label: string }
  | { ok: false; reason: 'unsupported' | 'empty' };

const SIGNATURES: ReadonlyArray<{ bytes: readonly number[]; contentType: string }> = [
  { bytes: [0x25, 0x50, 0x44, 0x46], contentType: 'application/pdf' }, // %PDF
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], contentType: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], contentType: 'image/jpeg' }
];

export const KIND_LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG画像',
  'image/jpeg': 'JPEG画像',
  'message/rfc822': 'メール（EML）',
  'text/csv': 'CSV',
  'text/plain': 'テキスト'
};

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : '';
}

/** Header names that only a mail message starts with (RFC 5322 / common MTAs). */
const MAIL_HEADER = /^(?:Return-Path|Received|From|To|Subject|Date|Message-ID|MIME-Version|Delivered-To|X-[A-Za-z-]+):/im;

function looksLikeMail(text: string): boolean {
  const head = text.slice(0, 4096);
  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  return MAIL_HEADER.test(firstLine) && /^Message-ID:|^From:/im.test(head);
}

function isMostlyText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control <= sample.length * 0.01;
}

function decodeHead(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  } catch {
    return '';
  }
}

/** The content type the API will accept for these bytes, or why there is none. */
export function detectFileKind(bytes: Uint8Array, filename: string): DetectedKind {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  for (const signature of SIGNATURES) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) {
      return { ok: true, contentType: signature.contentType, label: KIND_LABELS[signature.contentType]! };
    }
  }
  if (!isMostlyText(bytes)) return { ok: false, reason: 'unsupported' };
  const extension = extensionOf(filename);
  const text = decodeHead(bytes);
  if (extension === 'eml' || looksLikeMail(text)) return { ok: true, contentType: 'message/rfc822', label: KIND_LABELS['message/rfc822']! };
  if (extension === 'csv') return { ok: true, contentType: 'text/csv', label: KIND_LABELS['text/csv']! };
  if (extension === 'txt' || extension === '') return { ok: true, contentType: 'text/plain', label: KIND_LABELS['text/plain']! };
  return { ok: false, reason: 'unsupported' };
}

export const UNSUPPORTED_FILE_MESSAGE = 'この形式のファイルは登録できません。PDF・PNG・JPEG・メール（.eml）・CSV・テキストを選んでください。';
export const EMPTY_FILE_MESSAGE = 'ファイルが空です。別のファイルを選んでください。';

/** The accept attribute of the step file inputs (a hint for the picker; the bytes decide). */
export const STEP_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.eml,.csv,.txt,application/pdf,image/png,image/jpeg,message/rfc822';

/**
 * The approval mail's own identifiers, read from an .eml header block: the
 * Message-ID (the evidence identifier the API checks against the original) and
 * the Date (when the organization approved). Null when the header is absent.
 */
export function readMailIdentifiers(text: string): { messageId: string | null; date: string | null } {
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const header = (name: string): string | null => {
    const match = new RegExp(`^${name}:[ \\t]*(.+)$`, 'im').exec(unfolded);
    return match ? match[1]!.trim() : null;
  };
  const messageId = header('Message-ID');
  const rawDate = header('Date');
  let date: string | null = null;
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString();
  }
  return { messageId: messageId && messageId.length >= 8 ? messageId : null, date };
}

/** Bytes → Base64 without spreading a large array onto the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
