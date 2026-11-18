/**
 * Browser-side defaults for the maker-PO manual-send form.
 *
 * The API still validates the whole EML after upload; these helpers only read
 * the two harmless header values the operator should not have to retype. They
 * are deliberately separate from @kanei/core because the core parser uses
 * Node's crypto and the browser form only needs Date and From.
 */

import { DATETIME_LOCAL_PATTERN } from './datetime';

export interface EmlFormDefaults {
  /** The EML Date header, formatted for <input type="datetime-local">. */
  sentAt?: string;
  /** The usable mailbox in From, without any display name. */
  senderAddress?: string;
  /** The raw EML Subject header, for the compose-subject helper below. */
  subject?: string;
}

export interface EmlFormValues {
  senderAddress: string;
  sentAt: string;
}

export interface EmlFormEditedFields {
  senderAddress: boolean;
  sentAt: boolean;
}

/** Reads the RFC 822 header block and unfolds continuation lines. */
export function parseEmlHeaders(text: string): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  let current: { name: string; value: string } | null = null;

  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.trim().length === 0) break;
    if ((line.startsWith(' ') || line.startsWith('\t')) && current) {
      current.value = `${current.value} ${line.trim()}`;
      const values = headers[current.name];
      if (values !== undefined && values.length > 0) values[values.length - 1] = current.value;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      current = null;
      continue;
    }
    current = {
      name: line.slice(0, colon).trim().toLowerCase(),
      value: line.slice(colon + 1).trim()
    };
    if (headers[current.name] === undefined) headers[current.name] = [];
    headers[current.name]!.push(current.value);
  }

  return headers;
}

/** Reads the mailbox from a simple RFC 5322 address; display names are ignored. */
export function parseEmlFormSender(value: string): string | undefined {
  const angle = /<([^<>]*)>/.exec(value);
  const address = (angle?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address : undefined;
}

/** Formats an instant in the browser's local zone for datetime-local. */
export function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

/** Parses exactly the minute precision accepted by datetime-local. */
export function parseDatetimeLocalValue(value: string): Date | null {
  if (!DATETIME_LOCAL_PATTERN.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A client-side advisory only. The API remains authoritative and repeats this
 * check with the frozen approval time before it can mark a send VERIFIED.
 */
export function isSentAtBeforeCeoApproval(sentAt: string, ceoApprovedAt: string | null | undefined): boolean {
  if (!ceoApprovedAt) return false;
  const sentDate = parseDatetimeLocalValue(sentAt);
  const approvalDate = new Date(ceoApprovedAt);
  if (sentDate === null || Number.isNaN(approvalDate.getTime())) return false;
  return sentDate.getTime() < approvalDate.getTime();
}

/** Extracts the form defaults requested by the operator workflow. */
export function readEmlFormDefaults(text: string): EmlFormDefaults {
  const headers = parseEmlHeaders(text);
  const defaults: EmlFormDefaults = {};
  const rawDate = headers.date?.[0];
  if (rawDate !== undefined) {
    const date = new Date(rawDate);
    if (!Number.isNaN(date.getTime())) defaults.sentAt = toDatetimeLocalValue(date);
  }

  const rawFrom = headers.from?.[0];
  if (rawFrom !== undefined) {
    const senderAddress = parseEmlFormSender(rawFrom);
    if (senderAddress !== undefined) defaults.senderAddress = senderAddress;
  }

  const rawSubject = headers.subject?.[0];
  if (rawSubject !== undefined) defaults.subject = rawSubject;

  return defaults;
}

/**
 * G3: the code the evidence gate checks is inserted at the front of the subject
 * the operator uses outside the CRM. The strict API never repairs or trusts a
 * rewritten EML; this helper gives the manual mail one unambiguous template.
 */
export function makerPoMailSubject(orderCode: string, subject = '製造先発注書'): string {
  const trimmedSubject = subject.trim();
  return hasOrderCodeToken(trimmedSubject, orderCode)
    ? trimmedSubject
    : `${orderCode} ${trimmedSubject}`;
}

/**
 * Token-boundary order-code match with M9 case normalization. Code constituents
 * are ASCII letters, digits and hyphens, so FSO-1 never matches FSO-10,
 * FSO-1_2, FSO-1.5 or FSO-1。
 */
export function hasOrderCodeToken(subject: string, orderCode: string): boolean {
  const normalizedCode = orderCode.trim().toUpperCase();
  if (normalizedCode.length === 0) return false;
  const haystack = subject.toUpperCase();
  // Dot, underscore and full-width period consistently block a partial match;
  // hyphen can be an internal code constituent.
  const isCodeNeighbor = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9_.\u3002-]/.test(character);
  let index = haystack.indexOf(normalizedCode);
  while (index >= 0) {
    const before = index === 0 ? undefined : haystack[index - 1];
    const after = index + normalizedCode.length >= haystack.length
      ? undefined
      : haystack[index + normalizedCode.length];
    if (!isCodeNeighbor(before) && !isCodeNeighbor(after)) return true;
    index = haystack.indexOf(normalizedCode, index + 1);
  }
  return false;
}

export interface MakerPoSubjectEdit {
  eml: string;
  subject: string;
  inserted: boolean;
}

/**
 * G3: edit the EML's actual Subject header before it is submitted. This is a
 * deliberate form action (not an API repair) and preserves the MIME body; only
 * the subject header lines are replaced.
 */
export function insertMakerPoMailSubject(eml: string, orderCode: string): MakerPoSubjectEdit {
  const parsedSubject = parseEmlHeaders(eml).subject?.join(' ') ?? '';
  const subject = makerPoMailSubject(orderCode, parsedSubject || '製造先発注書');
  if (orderCode.length === 0 || hasOrderCodeToken(parsedSubject, orderCode)) {
    return { eml, subject: parsedSubject || subject, inserted: false };
  }
  const lineBreak = eml.includes('\r\n') ? '\r\n' : '\n';
  const lines = eml.split(/\r\n|\n|\r/);
  const subjectIndex = lines.findIndex((line) => /^subject:/i.test(line));
  if (subjectIndex < 0) {
    return { eml, subject, inserted: false };
  }
  let subjectEnd = subjectIndex + 1;
  while (
    subjectEnd < lines.length
    && (lines[subjectEnd]!.startsWith(' ') || lines[subjectEnd]!.startsWith('\t'))
  ) subjectEnd += 1;
  lines.splice(subjectIndex, subjectEnd - subjectIndex, `Subject: ${subject}`);
  return { eml: lines.join(lineBreak), subject, inserted: true };
}

/** Browser-safe UTF-8 Base64 so the edited EML keeps its original text bytes. */
export function utf8TextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Applies a newly selected EML's defaults only to fields the operator has not
 * deliberately edited. Missing values clear stale auto-fills; edited values stay.
 */
export function mergeEmlFormValues(
  current: EmlFormValues,
  edited: EmlFormEditedFields,
  defaults: EmlFormDefaults
): EmlFormValues {
  return {
    senderAddress: edited.senderAddress
      ? current.senderAddress
      : defaults.senderAddress ?? '',
    sentAt: edited.sentAt
      ? current.sentAt
      : defaults.sentAt ?? ''
  };
}
