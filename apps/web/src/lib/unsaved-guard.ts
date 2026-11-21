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
