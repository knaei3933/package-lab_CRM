/**
 * UI batch C (1-①, 1-③): client-side form checks in operator Japanese.
 *
 * The browser's built-in bubbles speak the OS language and vanish on the next
 * click, so the forms turn native validation off once hydrated (noValidate) and
 * show these messages under each field instead. Everything here is pure: the
 * form shell reads `element.validity` and passes it in. The server actions keep
 * validating every request; this only saves a round trip.
 */

/** The subset of ValidityState the messages read (all flags optional for tests). */
export interface ValidityLike {
  valid?: boolean;
  valueMissing?: boolean;
  typeMismatch?: boolean;
  patternMismatch?: boolean;
  tooShort?: boolean;
  tooLong?: boolean;
  rangeUnderflow?: boolean;
  rangeOverflow?: boolean;
  stepMismatch?: boolean;
  badInput?: boolean;
  customError?: boolean;
}

export type ControlKind = 'text' | 'select' | 'file' | 'checkbox' | 'radio' | 'number' | 'email' | 'url';

export interface ControlInfo {
  kind?: ControlKind | undefined;
  /** How the value should look, e.g. 「2026/11/18 の形」 (data-feedback-format on the control). */
  formatHint?: string | undefined;
  /** The control's own setCustomValidity text, used for customError. */
  customMessage?: string | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  min?: string | undefined;
  max?: string | undefined;
}

/** The message for one invalid control, or null when the control is valid. */
export function validationMessage(validity: ValidityLike, label: string, control: ControlInfo = {}): string | null {
  const kind = control.kind ?? 'text';
  if (validity.valueMissing) {
    if (kind === 'select' || kind === 'radio') return `${label}を選択してください。`;
    if (kind === 'file') return `${label}：ファイルを選んでください。`;
    if (kind === 'checkbox') return `「${label}」にチェックを入れてください。`;
    return `${label}を入力してください。`;
  }
  if (validity.customError) {
    const custom = control.customMessage?.trim() ?? '';
    return custom.length > 0 ? custom : `${label}の入力内容を確認してください。`;
  }
  if (validity.badInput) return kind === 'number' ? `${label}は数値で入力してください。` : `${label}の入力内容を確認してください。`;
  if (validity.typeMismatch) {
    if (kind === 'email') return `${label}はメールアドレスの形（例 name@example.jp）で入力してください。`;
    if (kind === 'url') return `${label}はURLの形（例 https://example.jp）で入力してください。`;
    return `${label}の形式が正しくありません。`;
  }
  if (validity.patternMismatch) {
    return control.formatHint ? `${label}は${control.formatHint}で入力してください。` : `${label}の形式が正しくありません。`;
  }
  if (validity.tooShort) {
    return control.minLength ? `${label}は${control.minLength}文字以上で入力してください。` : `${label}が短すぎます。`;
  }
  if (validity.tooLong) {
    return control.maxLength ? `${label}は${control.maxLength}文字以内で入力してください。` : `${label}が長すぎます。`;
  }
  if (validity.rangeUnderflow) return control.min ? `${label}は${control.min}以上で入力してください。` : `${label}が小さすぎます。`;
  if (validity.rangeOverflow) return control.max ? `${label}は${control.max}以下で入力してください。` : `${label}が大きすぎます。`;
  if (validity.stepMismatch) return `${label}の値の刻みが正しくありません。`;
  return null;
}

/** The line next to the submit button when the client check stopped a submit. */
export function formErrorSummary(count: number): string {
  return count > 0 ? `入力内容を確認してください（${count}件）。` : '';
}

/** Strips the 「（必須）」-style suffix a visible label may carry. */
export function plainLabel(text: string): string {
  return text.replace(/（必須[^）]*）/g, '').trim();
}

/** A form control as the shell sees it, without the DOM (the tests feed plain objects). */
export interface ControlDescriptor {
  /** data-feedback-name, else the posted name; '' when the control has neither. */
  key: string;
  /** input type="hidden": never validated, never focused. */
  hidden: boolean;
  disabled: boolean;
  willValidate: boolean;
  validity: ValidityLike;
  label: string;
  info: ControlInfo;
}

export interface InvalidSubmitPlan {
  /** Field key → message, one per key (the first invalid control of a key wins). */
  errors: Record<string, string>;
  count: number;
  /** Index (in the given list) of the control that takes focus, or null when nothing is invalid. */
  focusIndex: number | null;
}

/**
 * Which controls stop a submit, their messages and where focus goes. Hidden,
 * disabled and non-validating controls are skipped; two inputs of one field
 * (the date + time pair) count once.
 */
export function planInvalidSubmit(controls: readonly ControlDescriptor[]): InvalidSubmitPlan {
  const errors: Record<string, string> = {};
  let focusIndex: number | null = null;
  controls.forEach((control, index) => {
    if (control.hidden || control.disabled || !control.willValidate || control.validity.valid) return;
    const key = control.key || `__control${index}`;
    if (key in errors) return;
    const message = validationMessage(control.validity, control.label, control.info);
    if (message === null) return;
    errors[key] = message;
    if (focusIndex === null) focusIndex = index;
  });
  return { errors, count: Object.keys(errors).length, focusIndex };
}

/** The first control of a field that can take focus (not hidden, not disabled), or null. */
export function focusableIndexFor(
  controls: ReadonlyArray<Pick<ControlDescriptor, 'key' | 'hidden' | 'disabled'>>,
  key: string
): number | null {
  const index = controls.findIndex((control) => control.key === key && !control.hidden && !control.disabled);
  return index >= 0 ? index : null;
}

const FULL_WIDTH_DIGITS = /[０-９]/g;

/**
 * A quantity as the server expects it (ASCII digits, optional decimals):
 * surrounding spaces are dropped and IME full-width digits / point become
 * ASCII. Anything else is left for the pattern check to explain.
 */
export function normalizeQuantityText(text: string): string {
  return text
    .trim()
    .replace(FULL_WIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.');
}

/** Where a picked file stands: being read, read into the hidden field, or unreadable. */
export type FileReadState = 'idle' | 'reading' | 'read' | 'failed';

export const FILE_READING_MESSAGE = 'ファイルを読み込み中です…';
export const FILE_READ_FAILED_MESSAGE = 'ファイルを読み取れませんでした。別のファイルを試してください。';

/** The file field's custom error for a read state: a submit is held while reading and refused after a failure. */
export function fileReadIssue(state: FileReadState): string | null {
  if (state === 'reading') return FILE_READING_MESSAGE;
  if (state === 'failed') return FILE_READ_FAILED_MESSAGE;
  return null;
}

/** 'ignore': a submit while the previous one is still running (the button is aria-disabled, not disabled). */
export type SubmitDecision = 'invalid' | 'confirm' | 'submit' | 'ignore';

/**
 * The submit → check → confirm → dispatch-once sequence, without the DOM.
 *
 * - idle + invalid fields → 'invalid' (the shell shows the field errors).
 * - idle + a confirm dialog → 'confirm' (the dialog opens).
 * - idle + nothing to ask → 'submit' (the shell dispatches the action).
 * - confirm() is true exactly once per opened dialog and returns the gate to
 *   idle, so the shell dispatches once and the next submit asks again (a
 *   double click on the confirm button dispatches nothing more).
 * - cancel() drops a pending confirmation.
 * - while the server action runs (pending) every submit is 'ignore': the
 *   button stays focusable (aria-disabled) and nothing is dispatched.
 *
 * After hydration the shell prevents every native submit and dispatches the
 * action itself (form-feedback.tsx), so none of these decisions depends on
 * React's own form-action handling.
 */
export interface SubmitGate {
  readonly state: 'idle' | 'confirming';
  submit(input: { invalid: boolean; needsConfirm: boolean; pending?: boolean | undefined }): SubmitDecision;
  confirm(): boolean;
  cancel(): void;
}

export function createSubmitGate(): SubmitGate {
  let state: SubmitGate['state'] = 'idle';
  return {
    get state() {
      return state;
    },
    submit({ invalid, needsConfirm, pending }) {
      if (pending) return 'ignore';
      if (invalid) {
        state = 'idle';
        return 'invalid';
      }
      if (needsConfirm) {
        state = 'confirming';
        return 'confirm';
      }
      state = 'idle';
      return 'submit';
    },
    confirm() {
      if (state !== 'confirming') return false;
      state = 'idle';
      return true;
    },
    cancel() {
      if (state === 'confirming') state = 'idle';
    }
  };
}

/**
 * Review H1: whether the form shell resets the form after this action result.
 * Only a success resets (once per result object); a refusal keeps every value
 * the operator entered — dates, selects, the picked file — for the retry.
 */
export function shouldResetAfterResult(
  state: { ok: boolean } | null,
  alreadyReset: { ok: boolean } | null
): boolean {
  return state !== null && state.ok === true && state !== alreadyReset;
}
