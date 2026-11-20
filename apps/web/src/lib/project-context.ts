/**
 * P0 R03 (B3): the hidden field every write form carries — the project the
 * screen was drawn for. Client-safe constants; the server check is in
 * lib/project-guard.ts.
 */
export const RENDERED_PROJECT_FIELD = '_kaneiRenderedProjectId';

export const PROJECT_CONTEXT_MISMATCH = 'PROJECT_CONTEXT_MISMATCH';

/**
 * Whether a write may run: the project the form was drawn for must be the
 * project the session cookie names now. A missing field (a form drawn without
 * the context) is refused too — fail closed. '' on both sides (no project) is
 * a match; the action then asks for a project as before.
 */
export function renderedProjectMatches(rendered: unknown, current: string | null): boolean {
  if (typeof rendered !== 'string') return false;
  return rendered === (current ?? '');
}

/**
 * P0 R05 (H7): the per-submit key every write form carries. The server action
 * forwards it as the API's Idempotency-Key, so a repeat of the same submit
 * (double click, a resubmit after a lost answer) is answered with the first
 * result instead of writing twice. A new key is drawn after every result.
 */
export const IDEMPOTENCY_FIELD = '_kaneiIdempotencyKey';

/** The API's own key rule (p0-server idempotency.ts). */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(value);
}

/** A new key (the browser's UUID; a timestamped random fallback without one). */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The key a submit carried, or undefined (absent or malformed keys are not forwarded). */
export function idempotencyKeyOf(formData: FormData): string | undefined {
  const value = formData.get(IDEMPOTENCY_FIELD);
  return isIdempotencyKey(value) ? value : undefined;
}
