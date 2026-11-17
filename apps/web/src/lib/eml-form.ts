/**
 * Browser-side defaults for the maker-PO manual-send form.
 *
 * The API still validates the whole EML after upload; these helpers only read
 * the two harmless header values the operator should not have to retype. They
 * are deliberately separate from @kanei/core because the core parser uses
 * Node's crypto and the browser form only needs Date and From.
 */

export interface EmlFormDefaults {
  /** The EML Date header, formatted for <input type="datetime-local">. */
  sentAt?: string;
  /** The usable mailbox in From, without any display name. */
  senderAddress?: string;
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
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) return null;
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

  return defaults;
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
