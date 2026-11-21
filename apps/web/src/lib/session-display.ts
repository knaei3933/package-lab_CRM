/**
 * UI batch A (P1-6): the operator name in the header.
 *
 * GET /api/me answers id and role only, so the header used to print the user
 * UUID. The login answer does carry displayName, and the operator typed the
 * login name, so the login relay remembers that name in a display-only cookie
 * bound to the user id. It is never used for authorization: the session cookie
 * and the API stay the only authority, and a cookie whose id does not match
 * the current session user is ignored (e.g. another account on the same host).
 */
export const DISPLAY_NAME_COOKIE = 'kanei_web_display_name';

const MAX_NAME_LENGTH = 64;

const ROLE_LABELS: Record<string, string> = {
  admin: '代表者',
  staff: '担当者',
  viewer: '閲覧者',
  // P2 P-2: the audit-only role (contract §7).
  auditor: '監査'
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? '閲覧者';
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Control characters never belong in a name shown in the header.
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

/** Cookie value for a successful login, or null when there is nothing to remember. */
export function encodeDisplayNameCookie(userId: unknown, name: unknown): string | null {
  if (typeof userId !== 'string' || userId.length === 0) return null;
  const cleaned = cleanName(name);
  if (!cleaned) return null;
  return encodeURIComponent(JSON.stringify({ id: userId, name: cleaned }));
}

/** The remembered name, only when it belongs to the signed-in user. */
export function decodeDisplayNameCookie(raw: string | null | undefined, userId: string): string | null {
  if (!raw) return null;
  // Next's cookie reader already URI-decodes the value; a raw header value is
  // still encoded. Accept both without decoding twice (a name may contain %).
  const parsed = parseJson(raw) ?? parseJson(safeDecode(raw));
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.id !== userId) return null;
  return cleanName(record.name);
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Lifetime and transport attributes copied from the API's session cookie
 * (Expires / Max-Age / Secure), so the remembered name lives exactly as long
 * as the login and never travels where the session cookie would not.
 */
export function sessionCookieAttributes(sessionSetCookie: string | undefined): string {
  if (!sessionSetCookie) return '';
  const kept: string[] = [];
  for (const part of sessionSetCookie.split(';').slice(1)) {
    const attribute = part.trim();
    const name = attribute.split('=')[0]?.toLowerCase();
    if (name === 'expires' || name === 'max-age' || name === 'secure') kept.push(attribute);
  }
  return kept.map((attribute) => `; ${attribute}`).join('');
}

/**
 * Header name: the API display name, else the remembered login name, else a
 * role-only label. The user UUID is never shown as a name.
 */
export function operatorName(
  user: { role: string; displayName?: string | null | undefined },
  rememberedName: string | null
): string {
  return cleanName(user.displayName) ?? rememberedName ?? `${roleLabel(user.role)}アカウント`;
}
