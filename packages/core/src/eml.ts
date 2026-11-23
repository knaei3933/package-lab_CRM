import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';

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
  // Content streams are small and controlled. Walk literals explicitly instead
  // of a stateful global regex: this also captures strings split across a TJ
  // array and avoids any ambiguity about regex lastIndex between calls.
  let cursor = 0;
  for (;;) {
    const open = content.indexOf('(', cursor);
    if (open < 0) break;
    let index = open + 1;
    let escaped = false;
    let close = -1;
    while (index < content.length) {
      const character = content[index]!;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === ')') {
        close = index;
        break;
      }
      index += 1;
    }
    if (close < 0) break;
    const literal = decodePdfLiteralString(content.slice(open + 1, close));
    chunks.push(literal);
    cursor = close + 1;
  }

  let hexCursor = 0;
  for (;;) {
    const open = content.indexOf('<', hexCursor);
    const close = open < 0 ? -1 : content.indexOf('>', open + 1);
    if (open < 0 || close < 0) break;
    const remainder = content.slice(close + 1).match(/^[ \t\r\n]*Tj/);
    if (remainder !== null) {
      chunks.push(Buffer.from(content.slice(open + 1, close).replace(/\s+/g, ''), 'hex').toString('latin1'));
    }
    hexCursor = close + 1;
  }
  return chunks.join('\n');
}

/** The fail-closed classification of one PDF page's referenced Contents. */
export type PdfTextLayerState = 'text' | 'scan' | 'ocr' | 'indeterminate';
export interface PdfTextLayerPage {
  state: PdfTextLayerState;
  text: string;
}

type PdfDictionary = Map<string, PdfValue>;
type PdfValue =
  | { kind: 'name'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'reference'; id: number }
  | { kind: 'array'; values: Array<PdfValue> }
  | { kind: 'dictionary'; value: PdfDictionary }
  | { kind: 'opaque' };

interface ParsedPdfObject {
  id: number;
  dictionary: PdfDictionary;
  stream: Buffer | null;
}

type PdfObjectMap = Map<number, ParsedPdfObject>;
type PdfDocumentParse =
  | { valid: true; objects: PdfObjectMap; rootId: number }
  | { valid: false };

const PDF_MAX_OBJECTS = 5000;
const PDF_MAX_STREAMS = 1000;
const PDF_MAX_PAGES = 1000;
const PDF_MAX_CONTENT_REFERENCES = 20;
const PDF_MAX_STREAM_OUTPUT_BYTES = 8 * 1024 * 1024;
const PDF_MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const PDF_MAX_TOTAL_DECODED_BYTES = 32 * 1024 * 1024;
const PDF_MIN_FONT_SIZE = 0.5;

interface PdfDecodeBudget {
  decodedBytes: number;
  contentBytes: number;
  exhausted: boolean;
  decodedStreams: Map<number, string>;
}

interface PdfLexToken {
  kind: 'dictOpen' | 'dictClose' | 'arrayOpen' | 'arrayClose' | 'name' | 'number' | 'string' | 'keyword';
  value: string;
}

/** Lexes PDF object syntax without treating names or strings as dictionary keys. */
function lexPdfTokens(text: string): Array<PdfLexToken> | null {
  const tokens: Array<PdfLexToken> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '%') {
      const end = text.slice(cursor).search(/\r\n|\n|\r/);
      if (end < 0) break;
      cursor += end + (text.slice(cursor + end).startsWith('\r\n') ? 2 : 1);
      continue;
    }
    if (text.startsWith('<<', cursor)) {
      tokens.push({ kind: 'dictOpen', value: '<<' });
      cursor += 2;
      continue;
    }
    if (text.startsWith('>>', cursor)) {
      tokens.push({ kind: 'dictClose', value: '>>' });
      cursor += 2;
      continue;
    }
    if (character === '[') {
      tokens.push({ kind: 'arrayOpen', value: '[' });
      cursor += 1;
      continue;
    }
    if (character === ']') {
      tokens.push({ kind: 'arrayClose', value: ']' });
      cursor += 1;
      continue;
    }
    if (character === '(') {
      let depth = 1;
      let index = cursor + 1;
      let escaped = false;
      while (index < text.length && depth > 0) {
        const current = text[index]!;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '(') depth += 1;
        else if (current === ')') depth -= 1;
        index += 1;
      }
      if (depth !== 0) return null;
      tokens.push({ kind: 'string', value: text.slice(cursor, index) });
      cursor = index;
      continue;
    }
    if (character === '<') {
      const close = text.indexOf('>', cursor + 1);
      if (close < 0) return null;
      tokens.push({ kind: 'string', value: text.slice(cursor, close + 1) });
      cursor = close + 1;
      continue;
    }
    if (character === '/') {
      let index = cursor + 1;
      while (index < text.length && !/[\s/<>\[\](){}]/.test(text[index] ?? '')) index += 1;
      if (index === cursor + 1) return null;
      tokens.push({ kind: 'name', value: text.slice(cursor + 1, index) });
      cursor = index;
      continue;
    }
    let index = cursor;
    while (index < text.length && !/[\s/<>\[\](){}]/.test(text[index] ?? '')) index += 1;
    if (index === cursor) return null;
    const value = text.slice(cursor, index);
    tokens.push({
      kind: /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? 'number' : 'keyword',
      value
    });
    cursor = index;
  }
  return tokens;
}

function parsePdfDictionary(tokens: Array<PdfLexToken>, start: number): { value: PdfDictionary; next: number } | null {
  if (tokens[start]?.kind !== 'dictOpen') return null;
  const value: PdfDictionary = new Map();
  let index = start + 1;
  for (;;) {
    const token = tokens[index];
    if (token === undefined) return null;
    if (token.kind === 'dictClose') return { value, next: index + 1 };
    if (token.kind !== 'name') return null;
    const key = token.value;
    if (value.has(key)) return null; // duplicate top-level keys are ambiguous
    index += 1;

    let child: PdfValue | null = null;
    const current = tokens[index];
    if (current === undefined) return null;
    if (current.kind === 'dictOpen') {
      const parsed = parsePdfDictionary(tokens, index);
      if (parsed === null) return null;
      child = { kind: 'dictionary', value: parsed.value };
      index = parsed.next;
    } else if (current.kind === 'arrayOpen') {
      index += 1;
      const values: Array<PdfValue> = [];
      for (;;) {
        const member = tokens[index];
        if (member === undefined) return null;
        if (member.kind === 'arrayClose') {
          index += 1;
          break;
        }
        if (member.kind === 'dictOpen') {
          const parsed = parsePdfDictionary(tokens, index);
          if (parsed === null) return null;
          values.push({ kind: 'dictionary', value: parsed.value });
          index = parsed.next;
          continue;
        }
        if (member.kind === 'number' && tokens[index + 1]?.kind === 'number'
          && tokens[index + 2]?.kind === 'keyword' && tokens[index + 2]?.value === 'R') {
          values.push({ kind: 'reference', id: Number.parseInt(member.value, 10) });
          index += 3;
          continue;
        }
        if (member.kind === 'name') values.push({ kind: 'name', value: member.value });
        else if (member.kind === 'number') values.push({ kind: 'number', value: member.value });
        else if (member.kind === 'string') values.push({ kind: 'opaque' });
        else return null;
        index += 1;
      }
      child = { kind: 'array', values };
    } else if (current.kind === 'name') {
      child = { kind: 'name', value: current.value };
      index += 1;
    } else if (current.kind === 'number') {
      if (tokens[index + 1]?.kind === 'number'
        && tokens[index + 2]?.kind === 'keyword' && tokens[index + 2]?.value === 'R') {
        child = { kind: 'reference', id: Number.parseInt(current.value, 10) };
        index += 3;
      } else {
        child = { kind: 'number', value: current.value };
        index += 1;
      }
    } else if (current.kind === 'string') {
      child = { kind: 'opaque' };
      index += 1;
    } else if (current.kind === 'keyword' && /^(?:true|false|null)$/.test(current.value)) {
      child = { kind: 'opaque' };
      index += 1;
    } else {
      return null;
    }
    value.set(key, child);
  }
}

function parsePdfObjectDictionary(header: string): PdfDictionary | null {
  const tokens = lexPdfTokens(header);
  if (tokens === null || tokens.length === 0 || tokens[0]?.kind !== 'dictOpen') return null;
  const parsed = parsePdfDictionary(tokens, 0);
  if (parsed === null || parsed.next !== tokens.length) return null;
  return parsed.value;
}

function parsePdfObjects(bytes: Buffer): PdfObjectMap | null {
  const latin = bytes.toString('latin1');
  const objects: PdfObjectMap = new Map();
  let streamCount = 0;
  const objectPattern = /(?:^|[\r\n\t\f\v ])(\d+)\s+(\d+)\s+obj(?=[\s/<[])/g;
  let cursor = 0;
  for (;;) {
    objectPattern.lastIndex = cursor;
    const match = objectPattern.exec(latin);
    if (match === null) break;
    const id = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isInteger(id) || id <= 0 || objects.has(id) || objects.size >= PDF_MAX_OBJECTS) return null;
    const objectStart = match.index + match[0].length;
    const objectEnd = latin.indexOf('endobj', objectStart);
    if (objectEnd < 0) return null;

    const streamStart = latin.indexOf('stream', objectStart);
    const hasStream = streamStart >= 0 && streamStart < objectEnd;
    let dictionary: PdfDictionary | null;
    let stream: Buffer | null = null;
    if (!hasStream) {
      dictionary = parsePdfObjectDictionary(latin.slice(objectStart, objectEnd));
      if (dictionary === null) return null;
      cursor = objectEnd + 'endobj'.length;
    } else {
      let dataStart = streamStart + 'stream'.length;
      if (latin[dataStart] === '\r') dataStart += 1;
      if (latin[dataStart] === '\n') dataStart += 1;
      const dataEnd = latin.indexOf('endstream', dataStart);
      if (dataEnd < 0 || dataEnd > objectEnd) return null;
      const endObject = latin.indexOf('endobj', dataEnd);
      if (endObject !== objectEnd) return null;
      dictionary = parsePdfObjectDictionary(latin.slice(objectStart, streamStart));
      if (dictionary === null) return null;
      stream = Buffer.from(latin.slice(dataStart, dataEnd), 'latin1');
      streamCount += 1;
      if (streamCount > PDF_MAX_STREAMS) return null;
      cursor = endObject + 'endobj'.length;
    }

    // Object streams and cross-reference streams require a full PDF parser that
    // this intentionally conservative verifier deliberately does not implement.
    const typeName = dictionary.get('Type');
    if (typeName?.kind === 'name' && /^(?:ObjStm|XRef)$/.test(typeName.value)) return null;
  if (/\/Type\s*\/[^\s]*#/.test(latin.slice(objectStart, hasStream ? streamStart : objectEnd))) {
    return null;
  }
    objects.set(id, { id, dictionary, stream });
  }
  const result = objects.size > 0 ? objects : null;
  return result;
}

function parseTrailerRoot(bytes: Buffer): number | null {
  const latin = bytes.toString('latin1');
  const trailerPattern = /(?:^|[\r\n\t\f\v ])trailer(?=\s)/g;
  let rootId: number | null = null;
  let trailerCount = 0;
  for (let match = trailerPattern.exec(latin); match !== null; match = trailerPattern.exec(latin)) {
    trailerCount += 1;
    if (trailerCount > 1) return null;
    const tokens = lexPdfTokens(latin.slice(match.index + match[0].length));
    if (tokens === null || tokens[0]?.kind !== 'dictOpen') return null;
    const parsed = parsePdfDictionary(tokens, 0);
    if (parsed === null) return null;
    const root = parsed.value.get('Root');
    if (root?.kind !== 'reference') return null;
    rootId = root.id;
  }
  return trailerCount === 1 ? rootId : null;
}

function pdfHeaderOffset(bytes: Buffer): number | null {
  // PDF permits up to 1024 bytes before its header.
  const index = bytes.indexOf('%PDF-');
  return index >= 0 && index <= 1023 ? index : null;
}

function parsePdfDocument(bytes: Buffer): { objects: PdfObjectMap; rootId: number } | null {
  const offset = pdfHeaderOffset(bytes);
  if (offset === null) return null;
  const body = bytes.subarray(offset);
  const objects = parsePdfObjects(body);
  if (objects === null) return null;
  const rootId = parseTrailerRoot(body);
  if (rootId === null || !objects.has(rootId)) return null;
  const root = objects.get(rootId)!;
  const type = root.dictionary.get('Type');
  if (type?.kind !== 'name' || type.value !== 'Catalog') return null;
  const catalogs = [...objects.values()].filter((object) => {
    const objectType = object.dictionary.get('Type');
    return objectType?.kind === 'name' && objectType.value === 'Catalog';
  });
  return catalogs.length === 1 && objects.has(rootId) ? { objects, rootId } : null;
}

function dictionaryValue(dictionary: PdfDictionary, key: string): PdfValue | null {
  return dictionary.get(key) ?? null;
}

function directDictionaryName(dictionary: PdfDictionary, key: string): string | null {
  const value = dictionaryValue(dictionary, key);
  if (value?.kind !== 'name' || !/^[A-Za-z0-9]+$/.test(value.value)) return null;
  return value.value;
}

function directDictionaryReference(dictionary: PdfDictionary, key: string): number | null {
  const value = dictionaryValue(dictionary, key);
  return value?.kind === 'reference' ? value.id : null;
}

function directArrayReferences(dictionary: PdfDictionary, key: string, max: number): Array<number> | null {
  const value = dictionaryValue(dictionary, key);
  if (value?.kind !== 'array' || value.values.length > max) return null;
  const ids: number[] = [];
  for (const member of value.values) {
    if (member.kind !== 'reference') return null;
    ids.push(member.id);
  }
  return ids;
}

function directNumber(dictionary: PdfDictionary, key: string): number | null {
  const value = dictionaryValue(dictionary, key);
  if (value?.kind !== 'number') return null;
  const parsed = Number.parseFloat(value.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function directMediaBox(dictionary: PdfDictionary): Array<number> | null {
  const value = dictionaryValue(dictionary, 'MediaBox');
  if (value?.kind !== 'array' || value.values.length !== 4) return null;
  const numbers = value.values.map((entry) => entry.kind === 'number' ? Number.parseFloat(entry.value) : Number.NaN);
  if (numbers.some((entry) => !Number.isFinite(entry)) || numbers[0]! > numbers[2]! || numbers[1]! > numbers[3]!) {
    return null;
  }
  return numbers as Array<number>;
}

function pageMediaBox(page: ParsedPdfObject, objects: PdfObjectMap): Array<number> | null {
  let current: ParsedPdfObject | undefined = page;
  const visited = new Set<number>();
  for (let depth = 0; current !== undefined && depth < 32; depth += 1) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const box = directMediaBox(current.dictionary);
    if (box !== null) return box;
    const parentId = directDictionaryReference(current.dictionary, 'Parent');
    if (parentId === null) return null;
    current = objects.get(parentId);
  }
  return null;
}

function decodePdfStream(
  object: ParsedPdfObject,
  budget: PdfDecodeBudget
): { state: 'text' | 'indeterminate'; text: string } {
  if (budget.exhausted) return { state: 'indeterminate', text: '' };
  // Any parameters/predictor means this verifier cannot know the decoded bytes.
  if (object.dictionary.has('DecodeParms') || object.dictionary.has('Predictor')) {
    return { state: 'indeterminate', text: '' };
  }
  const data = object.stream;
  if (data === null || data.length > PDF_MAX_STREAM_OUTPUT_BYTES) {
    budget.exhausted = true;
    return { state: 'indeterminate', text: '' };
  }
  const filter = object.dictionary.get('Filter');
  // Filter arrays are rejected even when their sole member is supported.
  if (filter === undefined) {
    const text = data.toString('latin1');
    budget.decodedBytes += text.length;
    if (budget.decodedBytes > PDF_MAX_TOTAL_DECODED_BYTES) budget.exhausted = true;
    return { state: 'text', text };
  }
  if (filter.kind !== 'name' || filter.value !== 'FlateDecode') return { state: 'indeterminate', text: '' };
  try {
    const inflated = inflateSync(data, { maxOutputLength: PDF_MAX_STREAM_OUTPUT_BYTES });
    if (inflated.length > PDF_MAX_STREAM_OUTPUT_BYTES
      || budget.decodedBytes + inflated.length > PDF_MAX_TOTAL_DECODED_BYTES) {
      budget.exhausted = true;
      return { state: 'indeterminate', text: '' };
    }
    budget.decodedBytes += inflated.length;
    return { state: 'text', text: inflated.toString('latin1') };
  } catch {
    try {
      const inflated = inflateRawSync(data, { maxOutputLength: PDF_MAX_STREAM_OUTPUT_BYTES });
      if (inflated.length > PDF_MAX_STREAM_OUTPUT_BYTES
        || budget.decodedBytes + inflated.length > PDF_MAX_TOTAL_DECODED_BYTES) {
        return { state: 'indeterminate', text: '' };
      }
      budget.decodedBytes += inflated.length;
      return { state: 'text', text: inflated.toString('latin1') };
    } catch {
      return { state: 'indeterminate', text: '' };
    }
  }
}

function resolvePageResources(
  page: ParsedPdfObject,
  objects: PdfObjectMap
): { valid: true; dictionary: PdfDictionary | null } | { valid: false } {
  let current: ParsedPdfObject | undefined = page;
  const visited = new Set<number>();
  for (let depth = 0; current !== undefined && depth < 32; depth += 1) {
    if (visited.has(current.id)) return { valid: false };
    visited.add(current.id);
    const resourcesValue = dictionaryValue(current.dictionary, 'Resources');
    if (resourcesValue !== null) {
      if (resourcesValue.kind === 'dictionary') return { valid: true, dictionary: resourcesValue.value };
      if (resourcesValue.kind !== 'reference') return { valid: false };
      const resourceObject = objects.get(resourcesValue.id);
      if (resourceObject === undefined || resourceObject.stream !== null) return { valid: false };
      const resources = dictionaryValue(resourceObject.dictionary, 'Resources');
      if (resources?.kind !== 'dictionary') return { valid: false };
      return { valid: true, dictionary: resources.value };
    }
    const parentId = directDictionaryReference(current.dictionary, 'Parent');
    if (parentId === null) return { valid: true, dictionary: null };
    current = objects.get(parentId);
  }
  return { valid: false };
}

function resourceMap(resources: PdfDictionary | null, group: string): Map<string, number> {
  const map = new Map<string, number>();
  if (resources === null) return map;
  const value = dictionaryValue(resources, group);
  if (value?.kind !== 'dictionary') return map;
  for (const [name, member] of value.value) {
    if (member.kind === 'reference') map.set(name, member.id);
  }
  return map;
}

function parsePageContents(
  page: ParsedPdfObject,
  objects: PdfObjectMap,
  budget: PdfDecodeBudget
): string | null {
  const contentsValue = dictionaryValue(page.dictionary, 'Contents');
  let references: Array<number>;
  if (contentsValue?.kind === 'reference') {
    references = [contentsValue.id];
  } else if (contentsValue?.kind === 'array') {
    const bounded = directArrayReferences(page.dictionary, 'Contents', PDF_MAX_CONTENT_REFERENCES);
    if (bounded === null) return null;
    references = bounded;
  } else {
    return null;
  }
  if (references === null || references.length === 0) return null;
  const uniqueIds = [...new Set(references)];
  if (uniqueIds.length > PDF_MAX_CONTENT_REFERENCES) return null;
  const parts: string[] = [];
  for (const id of uniqueIds) {
    const cached = budget.decodedStreams.get(id);
    if (cached !== undefined) {
      parts.push(cached);
      continue;
    }
    const object = objects.get(id);
    if (object === undefined || object.stream === null) return null;
    const decoded = decodePdfStream(object, budget);
    if (decoded.state === 'indeterminate' || budget.exhausted) return null;
    budget.contentBytes += decoded.text.length;
    if (budget.contentBytes > PDF_MAX_CONTENT_BYTES) {
      budget.exhausted = true;
      return null;
    }
    budget.decodedStreams.set(id, decoded.text);
    parts.push(decoded.text);
  }
  return parts.join('\n');
}

function collectPageTree(
  objectId: number,
  objects: PdfObjectMap,
  ancestors: ReadonlySet<number>
): Array<number> | null {
  if (ancestors.has(objectId)) return null;
  const object = objects.get(objectId);
  if (object === undefined || object.stream !== null) return null;
  const typeName = directDictionaryName(object.dictionary, 'Type');
  if (typeName !== 'Page' && typeName !== 'Pages') return null;

  const kids = directArrayReferences(object.dictionary, 'Kids', PDF_MAX_PAGES);
  if (kids === null) return null;
  const count = directNumber(object.dictionary, 'Count');
  if (count === null || !Number.isInteger(count) || count !== kids.length) return null;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(objectId);
  const leaves: number[] = [];
  for (const kidId of kids) {
    const kid = objects.get(kidId);
    if (kid === undefined || kid.stream !== null) return null;
    const kidType = directDictionaryName(kid.dictionary, 'Type');
    if (kidType === 'Page') leaves.push(kidId);
    else if (kidType === 'Pages') {
      const subtree = collectPageTree(kidId, objects, nextAncestors);
      if (subtree === null) return null;
      leaves.push(...subtree);
    } else return null;
    if (leaves.length > PDF_MAX_PAGES) return null;
  }
  return leaves.length === count ? leaves : null;
}

/** Removes `%...end-of-line` comments only when they are outside PDF strings. */
function stripPdfContentComments(content: string): string | null {
  const out: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const character = content[cursor]!;
    if (character === '(') {
      let depth = 1;
      let index = cursor + 1;
      let escaped = false;
      while (index < content.length && depth > 0) {
        const current = content[index]!;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '(') depth += 1;
        else if (current === ')') depth -= 1;
        index += 1;
      }
      if (depth !== 0) return null;
      out.push(content.slice(cursor, index));
      cursor = index;
      continue;
    }
    if (character === '<') {
      const close = content.indexOf('>', cursor + 1);
      if (close < 0) return null;
      out.push(content.slice(cursor, close + 1));
      cursor = close + 1;
      continue;
    }
    if (character === '%') {
      const end = content.slice(cursor).search(/\r\n|\n|\r/);
      if (end < 0) cursor = content.length;
      else cursor += end + (content.slice(cursor + end).startsWith('\r\n') ? 2 : 1);
      continue;
    }
    out.push(character);
    cursor += 1;
  }
  return out.join('');
}

type PdfContentTokenKind = 'name' | 'number' | 'boolean' | 'operator' | 'string' | 'delimiter';
interface PdfContentToken {
  kind: PdfContentTokenKind;
  value: string;
}

function tokenizePdfContent(content: string): Array<PdfContentToken> | null {
  const tokens: Array<PdfContentToken> = [];
  let cursor = 0;
  while (cursor < content.length) {
    const character = content[cursor]!;
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '(') {
      let depth = 1;
      let index = cursor + 1;
      let escaped = false;
      while (index < content.length && depth > 0) {
        const current = content[index]!;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '(') depth += 1;
        else if (current === ')') depth -= 1;
        index += 1;
      }
      if (depth !== 0) return null;
      tokens.push({ kind: 'string', value: '' });
      cursor = index;
      continue;
    }
    if (character === '<') {
      const close = content.indexOf('>', cursor + 1);
      if (close < 0) return null;
      if (!/^[0-9A-Fa-f\s]*$/.test(content.slice(cursor + 1, close))) return null;
      tokens.push({ kind: 'string', value: '' });
      cursor = close + 1;
      continue;
    }
    if (character === '[' || character === ']') {
      tokens.push({ kind: 'delimiter', value: character });
      cursor += 1;
      continue;
    }
    if (character === '/') {
      let index = cursor + 1;
      while (index < content.length && !/[\s/<>\[\](){}]/.test(content[index] ?? '')) index += 1;
      if (index === cursor + 1) return null;
      tokens.push({ kind: 'name', value: content.slice(cursor + 1, index) });
      cursor = index;
      continue;
    }
    let index = cursor;
    while (index < content.length && !/[\s/<>\[\](){}]/.test(content[index] ?? '')) index += 1;
    if (index === cursor) return null;
    const value = content.slice(cursor, index);
    tokens.push({
      kind: /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? 'number'
        : /^(?:true|false)$/.test(value) ? 'boolean'
        : 'operator',
      value
    });
    cursor = index;
  }
  return tokens;
}

function matrixIsIdentity(values: Array<PdfContentToken>): boolean {
  if (values.length !== 6) return false;
  const numbers = values.map((entry) => Number.parseFloat(entry.value));
  return values.every((entry) => entry.kind === 'number') && numbers.every((entry) => Number.isFinite(entry))
    && numbers[0] === 1 && numbers[1] === 0 && numbers[2] === 0 && numbers[3] === 1;
}

function isSimpleTextContent(content: string, mediaBox: Array<number>): boolean {
  const safeOperators = new Set([
    'BT', 'ET', 'Tf', 'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"',
    'g', 'rg', 'k', 'Tr', 'Do'
  ]);
  const tokens = tokenizePdfContent(content);
  if (tokens === null) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'operator') continue;
    if (!safeOperators.has(token.value)) return false;
    const previous = (count: number) => tokens.slice(Math.max(0, index - count), index);

    if (token.value === 'Tf') {
      const size = tokens[index - 1];
      if (size === undefined || size.kind !== 'number') return false;
      const parsed = Number.parseFloat(size.value);
      if (!Number.isFinite(parsed) || parsed < PDF_MIN_FONT_SIZE) return false;
    }
    if (token.value === 'Td' || token.value === 'TD') {
      const operands = previous(2);
      if (operands.length !== 2 || operands.some((entry) => entry.kind !== 'number')) return false;
      const x = Number.parseFloat(operands[0]!.value);
      const y = Number.parseFloat(operands[1]!.value);
      if (x < mediaBox[0]! || x > mediaBox[2]! || y < mediaBox[1]! || y > mediaBox[3]!) return false;
    }
    if (token.value === 'Tm') {
      const operands = previous(6);
      if (!matrixIsIdentity(operands)) return false;
      const x = Number.parseFloat(operands[4]!.value);
      const y = Number.parseFloat(operands[5]!.value);
      if (x < mediaBox[0]! || x > mediaBox[2]! || y < mediaBox[1]! || y > mediaBox[3]!) return false;
    }
    if (token.value === 'Tr') {
      const mode = tokens[index - 1];
      if (mode === undefined || mode.kind !== 'number'
        || !/^[+-]?\d+$/.test(mode.value) || Number.parseInt(mode.value, 10) !== 0) return false;
    }
    if (token.value === 'g') {
      const values = previous(1);
      if (values.length !== 1 || values.some((entry) => entry.kind !== 'number')) return false;
      if (Number.parseFloat(values[0]!.value) >= 0.95) return false;
    }
    if (token.value === 'rg') {
      const values = previous(3);
      if (values.length !== 3 || values.some((entry) => entry.kind !== 'number')) return false;
      if (values.every((entry) => Number.parseFloat(entry.value) >= 0.95)) return false;
    }
    if (token.value === 'k') {
      const values = previous(4);
      if (values.length !== 4 || values.some((entry) => entry.kind !== 'number')) return false;
      if (values.every((entry) => Number.parseFloat(entry.value) <= 0.05)) return false;
    }
  }
  return true;
}

/**
 * G5/G7: only the trailer /Root Catalog and its Catalog→Pages→Kids tree
 * participate. Only referenced /Contents streams are decoded. Simple,
 * visibly readable text pages can be automatic; opaque structure, images,
 * OCR layers, clipping/shading and budget problems are fail-closed.
 */
export function inspectPdfTextLayers(bytes: Buffer): PdfTextLayerPage[] {
  const indeterminate: PdfTextLayerPage[] = [{ state: 'indeterminate', text: '' }];
  if (pdfHeaderOffset(bytes) === null) return [];
  const document = parsePdfDocument(bytes);
  if (document === null) return indeterminate;
  const catalog = document.objects.get(document.rootId)!;
  const pagesId = directDictionaryReference(catalog.dictionary, 'Pages');
  if (pagesId === null) return indeterminate;
  const pageIds = collectPageTree(pagesId, document.objects, new Set());
  if (pageIds === null || pageIds.length === 0) return indeterminate;

  const budget: PdfDecodeBudget = {
    decodedBytes: 0,
    contentBytes: 0,
    exhausted: false,
    decodedStreams: new Map()
  };
  const pages: PdfTextLayerPage[] = [];
  for (const pageId of pageIds) {
    const page = document.objects.get(pageId)!;
    const mediaBox = pageMediaBox(page, document.objects);
    if (mediaBox === null) return indeterminate;
    const rawContent = parsePageContents(page, document.objects, budget);
    if (rawContent === null || budget.exhausted) return indeterminate;
    const cleanContent = stripPdfContentComments(rawContent);
    if (cleanContent === null || !isSimpleTextContent(cleanContent, mediaBox)) return indeterminate;

    const text = extractPdfContentText(cleanContent);
    const usedFonts = [...cleanContent.matchAll(/\/([^\s/<>\[\](){}]+)\s+(?:[\d.]+\s+)?Tf(?=\s|$)/g)]
      .map((match) => match[1] ?? '');
    const imageNames = [...cleanContent.matchAll(/\/([^\s/<>\[\](){}]+)\s+Do(?=\s|$)/g)]
      .map((match) => match[1] ?? '');

    let resources: PdfDictionary | null = null;
    if (usedFonts.length > 0 || imageNames.length > 0) {
      const resolution = resolvePageResources(page, document.objects);
      if (!resolution.valid) return indeterminate;
      resources = resolution.dictionary;
    }

    if (usedFonts.length > 0) {
      const fonts = resourceMap(resources, 'Font');
      const validFonts = usedFonts.every((name) => {
        const id = fonts.get(name);
        const font = id === undefined ? undefined : document.objects.get(id);
        return font !== undefined && font.stream === null
          && directDictionaryName(font.dictionary, 'Type') === 'Font';
      });
      if (!validFonts) return indeterminate;
    }

    let hasImage = false;
    if (imageNames.length > 0) {
      const xobjects = resourceMap(resources, 'XObject');
      hasImage = imageNames.every((name) => {
        const id = xobjects.get(name);
        const xobject = id === undefined ? undefined : document.objects.get(id);
        return xobject !== undefined && xobject.stream !== null
          && directDictionaryName(xobject.dictionary, 'Subtype') === 'Image';
      });
      if (!hasImage) return indeterminate;
    }

    if (hasImage && text.trim().length > 0) pages.push({ state: 'ocr', text });
    else if (hasImage) pages.push({ state: 'scan', text: '' });
    else if (text.trim().length > 0) pages.push({ state: 'text', text });
    else pages.push({ state: 'scan', text: '' });
  }
  return pages;
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
 * Case is normalized. Code constituents are ASCII letters, digits and hyphens;
 * therefore FSO-1 never satisfies FSO-10, FSO-1_2, FSO-1.5 or FSO-1。
 */
export function hasNormalizedToken(text: string, token: string): boolean {
  const normalizedToken = token.trim().toUpperCase();
  if (normalizedToken.length === 0) return false;
  const haystack = text.toUpperCase();
  // Dot, underscore and full-width period consistently block a partial match;
  // hyphen can be an internal code constituent.
  const isCodeNeighbor = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9_.\u3002-]/.test(character);
  let index = haystack.indexOf(normalizedToken);
  while (index >= 0) {
    const before = index === 0 ? undefined : haystack[index - 1];
    const after = index + normalizedToken.length >= haystack.length
      ? undefined
      : haystack[index + normalizedToken.length];
    if (!isCodeNeighbor(before) && !isCodeNeighbor(after)) return true;
    index = haystack.indexOf(normalizedToken, index + 1);
  }
  return false;
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
  // OCR layers and transparent text can hide a different image below the words.
  | 'PDF_OCR_TEXT_REQUIRES_HUMAN'
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
      /**
       * P4 N2: the send time the evaluation judged by — the EML Date original
       * value (seconds included) when it parsed and agreed with the recorded
       * sentAt within the skew tolerance; the recorded sentAt when it already
       * falls inside the header's own second, or when there is no usable header.
       */
      effectiveSentAt: Date;
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
      /**
       * P4 N2: the send time the evaluation judged by — the EML Date original
       * value (seconds included) when it parsed and agreed with the recorded
       * sentAt within the skew tolerance; the recorded sentAt when it already
       * falls inside the header's own second, or when there is no usable header.
       */
      effectiveSentAt: Date;
      attachmentHashes: string[];
      matchedAttachmentHashes: string[];
    };

/** Milliseconds since the epoch, cut to the whole second (a Date header's resolution). */
function floorToSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000;
}

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
  PDF_OCR_TEXT_REQUIRES_HUMAN: '画像の上に文字層または透明文字があるため、OCR層の可能性があります。人が原本PDFを確認してください',
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
      effectiveSentAt: input.sentAt,
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
  // P4 N2: the time the send is judged by. A form that copies the Date header
  // into minute-precision inputs drops the seconds (Date 00:10:49 → sentAt
  // 00:10:00), and the strict approval comparison below then calls a send made
  // seconds after the approval "before the approval". When the message carries
  // a parsable Date that agrees with the recorded sentAt (the skew check just
  // below), that original header value — seconds included — is the stronger
  // record and is what the plausibility check and the stored event use. A
  // recorded sentAt inside the header's own second already says the same thing
  // (more precisely) and is kept.
  let effectiveSentAt: Date = input.sentAt;
  if (eml.date !== null) {
    const skew = Math.abs(eml.date.getTime() - input.sentAt.getTime());
    if (skew <= MAKER_PO_EML_DATE_SKEW_TOLERANCE_MS && floorToSecond(input.sentAt) !== eml.date.getTime()) {
      effectiveSentAt = eml.date;
    }
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
  // P4 N2: judged by the EML Date original value when it was accepted above.
  // M10 keeps zero tolerance and the comparison stays exact (fail closed): a
  // header that names the approval's own second reads as that second's start,
  // so a send inside it still goes to the representative's manual check.
  if (input.ceoApprovedAt !== null && effectiveSentAt.getTime() < input.ceoApprovedAt.getTime()) {
    fail(
      'SENT_AT_PRECEDES_CEO_APPROVAL',
      'sent_at_plausibility',
      `sentAt=${effectiveSentAt.toISOString()} ceoApprovedAt=${input.ceoApprovedAt.toISOString()}`
    );
  } else {
    checks.push(check(
      'sent_at_plausibility',
      'passed',
      effectiveSentAt === input.sentAt ? null : `emlDate=${effectiveSentAt.toISOString()}`
    ));
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
  const isDeclaredPdf = (attachment: EmlAttachment): boolean =>
    attachment.contentType?.toLowerCase() === 'application/pdf'
    || attachment.filename?.toLowerCase().endsWith('.pdf') === true;
  if (matchedAttachments.length > 0) {
    const matchedPdfs = matchedAttachments.filter(isDeclaredPdf);
    const pdfPages = matchedPdfs.flatMap((attachment) => inspectPdfTextLayers(attachment.bytes));
    const hasIndeterminateLayer = pdfPages.some((page) => page.state === 'indeterminate');
    const hasScanLayer = pdfPages.some((page) => page.state === 'scan');
    const hasOcrLayer = pdfPages.some((page) => page.state === 'ocr');
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
    if (hasOcrLayer) {
      checks.push(check('code_consistency', 'failed', 'transparent text or text over an image'));
      pendingCodes.push('PDF_OCR_TEXT_REQUIRES_HUMAN');
    }
    if (textLayers.length > 0 && mismatchedPages.length > 0) {
      checks.push(check(
        'code_consistency',
        'failed',
        `page(s) ${mismatchedPages.map(({ index }) => index + 1).join(',')}; required=${requiredCodes.join(',')}`
      ));
      pendingCodes.push('EVIDENCE_CODE_MISMATCH');
    }
    if (pdfPages.length > 0 && !hasScanLayer && !hasIndeterminateLayer && !hasOcrLayer
      && textLayers.length > 0 && mismatchedPages.length === 0) {
      checks.push(check('code_consistency', 'passed', requiredCodes.join(',')));
    }
    if (pdfPages.length === 0) {
      checks.push(check(
        'code_consistency',
        matchedPdfs.length > 0 ? 'failed' : 'skipped',
        matchedPdfs.length > 0
          ? 'a declared PDF could not be safely parsed: human verification required'
          : 'no PDF attachment'
      ));
      if (matchedPdfs.length > 0) pendingCodes.push('PDF_TEXT_LAYER_INDETERMINATE');
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
    effectiveSentAt,
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
