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
 * P0 R05 (H7) / review H1: the per-submit key every write form carries. The
 * server action forwards it as the API's Idempotency-Key, so a repeat of the
 * same submit (double click, a resubmit after a lost answer or a timeout) is
 * answered with the first result instead of writing twice. The key is kept
 * until the submit is over — a success, or a refusal the API answered itself
 * (shouldRenewSubmitKey) — and only then a new one is drawn.
 */
export const IDEMPOTENCY_FIELD = '_kaneiIdempotencyKey';

/**
 * P0 review H1: whether the form draws a new key after this result. Yes at the
 * start (no result yet), after a success and after a refusal the API decided
 * (settled). No after a timeout, an unreachable API, a 5xx or a refusal made on
 * the web: the same intent is retried with the same key.
 */
export function shouldRenewSubmitKey(state: { ok: boolean; settled?: boolean | undefined; code?: string | null | undefined } | null): boolean {
  if (state !== null && state.code === 'IDEMPOTENCY_KEY_REUSED') return false;
  return state === null || state.ok || state.settled === true;
}

/**
 * Review NM1: after IDEMPOTENCY_KEY_REUSED (a timed-out submit, then the same key
 * with edited fields) the earlier submit may already be stored. The form locks:
 * no submit goes out — not even with the same key — until the operator has
 * checked the list and pressed 「確認しました」, which starts a new intent with
 * a new key (startNewIntent).
 */
export function locksForKeyReuse(state: { ok: boolean; code?: string | null | undefined } | null): boolean {
  return state !== null && !state.ok && state.code === 'IDEMPOTENCY_KEY_REUSED';
}

/**
 * Review NM1: the form's lock, derived in the same render the result arrives in
 * (no effect gap): locked by a REUSED result until the operator confirmed that
 * very result (startNewIntent remembers it as `confirmedFor`).
 */
export function isKeyReuseLocked<T extends { ok: boolean; code?: string | null | undefined }>(
  state: T | null,
  confirmedFor: T | null
): boolean {
  return locksForKeyReuse(state) && state !== confirmedFor;
}

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
