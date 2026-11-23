/**
 * P1 R34 (M9): leaving a screen with typed input is asked about first. One
 * registry for the whole page: every form reports whether it holds unsaved
 * input; the page then warns on tab close / reload (beforeunload) and asks
 * before an in-app link moves away (「入力中の内容があります。移動すると消えます」).
 * A successful submit (the form's reset) clears its entry. Client-only; every
 * browser call is guarded so a test or an old browser simply gets no guard.
 */
export const LEAVE_CONFIRM_MESSAGE = '入力中の内容があります。移動すると消えます。移動しますか？';

const dirtyForms = new Set<object>();


export function hasUnsavedInput(): boolean {
  return dirtyForms.size > 0;
}

export function markDirty(form: object, dirty: boolean): void {
  if (dirty) dirtyForms.add(form);
  else dirtyForms.delete(form);
}

/** After the operator chose to leave anyway, nothing is held any more. */
export function forgetAll(): void {
  dirtyForms.clear();
}

export function forget(form: object): void {
  dirtyForms.delete(form);
}

/**
 * P4 M9 (review H-1): the browser's 「戻る」 / 「進む」, asked about through the Navigation API's
 * `navigate` event — BEFORE anything changes. A refusal cancels the traversal (`preventDefault`), so the
 * address, the history and the drawn screen stay exactly as they were. The earlier popstate guard had to
 * put the address back with `pushState(history.state, …)` AFTER it changed, and that stored the previous
 * screen's router tree under the typed screen's address (「進む」 then drew another order under the URL).
 * Nothing here ever writes to the history.
 *
 * - Only a `traverse` (back / forward / history jump) is asked about; links are asked by the click guard,
 *   closing and reloading by beforeunload.
 * - A traversal the browser does not let a page cancel (`cancelable: false`: no history-action
 *   activation, or a browser without the API) is NOT asked about — a question that cannot be acted on
 *   would be false. P4 R-1: the typed input then survives only for a form that keeps a draft
 *   (DraftAutosave: the new-order wizard, the old screens' long forms, and — since P4 web2b — every
 *   ActionForm on an order screen, i.e. the step forms). A form without a draft loses it.
 */
export function decideTraverse(
  event: { navigationType: string; cancelable: boolean },
  deps: { hasUnsaved: () => boolean; confirm: (message: string) => boolean; forget: () => void }
): 'allow' | 'cancel' {
  if (event.navigationType !== 'traverse' || !event.cancelable) return 'allow';
  if (!deps.hasUnsaved()) return 'allow';
  if (deps.confirm(LEAVE_CONFIRM_MESSAGE)) {
    deps.forget();
    return 'allow';
  }
  return 'cancel';
}

/** Whether a click on this anchor leaves the page in the same tab (and so may lose input). */
export function isLeavingClick(
  event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean },
  anchor: { href: string; target: string; hasDownload: boolean; hash: string; pathname: string; search: string },
  here: { pathname: string; search: string }
): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.hasDownload || (anchor.target && anchor.target !== '_self')) return false;
  if (!anchor.href || anchor.href.startsWith('javascript:')) return false;
  // A jump inside the same screen (#anchor) keeps the input.
  if (anchor.pathname === here.pathname && anchor.search === here.search && anchor.hash) return false;
  return true;
}

/** The values of a form worth keeping as a draft: named, visible controls only (no hidden keys, files or passwords). */
export function draftValues(controls: ReadonlyArray<{ name: string; type: string; value: string; checked?: boolean }>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const control of controls) {
    if (!control.name || control.name.startsWith('_kanei')) continue;
    if (control.type === 'hidden' || control.type === 'file' || control.type === 'password' || control.type === 'submit') continue;
    if (control.type === 'checkbox' || control.type === 'radio') {
      if (control.checked) values[control.name] = control.value || 'on';
      continue;
    }
    if (control.value !== '') values[control.name] = control.value;
  }
  return values;
}

/** The sessionStorage key of a draft: the screen path and the form's own name (案件・発注・手順 are in the path). */
export function draftKey(pathname: string, formName: string): string {
  return `kanei-draft:${pathname}:${formName}`;
}

/** P4 R-1: an order's own screen, /p/{案件}/o/{発注} (the step forms live here). */
export function isOrderScreenPath(pathname: string): boolean {
  return /^\/p\/[^/]+\/o\/[^/]+\/?$/.test(pathname);
}

/** P4 R-1: the hidden fields that say WHICH record a form is about (not the per-render keys and hashes). */
export const DRAFT_IDENTITY_FIELDS: readonly string[] = ['orderId', 'poId', 'sevenPurchaseOrderId', 'revisionId', 'designKey', 'organization', 'lineId'];

/**
 * P4 R-1: a suffix for a draft name so two forms with the same button on one screen (one per design or
 * organization) keep separate drafts. Pure: built from the identity fields' values only.
 */
export function draftIdentity(controls: ReadonlyArray<{ name: string; value: string }>): string {
  const parts = DRAFT_IDENTITY_FIELDS
    .map((field) => controls.find((control) => control.name === field)?.value ?? '')
    .filter((value) => value !== '');
  return parts.length > 0 ? `#${parts.join('|')}` : '';
}

/** Every draft key of one screen path (ClearDrafts). */
export function draftKeyPrefix(pathname: string): string {
  return `kanei-draft:${pathname}:`;
}

/**
 * p5 R12: when is a draft stale? A form that was SUBMITTED and not refused succeeded — its draft must go. The form's own `reset`
 * event drops it, but a successful submit re-draws the screen (the step panel is keyed by the order's progress), and the old form
 * can be unmounted before its reset runs: the draft then outlived the record and came back as 「前回の入力を復元しました」 on the
 * next form of the same name. The lifecycle remembers the submit and the refusal, so the unmount can finish the job.
 */
export function draftLifecycle(): { submitted(): void; refused(): void; reset(): void; dropOnUnmount(): boolean } {
  let submittedWithoutRefusal = false;
  return {
    submitted: () => { submittedWithoutRefusal = true; },
    refused: () => { submittedWithoutRefusal = false; },
    reset: () => { submittedWithoutRefusal = false; },
    dropOnUnmount: () => submittedWithoutRefusal
  };
}
