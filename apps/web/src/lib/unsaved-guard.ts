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

/** The page's address (null outside a browser). lib/ is also type-checked without the DOM lib. */
function currentHref(): string | null {
  const browser = (globalThis as { window?: { location?: { href?: unknown } } }).window;
  return typeof browser?.location?.href === 'string' ? browser.location.href : null;
}
/** P4 M9: the address the input was typed at — where a refused 「戻る」 puts the operator back. */
let heldHref: string | null = null;

export function hasUnsavedInput(): boolean {
  return dirtyForms.size > 0;
}

export function markDirty(form: object, dirty: boolean): void {
  if (dirty) {
    if (dirtyForms.size === 0) heldHref = currentHref();
    dirtyForms.add(form);
  } else {
    dirtyForms.delete(form);
    if (dirtyForms.size === 0) heldHref = null;
  }
}

/** After the operator chose to leave anyway, nothing is held any more. */
export function forgetAll(): void {
  dirtyForms.clear();
  heldHref = null;
}

export function forget(form: object): void {
  dirtyForms.delete(form);
  if (dirtyForms.size === 0) heldHref = null;
}

/** The address the unsaved input belongs to (null when nothing is held). */
export function heldAddress(): string | null {
  return heldHref;
}

/**
 * P4 M9: the browser's 「戻る」 / 「進む」 (popstate). The address has already changed
 * when it fires, so a refusal puts the held address back (`restore`, a pushState)
 * and tells the caller to stop the event. With nothing typed it never asks.
 */
export function handlePopstate(deps: {
  hasUnsaved: () => boolean;
  confirm: (message: string) => boolean;
  restore: (href: string) => void;
  forget: () => void;
  held: string | null;
}): 'allow' | 'blocked' {
  if (!deps.hasUnsaved()) return 'allow';
  if (deps.confirm(LEAVE_CONFIRM_MESSAGE)) {
    deps.forget();
    return 'allow';
  }
  if (deps.held) deps.restore(deps.held);
  return 'blocked';
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

/** Every draft key of one screen path (ClearDrafts). */
export function draftKeyPrefix(pathname: string): string {
  return `kanei-draft:${pathname}:`;
}
