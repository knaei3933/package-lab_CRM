import { createHash } from 'node:crypto';

export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_BASE_LOCK_MS = 60 * 1000;
export const LOGIN_MAX_LOCK_MS = 60 * 60 * 1000;
export const LOGIN_IP_FAILURE_LIMIT = 10;

export function loginGuardSourceEntity(remoteAddress: string) {
  return `source:${remoteAddress}`;
}

export function loginGuardIdentity(username: string, remoteAddress: string) {
  return createHash('sha256')
    .update(['login_guard_v2', username.trim().toLowerCase(), remoteAddress].join('\0'))
    .digest('hex');
}

export function loginLockDurationMs(failureCount: number) {
  const excess = Math.max(0, failureCount - LOGIN_FAILURE_LIMIT);
  return Math.min(LOGIN_MAX_LOCK_MS, LOGIN_BASE_LOCK_MS * 2 ** excess);
}

export function loginIpDelayDurationMs(failureCount: number) {
  const excess = Math.max(0, failureCount - LOGIN_IP_FAILURE_LIMIT);
  return Math.min(LOGIN_MAX_LOCK_MS, LOGIN_BASE_LOCK_MS * 2 ** excess);
}

interface IpParts {
  version: 4 | 6;
  value: bigint;
}

function parseIpv4(value: string): IpParts | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let output = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    output = (output << 8n) | BigInt(octet);
  }
  return { version: 4, value: output };
}

function parseIpv6(value: string): IpParts | null {
  const bracketed = value.replace(/^\[|\]$/g, '');
  if (!bracketed.includes(':')) return null;
  const separator = bracketed.lastIndexOf('%');
  const raw = separator === -1 ? bracketed : bracketed.slice(0, separator);
  const sections = raw.split('::');
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(':') : [];
  const right = sections.length === 2 && sections[1] ? sections[1].split(':') : [];
  const embeddedV4 = raw.split(':').at(-1);
  const tailV4 = embeddedV4 && embeddedV4.includes('.') ? parseIpv4(embeddedV4) : null;
  const numericSections: bigint[] = [];
  const parseSection = (part: string): bigint | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    return BigInt(parseInt(part, 16));
  };
  for (const part of left) {
    if (part.includes('.')) continue;
    const parsed = parseSection(part);
    if (parsed === null) return null;
    numericSections.push(parsed);
  }
  for (const part of right) {
    if (part.includes('.')) continue;
    const parsed = parseSection(part);
    if (parsed === null) return null;
    numericSections.push(parsed);
  }
  if (tailV4) {
    numericSections.push(tailV4.value >> 16n & 0xffffn);
    numericSections.push(tailV4.value & 0xffffn);
  }
  const missing = sections.length === 2 ? 8 - numericSections.length : 8 - left.length - right.length;
  if (missing < 0 || (sections.length !== 2 && missing !== 0)) return null;
  const all = sections.length === 2
    ? [...numericSections.slice(0, left.length), ...Array.from({ length: missing }, () => 0n), ...numericSections.slice(left.length)]
    : numericSections;
  if (all.length !== 8) return null;
  return { version: 6, value: all.reduce((accumulator, section) => (accumulator << 16n) | section, 0n) };
}

function parseIp(value: string): IpParts | null {
  const candidate = value.trim().replace(/^::ffff:/, '');
  return parseIpv4(candidate) ?? parseIpv6(candidate);
}

export function ipMatchesCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.trim().split('/');
  const prefix = prefixText === undefined ? undefined : Number(prefixText);
  const addressParts = parseIp(address);
  const networkParts = parseIp(network ?? '');
  if (!addressParts || !networkParts || addressParts.version !== networkParts.version) return false;
  const bits = addressParts.version === 4 ? 32 : 128;
  if (prefix === undefined) return addressParts.value === networkParts.value;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return (addressParts.value & mask) === (networkParts.value & mask);
}

export function peerIsTrusted(remoteAddress: string, trustedCidrs: readonly string[]): boolean {
  return trustedCidrs.some((cidr) => ipMatchesCidr(remoteAddress, cidr));
}

export function validateTrustedProxyCidrs(values: readonly string[]): string[] {
  const errors: string[] = [];
  for (const raw of values) {
    const cidr = raw.trim();
    const slashCount = (cidr.match(/\//g) ?? []).length;
    const [network, prefixText] = cidr.split('/');
    const prefix = prefixText === undefined ? NaN : Number(prefixText);
    const bits = network?.includes(':') ? 128 : 32;
    if (!network || slashCount !== 1 || prefixText === '' || !Number.isInteger(prefix)
      || prefix < 1 || prefix > bits) {
      errors.push(`invalid trusted proxy CIDR "${raw}"`);
      continue;
    }
    const parts = network.split('.');
    if (bits === 32 && (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255))) {
      errors.push(`invalid trusted proxy CIDR "${raw}"`);
    }
  }
  return errors;
}

export interface ResolvedClientAddress {
  address: string;
  source: 'forwarded' | 'socket' | 'unknown';
  trustedPeer: boolean;
}

/**
 * XFF is honored only when the socket peer itself is an approved proxy. The
 * first value is the deployment contract: the web relay inserts the browser
 * address at the beginning of that header.
 */
export function resolveClientAddress(input: {
  peerAddress?: string | null;
  forwardedFor?: string | null;
  trustedCidrs: readonly string[];
}): ResolvedClientAddress {
  const peerAddress = input.peerAddress?.trim() || null;
  const trustedPeer = peerAddress !== null && peerIsTrusted(peerAddress, input.trustedCidrs);
  const firstForwarded = input.forwardedFor?.split(',')[0]?.trim();
  if (trustedPeer && firstForwarded) {
    return { address: firstForwarded, source: 'forwarded', trustedPeer };
  }
  return {
    address: peerAddress ?? 'unknown',
    source: peerAddress === null ? 'unknown' : 'socket',
    trustedPeer
  };
}
