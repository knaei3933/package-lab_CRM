import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/**
 * M8-HARDEN FIX C1: the send evidence of a maker purchase order is the
 * production-order EMAIL itself, verified as an email.
 *
 * A maker PO is sent by hand (Thunderbird, the Sent folder), so the only proof
 * the company holds is the message it actually sent. Until now any file cited
 * as `send_evidence` — a note, a screenshot, a PDF — was enough to register the
 * send as VERIFIED. This module closes that: the bytes are parsed as an RFC 822
 * / MIME message and the headers are checked against the frozen paper.
 *
 * Deliberately a hand-written parser, not a dependency: the checks read a
 * handful of headers and the attachment hashes of a Thunderbird export, and
 * keeping the parser inside the pure core keeps it unit-testable and the
 * dependency list unchanged. It is not a general purpose MIME library — it
 * parses the shapes a mail client emits (multipart/mixed with base64 parts,
 * folded headers, RFC 2047 encoded words) and refuses everything it does not
 * understand, which is the safe direction for evidence.
 *
 * What VERIFIED means here — and what it does not: a VERIFIED send event says
 * the email content and its recipient were verified against the frozen paper.
 * Storing the EML is NOT proof of delivery. Delivery is asserted only by the
 * representative's manual confirmation (the maker PO send manual verification
 * record), which is a separate, append-only human decision.
 *
 * M8-HARDEN2 FIX 1 — the attachment match becomes the gate. Until now the
 * attachment hashes were recorded but never blocked, so a mail with correct
 * headers and no production-order paper attached still read VERIFIED. VERIFIED
 * now requires at least one attachment whose sha256 is one of the approved
 * artifact hashes the snapshot freezes (the approved PO / artwork revision
 * documents). Headers that pass with no attachment, with attachments matching
 * nothing the company approved — a re-exported PDF among them — or that only
 * point at a download link are all PENDING_MANUAL_VERIFICATION, with the
 * machine-readable reason on the event.
 */

/** The verification method recorded on a send event whose evidence was parsed as an EML. */
export const MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK = 'eml_header_check' as const;

/** How far a recorded sentAt may sit in the future of the server clock (FIX C2). */
export const MAKER_PO_SENT_AT_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

/** How far the EML Date header may sit from the recorded sentAt and still agree. */
export const MAKER_PO_EML_DATE_SKEW_TOLERANCE_MS = 10 * 60 * 1000;

/** One address as the message carries it: display name (optional) and the address itself. */
export interface EmlAddress {
  name: string | null;
  /** Lower-cased, or null when the header named no usable address. */
  address: string | null;
}

/** One attachment of the message with the hash its decoded bytes compute to. */
export interface EmlAttachment {
  filename: string | null;
  contentType: string | null;
  sha256: string;
  byteSize: number;
  /** The decoded part bytes; only the server-side evidence rules read these. */
  bytes: Buffer;
  /** True for an inline Content-ID part (signature logo) that is not a named attachment. */
  inline?: boolean;
}

/** The parts of a message the send verification reads. */
export interface ParsedEml {
  /** Lower-cased header names, unfolded values, in the order the message carries them. */
  headers: Record<string, string[]>;
  messageId: string | null;
  from: EmlAddress | null;
  to: EmlAddress[];
  cc: EmlAddress[];
  date: Date | null;
  dateRaw: string | null;
  subject: string | null;
  attachments: EmlAttachment[];
  /**
   * M8-HARDEN2 FIX 1: the decoded text of the message's non-attachment text
   * parts. A mail that only points at a download link reads very differently
   * from one that attached nothing at all, and the attachment reason records
   * the difference.
   */
  bodyText: string;
}

export type EmlParseResult =
  | { ok: true; eml: ParsedEml }
  | { ok: false; reason: string };

interface HeaderBlock {
  headers: Record<string, string[]>;
  body: string;
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/**
 * Splits one header block from its body and unfolds the continuation lines.
 * Headers are stored lower-cased and in order; a line without a colon is not a
 * header and is dropped, so a crafted "header" can never smuggle a value in.
 */
function splitHeaders(text: string): HeaderBlock {
  const lines = toLines(text);
  const headers: Record<string, string[]> = {};
  let current: { name: string; value: string } | null = null;
  let bodyStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      bodyStart = index + 1;
      break;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && current) {
      current.value = `${current.value} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      current = null;
      continue;
    }
    current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
    if (headers[current.name] === undefined) headers[current.name] = [];
    headers[current.name]!.push(current.value);
  }
  const body = bodyStart === -1 ? '' : lines.slice(bodyStart).join('\r\n');
  return { headers, body };
}

/** Splits an address list on commas that sit outside quotes and angle brackets. */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  for (const character of value) {
    if (character === '"') {
      inQuotes = !inQuotes;
      current += character;
    } else if (character === '<' && !inQuotes) {
      inAngle = true;
      current += character;
    } else if (character === '>' && !inQuotes) {
      inAngle = false;
      current += character;
    } else if (character === ',' && !inQuotes && !inAngle) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/** Reads one address out of one list element; null when it names no usable address. */
export function parseEmlAddress(raw: string): EmlAddress | null {
  let value = raw.trim();
  if (value.length === 0) return null;
  // RFC 5322 group syntax: the group name is display data, never a recipient.
  const groupColon = value.indexOf(':');
  if (groupColon > 0 && !value.slice(0, groupColon).includes('<')) {
    value = value.slice(groupColon + 1).trim();
  }
  const angle = /<([^<>]*)>/.exec(value);
  if (angle) {
    const address = angle[1]!.trim().toLowerCase();
    const name = value.slice(0, angle.index).replace(/"/g, '').trim();
    return { name: name.length > 0 ? name : null, address: address.length > 0 ? address : null };
  }
  if (/\s/.test(value) || !value.includes('@')) return null;
  return { name: null, address: value.toLowerCase() };
}

function parseAddressHeader(values: string[] | undefined): EmlAddress[] {
  if (values === undefined) return [];
  const addresses: EmlAddress[] = [];
  for (const value of values) {
    for (const element of splitAddressList(decodeEncodedWords(value))) {
      const address = parseEmlAddress(element);
      if (address && address.address) addresses.push(address);
    }
  }
  return addresses;
}

/**
 * Message-ID shape (RFC 5322 msg-id): one pair of angle brackets around an
 * id-left@id-right with no whitespace and no nested brackets. A message without
 * a usable Message-ID is not an export of a sent mail — it is text that merely
 * looks like mail.
 */
export function isValidMessageId(value: string | null): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) return false;
  const inner = trimmed.slice(1, -1);
  if (inner.length === 0) return false;
  if (/[\s<>"']/.test(inner)) return false;
  return inner.includes('@');
}

function decodeQuotedPrintableText(text: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '_') {
      bytes.push(0x20);
      continue;
    }
    if (character === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    for (const byte of Buffer.from(character, 'utf8')) bytes.push(byte);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** RFC 2047 encoded words in Subject/addresses: =?charset?B|Q?text?= */
export function decodeEncodedWords(value: string): string {
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(/=\?[^?]+\?[bBqQ]\?[^?]*\?=/g, (match) => {
    const parts = match.split('?');
    const encoding = parts[2]?.toLowerCase();
    const text = parts[3] ?? '';
    if (encoding === 'b') {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      return decoded;
    }
    return decodeQuotedPrintableText(text);
  });
}

/** `type/subtype; key=value` — the parameters the MIME walk needs. */
function parseStructuredHeader(value: string | null): { mime: string; params: Record<string, string> } {
  if (value === null) return { mime: '', params: {} };
  const segments = value.split(';');
  const mime = (segments[0] ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    const key = segment.slice(0, equals).trim().toLowerCase();
    let parameterValue = segment.slice(equals + 1).trim();
    if (parameterValue.startsWith('"') && parameterValue.endsWith('"') && parameterValue.length >= 2) {
      parameterValue = parameterValue.slice(1, -1);
    }
    if (key.length > 0) params[key] = parameterValue;
  }
  return { mime, params };
}

function decodePartBody(body: string, contentTransferEncoding: string): Buffer {
  const encoding = contentTransferEncoding.trim().toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (encoding === 'quoted-printable') {
    const withoutSoftBreaks = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
      const character = withoutSoftBreaks[index]!;
      if (character === '=' && /^[0-9a-fA-F]{2}$/.test(withoutSoftBreaks.slice(index + 1, index + 3))) {
        bytes.push(Number.parseInt(withoutSoftBreaks.slice(index + 1, index + 3), 16));
        index += 2;
        continue;
      }
      for (const byte of Buffer.from(character, 'utf8')) bytes.push(byte);
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, 'utf8');
}

function dispositionSaysAttachment(dispositionHeader: string[] | undefined): boolean {
  if (dispositionHeader === undefined || dispositionHeader.length === 0) return false;
  const { mime, params } = parseStructuredHeader(dispositionHeader[0] ?? null);
  if (mime === 'attachment') return true;
  // Thunderbird marks most file attachments `inline` while still naming them.
  return mime === 'inline' && typeof params.filename === 'string' && params.filename.length > 0;
}

function collectAttachments(
  headers: Record<string, string[]>,
  body: string,
  out: EmlAttachment[],
  texts: string[],
  insideRelated = false
): void {
  const contentType = parseStructuredHeader(headers['content-type']?.[0] ?? null);
  if (contentType.mime.startsWith('multipart/')) {
    const boundary = contentType.params.boundary;
    if (typeof boundary !== 'string' || boundary.length === 0) return;
    const marker = `--${boundary}`;
    for (const partText of splitMultipart(body, marker)) {
      const part = splitHeaders(partText);
      collectAttachments(part.headers, part.body, out, texts, contentType.mime === 'multipart/related');
    }
    return;
  }
  const transferEncoding = headers['content-transfer-encoding']?.[0] ?? '7bit';
  // G4: an inline part of multipart/related (an image referenced by Content-ID)
  // is carried bytes, not message text, so its hash must be visible too.
  const isInlineBinary =
    !contentType.mime.startsWith('text/') &&
    !contentType.mime.startsWith('multipart/') &&
    contentType.mime !== '' &&
    (insideRelated || (headers['content-id']?.length ?? 0) > 0);
  if (!dispositionSaysAttachment(headers['content-disposition']) && !isInlineBinary) {
    // FIX 1: the readable text of the message, so a mail that only names a
    // download link can be told apart from one that attached nothing.
    if (contentType.mime === '' || contentType.mime.startsWith('text/')) {
      texts.push(decodePartBody(body, transferEncoding).toString('utf8'));
    }
    return;
  }
  const disposition = parseStructuredHeader(headers['content-disposition']?.[0] ?? null);
  const decoded = decodePartBody(body, transferEncoding);
  out.push({
    filename: disposition.params.filename ?? contentType.params.name ?? null,
    contentType: contentType.mime.length > 0 ? contentType.mime : null,
    sha256: sha256Of(decoded),
    byteSize: decoded.length,
    bytes: decoded,
    inline:
      !dispositionSaysAttachment(headers['content-disposition']) &&
      contentType.mime.startsWith('image/') &&
      (headers['content-id']?.length ?? 0) > 0
  });
}

/** Decodes one literal PDF string (the (...) Tj operator), including escapes. */
function decodePdfLiteralString(raw: string): string {
  let value = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character !== '\\') {
      value += character;
      continue;
    }
    const next = raw[++index];
    if (next === undefined) break;
    if (next === 'n') value += '\n';
    else if (next === 'r') value += '\r';
    else if (next === 't') value += '\t';
    else if (next === 'b' || next === 'f') value += ' ';
    else if (next >= '0' && next <= '7') {
      let octal = next;
      while (octal.length < 3 && raw[index + 1] !== undefined && raw[index + 1]! >= '0' && raw[index + 1]! <= '7') {
        octal += raw[++index]!;
      }
      value += String.fromCharCode(Number.parseInt(octal, 8));
    } else value += next;
  }
  return value;
}

/** Turns PDF text-operator content into searchable text (ASCII/Latin-1 range). */
function extractPdfContentText(content: string): string {
  const chunks: string[] = [];
  const literal = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|TJ|'|")/g;
  for (let match = literal.exec(content); match !== null; match = literal.exec(content)) {
    chunks.push(decodePdfLiteralString(match[1] ?? ''));
  }

  // A TJ array can split one visible identifier across kerning-adjusted strings.
  const arrays = /\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ/g;
  for (let array = arrays.exec(content); array !== null; array = arrays.exec(content)) {
    const inner = array[1] ?? '';
    let value = '';
    const strings = /\(((?:\\.|[^\\)])*)\)/g;
    for (let part = strings.exec(inner); part !== null; part = strings.exec(inner)) {
      value += decodePdfLiteralString(part[1] ?? '');
    }
    chunks.push(value);
  }

  const hex = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
  for (let match = hex.exec(content); match !== null; match = hex.exec(content)) {
    chunks.push(Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'hex').toString('latin1'));
  }
  return chunks.join('\n');
}

/**
 * G7: reads the text layer of the small internal PDFs used for automatic
 * checks. Compressed content streams are inflated; an image-only scan yields an
 * empty string and deliberately stays on its existing manual-verification path.
 */
/** The fail-closed classification of one PDF content stream. */
export type PdfTextLayerState = 'text' | 'scan' | 'indeterminate';
export interface PdfTextLayerPage {
  state: PdfTextLayerState;
  text: string;
}

/**
 * G5/G7: inspect each content stream separately so one bad page cannot hide
 * behind a matching page. Only raw and Flate streams are decoded. Every other
 * filter (ASCIIHex, ASCII85, LZW, image codecs, ...) is indeterminate, never a
 * "scan": an undecodable text layer must keep a human in the loop.
 */
export function inspectPdfTextLayers(bytes: Buffer): PdfTextLayerPage[] {
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return [];
  const pages: PdfTextLayerPage[] = [];
  let cursor = 0;
  const streamToken = Buffer.from('stream', 'latin1');
  const endToken = Buffer.from('endstream', 'latin1');
  while (cursor < bytes.length) {
    const start = bytes.indexOf(streamToken, cursor);
    if (start < 0) break;
    let bodyStart = start + streamToken.length;
    if (bytes[bodyStart] === 0x0d) bodyStart += 1;
    if (bytes[bodyStart] === 0x0a) bodyStart += 1;
    const end = bytes.indexOf(endToken, bodyStart);
    if (end < 0) break;
    const stream = bytes.subarray(bodyStart, end);
    const dictionary = bytes.subarray(Math.max(0, start - 1024), start).toString('latin1');
    const filterStart = dictionary.lastIndexOf('<<', Math.max(0, dictionary.length - 1));
    const filterDictionary = filterStart >= 0 ? dictionary.slice(filterStart) : dictionary;
    const hasFlate = filterDictionary.includes('/FlateDecode');
    const hasOtherFilter = /\/(?:ASCIIHexDecode|ASCII85Decode|LZWDecode|RunLengthDecode|CCITTFaxDecode|DCTDecode|JPXDecode|JBIG2Decode)\b/.test(filterDictionary);
    if (hasOtherFilter || (hasFlate && /\/FlateDecode[^>]*\/(?!FlateDecode\b)[A-Z][A-Za-z]+Decode/.test(filterDictionary))) {
      pages.push({ state: 'indeterminate', text: '' });
      cursor = end + endToken.length;
      continue;
    }
    if (!hasFlate) {
      const text = extractPdfContentText(stream.toString('latin1'));
      pages.push({ state: text.trim().length > 0 ? 'text' : 'scan', text });
      cursor = end + endToken.length;
      continue;
    }
    let text = '';
    try {
      text = extractPdfContentText(inflateSync(stream).toString('latin1'));
    } catch {
      pages.push({ state: 'indeterminate', text: '' });
      cursor = end + endToken.length;
      continue;
    }
    pages.push({ state: text.trim().length > 0 ? 'text' : 'scan', text });
    cursor = end + endToken.length;
  }
  return pages.length > 0 ? pages : [{ state: 'scan', text: '' }];
}

/** Compatibility helper for callers that only need the supported text. */
export function extractPdfText(bytes: Buffer): string {
  return inspectPdfTextLayers(bytes)
    .filter((page) => page.state === 'text')
    .map((page) => page.text)
    .join('\n');
}

/**
 * M8-HARDEN2 FIX 1: a URL in the message text — the mail points at a file
 * somewhere else instead of carrying it. The attachment reason distinguishes
 * that from an export that carries no attachment at all.
 */
const DOWNLOAD_LINK_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

function hasDownloadLink(bodyText: string): boolean {
  return DOWNLOAD_LINK_PATTERN.test(bodyText);
}

/** Splits a multipart body on its boundary lines; the closing marker ends the walk. */
function splitMultipart(body: string, marker: string): string[] {
  const lines = toLines(body);
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.trim() === marker) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = [];
      continue;
    }
    if (line.trim() === `${marker}--`) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = null;
      continue;
    }
    if (current !== null) current.push(line);
  }
  return parts;
}

/**
 * G2: the comparison form of a Message-ID — angle brackets and surrounding
 * whitespace dropped, the domain part (after the last @) lower-cased, the local
 * part kept exactly. Returns null when the value is not an id-left@id-right.
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  let inner = value.trim();
  if (inner.startsWith('<') && inner.endsWith('>')) inner = inner.slice(1, -1).trim();
  const at = inner.lastIndexOf('@');
  if (at <= 0 || at === inner.length - 1 || /[\s<>]/.test(inner)) return null;
  return `${inner.slice(0, at)}@${inner.slice(at + 1).toLowerCase()}`;
}

/**
 * Normalized, token-boundary comparison shared by subject matching and G7.
 * Case is normalized, but FSO-1 can never satisfy FSO-10 or FSO-12.
 */
export function hasNormalizedToken(text: string, token: string): boolean {
  const normalizedToken = token.trim().toUpperCase();
  if (normalizedToken.length === 0) return false;
  const escaped = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(text.toUpperCase());
}

/**
 * Parses the bytes of one message. Anything that is not shaped like a mail
 * message — a plain note, a PDF, a screenshot — is refused, never guessed.
 */
export function parseEml(bytes: Buffer): EmlParseResult {
  const text = bytes.toString('utf8');
  if (text.length === 0) return { ok: false, reason: 'the evidence content is empty' };

  const split = splitHeaders(text);
  const headerNames = Object.keys(split.headers);
  if (headerNames.length === 0) return { ok: false, reason: 'no email headers were found in the evidence content' };

  const messageIdHeader = split.headers['message-id']?.[0] ?? null;
  const dateRaw = split.headers['date']?.[0] ?? null;
  const parsedDate = dateRaw === null ? null : new Date(decodeEncodedWords(dateRaw));
  const attachments: EmlAttachment[] = [];
  const bodyTexts: string[] = [];
  collectAttachments(split.headers, split.body, attachments, bodyTexts);

  return {
    ok: true,
    eml: {
      headers: split.headers,
      messageId: messageIdHeader === null ? null : decodeEncodedWords(messageIdHeader),
      from: parseAddressHeader(split.headers['from'])[0] ?? null,
      to: parseAddressHeader(split.headers['to']),
      cc: parseAddressHeader(split.headers['cc']),
      date: parsedDate !== null && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
      dateRaw,
      subject: split.headers['subject']?.[0] !== undefined ? decodeEncodedWords(split.headers['subject'][0]!) : null,
      attachments,
      bodyText: bodyTexts.join('\n')
    }
  };
}

// ---------------------------------------------------------------------------
// The check list (FIX C1)
// ---------------------------------------------------------------------------

export type MakerPoEmlCheckStatus = 'passed' | 'failed' | 'not_matched' | 'skipped';

/** One machine-readable row of the verification recorded on the send event. */
export interface MakerPoEmlCheck {
  key: string;
  status: MakerPoEmlCheckStatus;
  detail: string | null;
}

export type MakerPoEmlPendingCode =
  | 'EML_UNPARSABLE'
  | 'EML_MESSAGE_ID_MISSING'
  | 'EML_MESSAGE_ID_INVALID'
  | 'EML_FROM_HEADER_MISSING'
  | 'EML_SENDER_MISMATCH'
  | 'EML_RECIPIENT_MISMATCH'
  | 'EML_DATE_HEADER_MISSING'
  | 'EML_DATE_HEADER_UNPARSABLE'
  | 'EML_DATE_SENT_AT_CONFLICT'
  | 'EML_SUBJECT_IDENTIFIER_MISSING'
  | 'SENT_AT_PRECEDES_CEO_APPROVAL'
  // M8-HARDEN2 FIX 1: the attachment reasons, spelled exactly as the screens
  // and the audit read them — the mail passed every header check and still did
  // not prove that the approved paper reached the maker.
  | MakerPoAttachmentPendingCode;

/** Why a header-clean mail stays pending on its attachments (M8-HARDEN2 FIX 1). */
export type MakerPoAttachmentPendingCode =
  | 'attachment_missing'
  | 'attachment_hash_mismatch'
  | 'attachment_link_only'
  // G5: hash equality proves bytes, not the human-readable number on a scan.
  | 'SCAN_PDF_MANUAL_VERIFICATION_REQUIRED'
  // G5/P10: a stream using an unsupported filter must not be treated as a scan.
  | 'PDF_TEXT_LAYER_INDETERMINATE'
  // G7: the approved bytes match, but a readable text layer names another code.
  | 'EVIDENCE_CODE_MISMATCH';

export interface MakerPoEmlEvidenceInput {
  /** The raw .eml bytes (message/rfc822) the send is proven by. */
  bytes: Buffer;
  /** The recorded send time the evidence is registered with. */
  sentAt: Date;
  /** The PO's approval stamp: a send recorded before it is not a plausible send. */
  ceoApprovedAt: Date | null;
  /** The server clock at registration. */
  now: Date;
  /** The recipient the frozen paper names (the maker account's address). */
  expectedRecipientAddress: string;
  /** The sender address the registration records; the From header must agree. */
  recordedSenderAddress: string;
  /** The PO identifiers the subject must carry (order code, seven PO number). */
  subjectIdentifiers: string[];
  /**
   * G7: the CRM order code the subject template inserted. Unlike the broader
   * subject identifiers, this exact value must also occur in a readable PDF
   * text layer before a send can verify.
   */
  documentCode?: string | undefined;
  /**
   * G7: the code actually matched in the subject. PDF checks require both the
   * frozen order code and this subject code, so a stale subject cannot pass by
   * merely quoting the snapshot's code.
   */
  subjectCode?: string | undefined;
  /**
   * The approved artifact hashes the snapshot freezes — the approved PO /
   * artwork revision documents. Since M8-HARDEN2 FIX 1 at least one attachment
   * of the mail must be exactly one of these bytes for the send to verify.
   */
  artworkFileSha256s: string[];
}

export type MakerPoEmlEvidenceEvaluation =
  | {
      ok: true;
      verificationStatus: 'VERIFIED';
      verificationMethod: typeof MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK;
      checks: MakerPoEmlCheck[];
      messageId: string | null;
      senderAddress: string | null;
      recipients: string[];
      emlDate: Date | null;
      attachmentHashes: string[];
      matchedAttachmentHashes: string[];
    }
  | {
      ok: true;
      verificationStatus: 'PENDING_MANUAL_VERIFICATION';
      verificationMethod: typeof MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK;
      checks: MakerPoEmlCheck[];
      pendingCode: MakerPoEmlPendingCode;
      /** Every blocking reason, in check order; `pendingCode` stays the first. */
      pendingCodes: MakerPoEmlPendingCode[];
      reasonNote: string;
      messageId: string | null;
      senderAddress: string | null;
      recipients: string[];
      emlDate: Date | null;
      attachmentHashes: string[];
      matchedAttachmentHashes: string[];
    };

function check(key: string, status: MakerPoEmlCheckStatus, detail: string | null = null): MakerPoEmlCheck {
  return { key, status, detail };
}

const PENDING_MESSAGES: Record<MakerPoEmlPendingCode, string> = {
  EML_UNPARSABLE: '送信証跡をメール（.eml）として解析できませんでした。Thunderbirdの送信済みフォルダから原本のEMLを書き出して登録してください',
  EML_MESSAGE_ID_MISSING: '送信証跡にMessage-IDヘッダーがないため、送信済みメールとして確認できませんでした',
  EML_MESSAGE_ID_INVALID: '送信証跡のMessage-IDが不正な形式のため、送信済みメールとして確認できませんでした',
  EML_FROM_HEADER_MISSING: '送信証跡にFromヘッダーがないため、送信者を確認できませんでした',
  EML_SENDER_MISMATCH: '送信証跡のFromヘッダーが記録された送信者アドレスと一致しません',
  EML_RECIPIENT_MISMATCH: '送信証跡の宛先（To/Cc）に発注書の宛先アドレスが含まれていません',
  EML_DATE_HEADER_MISSING: '送信証跡にDateヘッダーがないため、送信日時を確認できませんでした',
  EML_DATE_HEADER_UNPARSABLE: '送信証跡のDateヘッダーを解釈できなかったため、送信日時を確認できませんでした',
  EML_DATE_SENT_AT_CONFLICT: '送信証跡のDateヘッダーと記録された送信日時が一致しません（許容範囲：10分）',
  EML_SUBJECT_IDENTIFIER_MISSING: '送信証跡の件名に発注書の識別子（発注コード）が含まれていません',
  SENT_AT_PRECEDES_CEO_APPROVAL: '記録された送信日時が代表者承認より前です。送信日時を確認してください',
  attachment_missing: '送信証跡に添付ファイルがないため、承認済み成果物（発注書・版下）との一致を確認できませんでした。原本のEMLに発注書を添付して登録してください',
  attachment_hash_mismatch: '送信証跡の添付ファイルが承認済み成果物（発注書・版下）のハッシュと一致しませんでした。Thunderbirdから原本のEMLを書き出して登録してください（再出力したPDFも自動確認の対象になりません）',
  attachment_link_only: '送信証跡に添付ファイルがなく、ダウンロードリンクのみが記載されているため、承認済み成果物との一致を確認できませんでした。ファイルを添付した原本のEMLを登録してください',
  SCAN_PDF_MANUAL_VERIFICATION_REQUIRED: 'スキャンPDFはハッシュが一致しても自動確認できません。人がPDF番号と件名を確認するまで承認待ちにします',
  PDF_TEXT_LAYER_INDETERMINATE: 'PDFテキスト層を安全に判定できないフィルターのため、自動確認を停止しました。人が原本を確認してください',
  EVIDENCE_CODE_MISMATCH: 'コード不一致：件名の発注コードがPDFテキスト内の番号と一致しません。自動確認は禁止し、人が原本PDFとメール件名を確認する必要があります'
};

/**
 * Evaluates one .eml payload against the frozen paper (FIX C1, tightened by
 * M8-HARDEN2 FIX 1).
 *
 * Every check is recorded. A VERIFIED answer requires all of the core header
 * checks to pass AND at least one attachment whose sha256 is one of the
 * approved artifact hashes the snapshot freezes — the paper the maker was sent
 * has to be the paper the message carried. A failing core check, or a message
 * whose attachments are absent / match nothing approved / are replaced by a
 * download link, downgrades the event to PENDING_MANUAL_VERIFICATION — it can
 * never reach VERIFIED on its own.
 *
 * The core checks are evaluated first and the attachment gate last, so a mail
 * that fails a header surfaces that header as its reason: the attachment
 * reasons describe a mail that was otherwise clean.
 */
export function evaluateMakerPoEmlEvidence(input: MakerPoEmlEvidenceInput): MakerPoEmlEvidenceEvaluation {
  const parsed = parseEml(input.bytes);
  if (!parsed.ok) {
    return {
      ok: true,
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      verificationMethod: MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK,
      checks: [check('eml_parse', 'failed', parsed.reason)],
      pendingCode: 'EML_UNPARSABLE',
      pendingCodes: ['EML_UNPARSABLE'],
      reasonNote: PENDING_MESSAGES.EML_UNPARSABLE,
      messageId: null,
      senderAddress: null,
      recipients: [],
      emlDate: null,
      attachmentHashes: [],
      matchedAttachmentHashes: []
    };
  }

  const eml = parsed.eml;
  const checks: MakerPoEmlCheck[] = [check('eml_parse', 'passed')];
  // The first failing core check names why the event cannot be VERIFIED; every
  // later failure is still recorded on the event.
  const pendingCodes: MakerPoEmlPendingCode[] = [];
  const fail = (code: MakerPoEmlPendingCode, key: string, detail: string) => {
    checks.push(check(key, 'failed', detail));
    pendingCodes.push(code);
  };

  // (1) Message-ID present and syntactically valid.
  if (eml.messageId === null) fail('EML_MESSAGE_ID_MISSING', 'message_id', 'no Message-ID header');
  else if (!isValidMessageId(eml.messageId)) fail('EML_MESSAGE_ID_INVALID', 'message_id', eml.messageId);
  else checks.push(check('message_id', 'passed', eml.messageId));

  // (2) From header present, and agreeing with the sender the registration
  // records — a From that contradicts the recorded sender is exactly the
  // inconsistency this verification exists to catch.
  const fromAddress = eml.from?.address ?? null;
  const recordedSender = input.recordedSenderAddress.trim().toLowerCase();
  if (fromAddress === null) fail('EML_FROM_HEADER_MISSING', 'from_header', 'no usable From address');
  else if (fromAddress !== recordedSender) {
    fail('EML_SENDER_MISMATCH', 'from_header', `from=${fromAddress} recorded=${recordedSender}`);
  } else checks.push(check('from_header', 'passed', fromAddress));

  // (3) To/Cc carries the recipient the frozen paper names.
  const recipients = [...eml.to, ...eml.cc]
    .map((address) => address.address)
    .filter((address): address is string => address !== null);
  const expectedRecipient = input.expectedRecipientAddress.trim().toLowerCase();
  if (recipients.includes(expectedRecipient)) {
    checks.push(check('recipient_address', 'passed', expectedRecipient));
  } else {
    fail('EML_RECIPIENT_MISMATCH', 'recipient_address', expectedRecipient);
  }

  // (4) Date header parses and agrees with the recorded sentAt.
  if (eml.dateRaw === null) fail('EML_DATE_HEADER_MISSING', 'date_header', 'no Date header');
  else if (eml.date === null) fail('EML_DATE_HEADER_UNPARSABLE', 'date_header', eml.dateRaw);
  else checks.push(check('date_header', 'passed', eml.date.toISOString()));
  if (eml.date !== null) {
    const skew = Math.abs(eml.date.getTime() - input.sentAt.getTime());
    if (skew > MAKER_PO_EML_DATE_SKEW_TOLERANCE_MS) {
      fail(
        'EML_DATE_SENT_AT_CONFLICT',
        'date_sent_at_consistency',
        `eml=${eml.date.toISOString()} sentAt=${input.sentAt.toISOString()} skewMs=${skew}`
      );
    } else {
      checks.push(check('date_sent_at_consistency', 'passed', `skewMs=${skew}`));
    }
  } else {
    checks.push(check('date_sent_at_consistency', 'skipped', 'no parsable Date header'));
  }

  // (5) The subject names the paper it was sent for.
  const subject = eml.subject ?? '';
  const matchedIdentifier = input.subjectIdentifiers
    .filter((identifier) => identifier.length > 0)
    .find((identifier) => hasNormalizedToken(subject, identifier));
  if (matchedIdentifier !== undefined) {
    checks.push(check('subject_identifier', 'passed', matchedIdentifier));
  } else {
    fail('EML_SUBJECT_IDENTIFIER_MISSING', 'subject_identifier', subject.slice(0, 200));
  }

  // Attachment hashes against the approved artifacts the snapshot freezes. The
  // gate itself is the last check below (M8-HARDEN2 FIX 1); this row is the
  // detail a reviewer reads.
  const attachmentHashes = eml.attachments.map((attachment) => attachment.sha256);
  const matched = attachmentHashes.filter((hash) => input.artworkFileSha256s.includes(hash));
  if (input.artworkFileSha256s.length === 0) {
    checks.push(check('attachment_hash', 'skipped', 'the snapshot freezes no file hashes'));
  } else if (matched.length > 0) {
    checks.push(check('attachment_hash', 'passed', matched.join(',')));
  } else {
    checks.push(check('attachment_hash', 'not_matched', `${attachmentHashes.length} attachment(s)`));
  }

  // FIX C2: a send recorded before its own approval is not a plausible send.
  if (input.ceoApprovedAt !== null && input.sentAt.getTime() < input.ceoApprovedAt.getTime()) {
    fail(
      'SENT_AT_PRECEDES_CEO_APPROVAL',
      'sent_at_plausibility',
      `sentAt=${input.sentAt.toISOString()} ceoApprovedAt=${input.ceoApprovedAt.toISOString()}`
    );
  } else {
    checks.push(check('sent_at_plausibility', 'passed'));
  }

  // M8-HARDEN2 FIX 1: the attachment gate. Headers alone do not prove that the
  // approved paper reached the maker; the message has to carry it. When the
  // snapshot freezes no approved hashes at all there is nothing the bytes could
  // match, so the mail stays pending too — the human decides, never the header
  // check.
  let attachmentFailure: MakerPoAttachmentPendingCode | null = null;
  if (matched.length > 0) {
    checks.push(check('attachment_gate', 'passed', matched.join(',')));
  } else if (eml.attachments.every((a) => a.inline === true) && hasDownloadLink(eml.bodyText)) {
    attachmentFailure = 'attachment_link_only';
    checks.push(check('attachment_gate', 'failed', 'a download link instead of an attached file'));
  } else if (eml.attachments.length === 0) {
    attachmentFailure = 'attachment_missing';
    checks.push(check('attachment_gate', 'failed', 'no attached file'));
  } else {
    attachmentFailure = 'attachment_hash_mismatch';
    checks.push(check(
      'attachment_gate',
      'failed',
      `${attachmentHashes.length} attachment(s), none of the ${input.artworkFileSha256s.length} approved hash(es)`
    ));
  }
  if (attachmentFailure !== null) pendingCodes.push(attachmentFailure);

  // G5/G7: an exact hash match proves the approved bytes were carried; it does
  // not prove the printed number agrees with the codes. A supported, readable
  // text layer must agree on every page. A scan, or a stream whose filter we
  // cannot decode, remains a mandatory human check (fail closed).
  const matchedAttachments = eml.attachments.filter((attachment) =>
    input.artworkFileSha256s.includes(attachment.sha256)
  );
  if (matchedAttachments.length > 0) {
    const pdfPages = matchedAttachments
      .filter((attachment) => attachment.bytes.subarray(0, 5).toString('latin1') === '%PDF-')
      .flatMap((attachment) => inspectPdfTextLayers(attachment.bytes));
    const hasIndeterminateLayer = pdfPages.some((page) => page.state === 'indeterminate');
    const hasScanLayer = pdfPages.some((page) => page.state === 'scan');
    const textLayers = pdfPages.filter((page) => page.state === 'text');
    const requiredCodes = [...new Set([
      input.documentCode ?? input.subjectIdentifiers[0] ?? '',
      input.subjectCode ?? matchedIdentifier ?? ''
    ])].filter((code) => code.length > 0);
    const mismatchedPages = textLayers
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => !requiredCodes.every((code) => hasNormalizedToken(page.text, code)));

    if (hasScanLayer) {
      checks.push(check('code_consistency', 'skipped', 'scan: human verification required'));
      pendingCodes.push('SCAN_PDF_MANUAL_VERIFICATION_REQUIRED');
    }
    if (hasIndeterminateLayer) {
      checks.push(check('code_consistency', 'failed', 'PDF text layer filter could not be decoded'));
      pendingCodes.push('PDF_TEXT_LAYER_INDETERMINATE');
    }
    if (textLayers.length > 0 && mismatchedPages.length > 0) {
      checks.push(check(
        'code_consistency',
        'failed',
        `page(s) ${mismatchedPages.map(({ index }) => index + 1).join(',')}; required=${requiredCodes.join(',')}`
      ));
      pendingCodes.push('EVIDENCE_CODE_MISMATCH');
    }
    if (pdfPages.length > 0 && !hasScanLayer && !hasIndeterminateLayer && textLayers.length > 0 && mismatchedPages.length === 0) {
      checks.push(check('code_consistency', 'passed', requiredCodes.join(',')));
    }
    if (pdfPages.length === 0) {
      checks.push(check('code_consistency', 'skipped', 'no PDF attachment'));
    }
  } else {
    checks.push(check('code_consistency', 'skipped', 'no approved attachment'));
  }

  const uniquePendingCodes = [...new Set(pendingCodes)];
  if (uniquePendingCodes.length > 1) {
    // Keep the machine-readable full list in the persisted JSON checks as well;
    // `pendingCode` remains a stable scalar for older readers.
    checks.push(check('pending_codes', 'failed', uniquePendingCodes.join(',')));
  }

  const shared = {
    verificationMethod: MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK,
    checks,
    messageId: eml.messageId,
    senderAddress: fromAddress,
    recipients,
    emlDate: eml.date,
    attachmentHashes,
    matchedAttachmentHashes: matched
  };

  if (uniquePendingCodes.length > 0) {
    const code = uniquePendingCodes[0]!;
    return {
      ok: true,
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      ...shared,
      pendingCode: code,
      pendingCodes: uniquePendingCodes,
      reasonNote: PENDING_MESSAGES[code]
    };
  }

  return { ok: true, verificationStatus: 'VERIFIED', ...shared };
}
