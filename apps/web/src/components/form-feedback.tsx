'use client';

import '../app/forms.css';
import { createContext, startTransition, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConfirmSummaryItem } from './ConfirmDialog';
import { summaryFieldsFor, summaryValueText } from '../lib/confirm-summary';
import type { SummaryCondition, SummaryControl } from '../lib/confirm-summary';
import { DATE_TEXT_INVALID_MESSAGE, dateTextForDisplay, parseDateText } from '../lib/date-input';
import { displayActionMessage, resolveActionFieldError } from '../lib/form-messages';
import {
  createSubmitGate,
  focusableIndexFor,
  formErrorSummary,
  normalizeQuantityText,
  plainLabel,
  planInvalidSubmit,
  shouldResetAfterResult
} from '../lib/form-validation';
import type { ControlDescriptor, ControlKind } from '../lib/form-validation';
import type { ActionState } from '../lib/types';
import { createSubmitInFlight, SAVED_RECORD_EVENT } from '../lib/saved-record';
import type { SavedRecordDetail } from '../lib/saved-record';
import { awaitsOutcomeCheck, IDEMPOTENCY_FIELD, isKeyReuseLocked, locksForKeyReuse, newIdempotencyKey, PROJECT_CONTEXT_MISMATCH, shouldRenewSubmitKey } from '../lib/project-context';
import { IN_PROGRESS_CODE, KEY_REUSED_CODE, OUTCOME_UNKNOWN_CODE } from '../lib/action-result';
import { IN_PROGRESS_HINT, KEY_REUSED_CHECKED_KO, KEY_REUSED_CHECKED_LABEL, LOGIN_OTHER_TAB_KO, LOGIN_OTHER_TAB_LABEL, OUTCOME_UNKNOWN_CHECKED_KO, OUTCOME_UNKNOWN_CHECKED_LABEL, OUTCOME_UNKNOWN_LINE, RELOAD_KO, RELOAD_LABEL } from '../lib/idempotency-notice';
import { loginHrefFor } from '../lib/return-path';
import { forget as forgetUnsaved, markDirty } from '../lib/unsaved-guard';
import type { LabelledButton } from '../lib/submit-intent';
import { labelOfButton, noteSubmitIntent, resultDetailOf, withdrawSubmitIntent } from '../lib/submit-intent';
import { installUnsavedGuard } from './unsaved-guard-dom';
import { RenderedProjectField, useRenderedContext } from './RenderedContext';

/**
 * UI batch C (1-①, 1-③): the feedback layer every operator form shares.
 *
 * - Field errors: after hydration the form turns native validation off
 *   (noValidate) and its onSubmit reads each control's `validity`, showing an
 *   operator-Japanese message under the field (FormFeedbackContext), a count
 *   next to the button and moving focus to the first problem.
 * - Server refusals keep showing in the result line; when one names a field
 *   (lib/form-messages), that field shows it too and takes focus.
 * - Confirm: a valid submit with a confirm spec is held and a dialog opens;
 *   キャンセル drops it, the confirm button dispatches the held submit once
 *   (same FormData, same pressed button).
 * - Before hydration a form with a confirm spec keeps its submit buttons
 *   disabled (SubmitLock), so no click or Enter can post it past the dialog
 *   (review M1). Forms without one post natively as before.
 *
 * - While the action runs (pending) the submit buttons are aria-disabled, not
 *   disabled, so the focused button keeps focus; the shell ignores submits.
 *
 * The DOM is only read here: which controls stop a submit, the dialog rows and
 * the server-message → field step are pure functions in lib/ (tested there).
 *
 * Review H1: after hydration every submit is default-prevented and the shell
 * dispatches the action itself (startTransition → action(formDataFor(…))).
 * When React 19 runs a form's function action it resets the form afterwards
 * whatever the result (requestFormReset); a default-prevented submit makes
 * react-dom skip the action and that reset (FormActionEventPlugin only
 * records the pending form status). The shell resets the form itself, and
 * only after a successful result — a refusal keeps every entered value.
 * Before hydration none of this runs: the browser validates natively
 * (noValidate is only set once mounted) and the server action handles the
 * submit as a plain POST (`action` stays on the <form> for that).
 */

export type FormTone = 'primary' | 'danger';

/** The serializable confirm spec ActionForm (and the custom forms) accept from server pages. */
export interface ConfirmOptions {
  /** 例「代表承認を記録しますか？」 */
  title: string;
  /** What happens and whether it can be undone. */
  body: string;
  /** Defaults to the submit button's label. */
  confirmLabel?: string | undefined;
  tone?: FormTone | undefined;
  /** Field names whose current values the dialog lists (select → option text, checkbox → はい). */
  summaryFields?: string[] | undefined;
  /**
   * UI batch E (F-08, F-11): fixed rows the dialog lists before the field rows —
   * the facts the decision rests on that are not form fields (発注コード・宛先・
   * 金額・保留の理由…). Computed by the server page; display only.
   */
  facts?: ConfirmSummaryItem[] | undefined;
  /**
   * UI batch E (F-18): a summary field listed only while another control holds
   * one of the given values (e.g. holdReason only when 「進める先」 is ON_HOLD).
   */
  summaryWhen?: Record<string, SummaryCondition> | undefined;
}

interface FormFeedbackValue {
  errors: Readonly<Record<string, string>>;
  summaryCount: number;
  /**
   * Review NM1: the form is locked after IDEMPOTENCY_KEY_REUSED until the operator
   * confirms (startNewIntent draws a new key and unlocks).
   */
  keyReuseLocked?: boolean | undefined;
  /** P2 R05: IDEMPOTENCY_OUTCOME_UNKNOWN came back and the operator has not confirmed the check yet. */
  outcomeCheckPending?: boolean | undefined;
  startNewIntent?: (() => void) | undefined;
  /** Review M1: the form has a confirm spec and is not hydrated yet — its submit buttons stay disabled. */
  submitLocked?: boolean | undefined;
}

export const FormFeedbackContext = createContext<FormFeedbackValue | null>(null);

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isControl(element: Element): element is Control {
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
}

/** The key a control's error is filed under: its feedback name, else its posted name. */
function feedbackKey(element: Element): string {
  if (!(element instanceof HTMLElement)) return '';
  return element.dataset.feedbackName ?? (isControl(element) ? element.name : '');
}

function controlKind(control: Control): ControlKind {
  if (control instanceof HTMLSelectElement) return 'select';
  if (control instanceof HTMLTextAreaElement) return 'text';
  switch (control.type) {
    case 'file':
    case 'checkbox':
    case 'radio':
    case 'number':
    case 'email':
    case 'url':
      return control.type;
    default:
      return 'text';
  }
}

function controlLabel(control: Element): string {
  if (!(control instanceof HTMLElement)) return '入力欄';
  const declared = control.dataset.feedbackLabel ?? control.getAttribute('aria-label');
  if (declared) return plainLabel(declared);
  const label = control.closest('label')?.querySelector('span');
  return label?.textContent ? plainLabel(label.textContent) : '入力欄';
}

function isHiddenInput(element: Element): boolean {
  return element instanceof HTMLInputElement && element.type === 'hidden';
}

/** One form element as the pure validation helpers see it. */
function describeControl(element: Element): ControlDescriptor {
  const control = isControl(element) ? element : null;
  return {
    key: feedbackKey(element),
    hidden: isHiddenInput(element),
    disabled: control ? control.disabled : false,
    willValidate: control ? control.willValidate : false,
    validity: control ? control.validity : { valid: true },
    label: control ? controlLabel(control) : '入力欄',
    info: control
      ? {
          kind: controlKind(control),
          formatHint: control.dataset.feedbackFormat,
          customMessage: control.validationMessage,
          minLength: 'minLength' in control && control.minLength > 0 ? control.minLength : undefined,
          maxLength: 'maxLength' in control && control.maxLength > 0 ? control.maxLength : undefined,
          min: control instanceof HTMLInputElement && control.min ? control.min : undefined,
          max: control instanceof HTMLInputElement && control.max ? control.max : undefined
        }
      : {}
  };
}

/** First focusable control for a feedback key (the visible part of a split date input included). */
function findControl(form: HTMLFormElement, key: string): HTMLElement | null {
  const elements = Array.from(form.elements);
  const index = focusableIndexFor(elements.map(describeControl), key);
  const element = index === null ? null : elements[index];
  return element instanceof HTMLElement ? element : null;
}

/**
 * DateTextField (fields.tsx): spelling 2026/11/18 or 20261118 becomes the
 * submitted YYYY-MM-DD; text that is not a calendar date gets a custom error.
 */
export function normalizeDateTextInput(input: HTMLInputElement): void {
  const raw = input.value.trim();
  const parsed = raw.length > 0 ? parseDateText(raw) : null;
  if (parsed !== null) input.value = parsed;
  input.setCustomValidity(raw.length > 0 && parsed === null ? DATE_TEXT_INVALID_MESSAGE : '');
}

/**
 * A quantity input (data-quantity-text): surrounding spaces and full-width
 * digits are normalized before the pattern is checked, so the server still
 * receives ASCII digits.
 */
export function normalizeQuantityInput(input: HTMLInputElement): void {
  const normalized = normalizeQuantityText(input.value);
  if (normalized !== input.value) input.value = normalized;
}

/** Normalizes the text inputs that have a canonical spelling, then plans the refusal (if any). */
function checkForm(form: HTMLFormElement) {
  for (const element of Array.from(form.querySelectorAll<HTMLInputElement>('input[data-date-text]'))) {
    normalizeDateTextInput(element);
  }
  for (const element of Array.from(form.querySelectorAll<HTMLInputElement>('input[data-quantity-text]'))) {
    normalizeQuantityInput(element);
  }
  const elements = Array.from(form.elements);
  const plan = planInvalidSubmit(elements.map(describeControl));
  const focus = plan.focusIndex === null ? null : elements[plan.focusIndex];
  return { ...plan, focusTarget: focus instanceof HTMLElement ? focus : null };
}

/** One named form control → the plain model its summary row is computed from. */
function summaryControl(form: HTMLFormElement, name: string): SummaryControl {
  const item = form.elements.namedItem(name);
  if (item === null) return { kind: 'missing' };
  if (item instanceof RadioNodeList) {
    const checked = Array.from(item).find((node) => node instanceof HTMLInputElement && node.checked);
    return {
      kind: 'group',
      checked: checked instanceof HTMLInputElement
        ? { type: checked.type, value: checked.value, labelText: checked.closest('label')?.textContent ?? null }
        : null
    };
  }
  if (item instanceof HTMLSelectElement) {
    return { kind: 'select', value: item.value, selectedText: item.selectedOptions[0]?.textContent ?? '' };
  }
  if (item instanceof HTMLInputElement && item.type === 'checkbox') return { kind: 'checkbox', checked: item.checked };
  // UI batch E (F-15): a date field posts YYYY-MM-DD; the dialog reads it back as typed (2026/11/18).
  if (item instanceof HTMLInputElement && item.dataset.dateText !== undefined) {
    return { kind: 'text', value: dateTextForDisplay(item.value.trim()) };
  }
  if (item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement) return { kind: 'text', value: item.value };
  return { kind: 'missing' };
}

/** The current value of a named control ('' when absent; the checked one of a group). */
function controlValue(form: HTMLFormElement, name: string): string {
  const item = form.elements.namedItem(name);
  if (item instanceof RadioNodeList) return item.value;
  if (item instanceof HTMLInputElement && item.type === 'checkbox') return item.checked ? item.value : '';
  if (item instanceof HTMLInputElement || item instanceof HTMLSelectElement || item instanceof HTMLTextAreaElement) return item.value;
  return '';
}

function summaryLabel(form: HTMLFormElement, name: string): string {
  const visible = findControl(form, name);
  if (visible) return controlLabel(visible);
  const item = form.elements.namedItem(name);
  return item instanceof Element ? controlLabel(item) : name;
}

/** The ActionForm summaryFields → dialog rows. */
export function summaryFromFields(form: HTMLFormElement, names: readonly string[]): ConfirmSummaryItem[] {
  return names.map((name) => ({ label: summaryLabel(form, name), value: summaryValueText(summaryControl(form, name)) }));
}

/**
 * The FormData of a submit, built the way react-dom builds it for a form
 * action (createFormDataWithSubmitter): a temporary input carrying the
 * pressed button's name and value goes right before the button, the form is
 * read in tree order, and the input is removed. The server action therefore
 * receives the same entries, in the same order, as when React dispatched it.
 */
export function formDataFor(form: HTMLFormElement, submitter: HTMLElement | null): FormData {
  if (!submitter) return new FormData(form);
  const temp = submitter.ownerDocument.createElement('input');
  temp.name = (submitter as HTMLButtonElement).name;
  temp.value = (submitter as HTMLButtonElement).value;
  if (form.id) temp.setAttribute('form', form.id);
  submitter.parentNode?.insertBefore(temp, submitter);
  const formData = new FormData(form);
  temp.parentNode?.removeChild(temp);
  return formData;
}

/**
 * Review M1: hands a submit button whether it must stay disabled — true only
 * for a form with a confirm dialog that is not hydrated yet (the server
 * markup and the first client render agree). A disabled default button also
 * stops the implicit submit from Enter in a text field.
 */
export function SubmitLock({ children }: { children: (locked: boolean) => ReactNode }) {
  const feedback = useContext(FormFeedbackContext);
  return <>{children(feedback?.submitLocked === true || feedback?.keyReuseLocked === true)}</>;
}

/** Per-field ids and state for a control rendered inside (or outside) a feedback form. */
export function useFieldFeedback(name: string | undefined, hasHint: boolean) {
  const feedback = useContext(FormFeedbackContext);
  const baseId = useId();
  const hintId = `${baseId}hint`;
  const errorId = `${baseId}error`;
  const error = name !== undefined && feedback ? feedback.errors[name] : undefined;
  const ids = [hasHint ? hintId : null, error ? errorId : null].filter((id): id is string => id !== null);
  return {
    hintId,
    errorId,
    error,
    describedBy: ids.length > 0 ? ids.join(' ') : undefined,
    invalid: error ? (true as const) : undefined
  };
}

/**
 * For a custom form's own control (not a fields.tsx field). The custom forms
 * render the shell themselves, so a useFieldFeedback call in their own body
 * sits above the provider and never sees an error; this component is rendered
 * inside the form and hands the field's ids and error to its children.
 */
export function FieldFeedback({
  name,
  hasHint = false,
  children
}: {
  name: string;
  hasHint?: boolean | undefined;
  children: (feedback: ReturnType<typeof useFieldFeedback>) => ReactNode;
}) {
  const feedback = useFieldFeedback(name, hasHint);
  return <>{children(feedback)}</>;
}

/** The message under a control. The ✕ and the hidden 「入力エラー：」 keep it from relying on colour. */
export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <span id={id} className="field-error">
      <span className="field-error-mark" aria-hidden="true">
        ✕
      </span>
      <span>
        <span className="form-sr-only">入力エラー：</span>
        {message}
      </span>
    </span>
  );
}

/** 「入力内容を確認してください（N件）」 — always in the tree so it is announced when it fills. */
export function FormErrorSummary() {
  const feedback = useContext(FormFeedbackContext);
  return (
    <p role="alert" className="form-summary">
      {formErrorSummary(feedback?.summaryCount ?? 0)}
    </p>
  );
}

/**
 * The result line next to the button: two live regions that always exist, so a
 * refusal is announced (alert) and a success is read politely (status).
 */
export function FormResult({ state, successHint }: { state: ActionState | null; successHint?: string | undefined }) {
  const failed = state !== null && !state.ok;
  const succeeded = state !== null && state.ok;
  const context = useRenderedContext();
  // Review NM1: the 「処理済みの可能性」 notice is always given in both languages.
  const korean = failed && state.messageKo && (context?.showKorean || state.code === KEY_REUSED_CODE || state.code === OUTCOME_UNKNOWN_CODE) ? state.messageKo : null;
  return (
    <>
      <span role="alert" className="form-result form-result--error">
        {failed ? (
          <>
            <span className="form-result-mark" aria-hidden="true">
              ✕
            </span>
            <span>
              {displayActionMessage(state.message)}
              {korean ? (
                <span className="form-result-ko" lang="ko">
                  {korean}
                </span>
              ) : null}
              <ResultRemedyText state={state} />
            </span>
          </>
        ) : null}
      </span>
      {/* P4 N15 (P3 M-4①): the buttons and links sit OUTSIDE the role=alert region — a live region
          that holds a control re-announces it on every change and hides it from some screen readers. */}
      {failed ? <ResultRemedyAction state={state} /> : null}
      <span role="status" className="form-result form-result--ok">
        {succeeded ? (
          <>
            <span className="form-result-mark" aria-hidden="true">
              ✓
            </span>
            <span>{displayActionMessage(state.message)}</span>
            {successHint ? <span className="form-result-hint">{successHint}</span> : null}
            {/* P1 R34 (M14): where the work continues, right after the result. */}
            {state.link ? <a className="form-result-action" href={state.link.href}>{state.link.label}</a> : null}
          </>
        ) : null}
      </span>
    </>
  );
}

/**
 * P0: the one way out next to a refusal — reload after another tab switched
 * the project (R03), log in again in a new tab so this tab keeps every entered
 * value (R08), open the record a duplicate number belongs to (R05).
 * P4 N15: the sentence of it (read by the alert) and the control (outside it) are two parts.
 */
function ResultRemedyText({ state }: { state: ActionState }) {
  // P2 R05: the result of the earlier submit is unknown — the key stays fixed until the
  // operator checked the list.
  if (state.code === OUTCOME_UNKNOWN_CODE) {
    return <strong className="form-result-line">{OUTCOME_UNKNOWN_LINE}</strong>;
  }
  // P2 R05: still processing — the same input is sent again later with the same key.
  if (state.code === IN_PROGRESS_CODE) {
    return <span className="form-result-hint">{IN_PROGRESS_HINT}</span>;
  }
  return null;
}

function ResultRemedyAction({ state }: { state: ActionState }) {
  const feedback = useContext(FormFeedbackContext);
  // P-7: the Korean line follows the user's display setting. Only the two idempotency
  // buttons (KEY_REUSED / OUTCOME_UNKNOWN) keep the NM1 always-bilingual exception.
  const showKorean = useRenderedContext()?.showKorean === true;
  // 「一覧を確認しました」 allows a new submit (new key).
  if (state.code === OUTCOME_UNKNOWN_CODE) {
    return feedback?.outcomeCheckPending && feedback.startNewIntent ? (
      <span className="form-result-remedy">
        <button type="button" className="form-result-action" onClick={feedback.startNewIntent}>
          {OUTCOME_UNKNOWN_CHECKED_LABEL}
          <span className="form-result-ko" lang="ko">{OUTCOME_UNKNOWN_CHECKED_KO}</span>
        </button>
      </span>
    ) : null;
  }
  if (state.code === IN_PROGRESS_CODE) return null;
  if (state.code === KEY_REUSED_CODE && feedback?.keyReuseLocked && feedback.startNewIntent) {
    const startNewIntent = feedback.startNewIntent;
    return (
      <button type="button" className="form-result-action" onClick={startNewIntent}>
        {KEY_REUSED_CHECKED_LABEL}
        <span className="form-result-ko" lang="ko">{KEY_REUSED_CHECKED_KO}</span>
      </button>
    );
  }
  if (state.code === PROJECT_CONTEXT_MISMATCH) {
    return (
      <button type="button" className="form-result-action" onClick={() => window.location.reload()}>
        {RELOAD_LABEL}
        {showKorean ? <span className="form-result-ko" lang="ko">{RELOAD_KO}</span> : null}
      </button>
    );
  }
  if (state.code === 'SESSION_EXPIRED') {
    return (
      <a
        className="form-result-action"
        href={loginHrefFor(typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`)}
        target="_blank"
        rel="noopener"
      >
        {LOGIN_OTHER_TAB_LABEL}
        {showKorean ? <span className="form-result-ko" lang="ko">{LOGIN_OTHER_TAB_KO}</span> : null}
      </a>
    );
  }
  if (state.link) {
    return (
      <a className="form-result-action" href={state.link.href}>
        {state.link.label}
      </a>
    );
  }
  return null;
}

/** Builds the dialog for a held submit; null means this submit needs no confirmation. */
export type ConfirmResolver = (
  form: HTMLFormElement,
  submitter: HTMLElement | null
) => { options: ConfirmOptions; summary: ConfirmSummaryItem[]; confirmLabel: string } | null;

/** ActionForm's resolver: a fixed spec, the summary read from summaryFields. */
export function resolverFromOptions(options: ConfirmOptions | undefined, fallbackLabel: string): ConfirmResolver | undefined {
  if (!options) return undefined;
  return (form) => ({
    options,
    summary: [
      ...(options.facts ?? []),
      ...summaryFromFields(
        form,
        summaryFieldsFor(options.summaryFields ?? [], options.summaryWhen, (name) => controlValue(form, name))
      )
    ],
    confirmLabel: options.confirmLabel ?? fallbackLabel
  });
}

interface FeedbackFormProps {
  action: (formData: FormData) => void;
  state: ActionState | null;
  /** The action is running: submits are ignored (the buttons are aria-disabled). */
  pending?: boolean | undefined;
  /**
   * The form's reset, which the shell triggers only after a successful result
   * (review H1). A native listener, so a form.reset() from any effect or
   * commit reaches it.
   */
  onReset?: (() => void) | undefined;
  confirm?: ConfirmResolver | undefined;
  /** What the closed dialog carries before a submit fills it (server markup, first paint). */
  dialogDefaults?: { options: ConfirmOptions; confirmLabel: string } | undefined;
  /** p6 X6: the submit button's label — the order screen's status region names the action by it (lib/submit-intent). */
  intentLabel?: string | undefined;
  style?: CSSProperties | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/** The <form> shell: validation, server-field mapping, the held confirm and the dialog. */
export function FeedbackForm({ action, state, pending, onReset, confirm, dialogDefaults, intentLabel, style, className, children }: FeedbackFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summaryCount, setSummaryCount] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [gate] = useState(createSubmitGate);
  // P0 R05 (H7): a ref-held lock — React's pending arrives a render later, so a
  // second click in the same tick passed the gate and posted twice.
  const [inFlight] = useState(createSubmitInFlight);
  inFlight.observe(state, pending === true);
  const [held, setHeld] = useState<{
    options: ConfirmOptions;
    summary: ConfirmSummaryItem[];
    confirmLabel: string;
  } | null>(null);
  const submitterRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // P0 R05 / review H1: one key per submit intent, drawn after mount (never in the
  // server markup). It is renewed only when the submit is over (success, or a
  // refusal the API answered); after a timeout the retry carries the same key,
  // so a write the API stored while the answer was lost is not stored twice.
  const [submitKey, setSubmitKey] = useState('');
  // Review NM1: after IDEMPOTENCY_KEY_REUSED the form is locked (no submit, same key)
  // and the list is refreshed, until the operator confirms a new intent.
  // The lock is derived from the result in the same render (no effect gap a click could use).
  const [confirmedFor, setConfirmedFor] = useState<ActionState | null>(null);
  const keyReuseLocked = isKeyReuseLocked(state, confirmedFor);
  const outcomeCheckPending = awaitsOutcomeCheck(state, confirmedFor);
  useEffect(() => {
    // p6 X6: a refused submit recorded nothing — it must not name a later, unrelated change.
    if (state !== null && !state.ok) withdrawSubmitIntent();
    // P2 R05: OUTCOME_UNKNOWN refreshes the list like KEY_REUSED (the key is kept by shouldRenewSubmitKey).
    if (locksForKeyReuse(state) || (state !== null && !state.ok && state.code === OUTCOME_UNKNOWN_CODE)) {
      const detail: SavedRecordDetail = { changedId: null };
      window.dispatchEvent(new CustomEvent(SAVED_RECORD_EVENT, { detail }));
      return;
    }
    if (shouldRenewSubmitKey(state)) setSubmitKey(newIdempotencyKey());
  }, [state]);
  const startNewIntent = useCallback(() => {
    setSubmitKey(newIdempotencyKey());
    setConfirmedFor(state);
  }, [state]);

  const resetHandler = useRef(onReset);
  useEffect(() => {
    resetHandler.current = onReset;
  });
  useEffect(() => {
    const form = formRef.current;
    if (!form) return undefined;
    const reset = () => resetHandler.current?.();
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, []);

  // Review H1: only a success empties the form (once per result); a refusal keeps every value.
  // P0 R06: a success also tells the layout to refresh the screen and highlight the changed row.
  const resetFor = useRef<ActionState | null>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form || !shouldResetAfterResult(state, resetFor.current)) return;
    resetFor.current = state;
    form.reset();
    // P1 R34: the saved input is no longer "unsaved".
    markDirty(form, false);
    const detail: SavedRecordDetail = { changedId: state?.changedId ?? null, message: state?.message ?? null, link: state?.link ?? null };
    window.dispatchEvent(new CustomEvent(SAVED_RECORD_EVENT, { detail }));
  }, [state]);

  // A refusal that names a field marks that field and moves focus to it.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const resolution = resolveActionFieldError(state, (field) => findControl(form, field) !== null);
    if (resolution.kind === 'clear') setErrors({});
    if (resolution.kind !== 'field') return;
    setErrors({ [resolution.field]: resolution.message });
    findControl(form, resolution.field)?.focus();
  }, [state]);

  // P1 R34 (M9): typed input marks the form unsaved until a successful submit.
  useEffect(() => {
    const form = formRef.current;
    installUnsavedGuard();
    return () => {
      if (form) forgetUnsaved(form);
    };
  }, []);

  function clearFieldError(event: FormEvent<HTMLFormElement>): void {
    const target = event.target as Element;
    if (formRef.current && target instanceof HTMLElement && target.getAttribute('type') !== 'hidden') markDirty(formRef.current, true);
    const key = feedbackKey(event.target as Element);
    if (!key || !(key in errors)) return;
    const next = { ...errors };
    delete next[key];
    setErrors(next);
    setSummaryCount((count) => (count > 0 ? Object.keys(next).length : 0));
  }

  /** Runs the action with this submit's FormData (React then skips its own dispatch and reset). */
  function dispatch(form: HTMLFormElement, submitter: HTMLElement | null): void {
    if (!inFlight.acquire(state)) return;
    const formData = formDataFor(form, submitter);
    startTransition(() => action(formData));
    // p6 review M-1 / L-4: the form's own label, else the pressed button's words; a 手動確認 also says what was chosen.
    // (The action's answer arrives later than this line, so the status region always finds the intent.)
    noteSubmitIntent(intentLabel ?? labelOfButton(submitter as unknown as LabelledButton | null), resultDetailOf(formData.get('result')));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // Review H1: never React's form-action path, which resets the form even after a refusal.
    event.preventDefault();
    const form = event.currentTarget;
    const native = event.nativeEvent as SubmitEvent;
    const submitter = native.submitter instanceof HTMLElement ? native.submitter : null;
    // P0 R05: dropped before anything else while this form's action is running.
    if (inFlight.busy) return;
    // Review NM1: nothing goes out until the operator has checked the list and confirmed.
    if (keyReuseLocked) return;
    const check = checkForm(form);
    const dialog = !pending && check.count === 0 && confirm ? confirm(form, submitter) : null;
    const decision = gate.submit({ invalid: check.count > 0, needsConfirm: dialog !== null, pending });
    // While the action runs every submit is dropped.
    if (decision === 'ignore') return;
    if (decision === 'invalid') {
      setErrors(check.errors);
      setSummaryCount(check.count);
      check.focusTarget?.focus();
      return;
    }
    setErrors({});
    setSummaryCount(0);
    if (decision === 'confirm' && dialog) {
      submitterRef.current = submitter;
      setHeld(dialog);
      return;
    }
    dispatch(form, submitter);
  }

  // Focus goes back to the button that opened the dialog once it has closed
  // (after the dialog's own effect, so the page is no longer inert).
  const wasHeld = useRef(false);
  useEffect(() => {
    if (held) {
      wasHeld.current = true;
      return;
    }
    if (!wasHeld.current) return;
    wasHeld.current = false;
    const target = submitterRef.current ?? formRef.current?.querySelector<HTMLElement>('button[type="submit"]');
    target?.focus();
  }, [held]);

  /** The held submit runs once, with the button that opened the dialog (review L3: no requestSubmit). */
  function onConfirm(): void {
    const form = formRef.current;
    if (!form || !gate.confirm()) return;
    setHeld(null);
    dispatch(form, submitterRef.current);
  }

  function onCancel(): void {
    gate.cancel();
    setHeld(null);
  }

  const submitLocked = Boolean(confirm) && !mounted;
  const value = useMemo(
    () => ({ errors, summaryCount, submitLocked, keyReuseLocked, outcomeCheckPending, startNewIntent }),
    [errors, summaryCount, submitLocked, keyReuseLocked, outcomeCheckPending, startNewIntent]
  );

  return (
    <form
      ref={formRef}
      action={action}
      noValidate={mounted}
      onSubmit={onSubmit}
      onInput={clearFieldError}
      onChange={clearFieldError}
      className={className ? `form-shell ${className}` : 'form-shell'}
      style={style}
    >
      {/* P0 R03 (B3): the project this form was drawn for; the server action refuses a mismatch. */}
      <RenderedProjectField />
      {submitKey ? <input type="hidden" readOnly name={IDEMPOTENCY_FIELD} value={submitKey} /> : null}
      <FormFeedbackContext.Provider value={value}>{children}</FormFeedbackContext.Provider>
      {confirm ? (
        <ConfirmDialog
          open={held !== null}
          title={(held ?? dialogDefaults)?.options.title ?? ''}
          body={(held ?? dialogDefaults)?.options.body ?? ''}
          summary={held?.summary ?? []}
          confirmLabel={(held ?? dialogDefaults)?.confirmLabel ?? ''}
          tone={(held ?? dialogDefaults)?.options.tone}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </form>
  );
}
