'use client';

import '../app/forms.css';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConfirmSummaryItem } from './ConfirmDialog';
import { summaryValueText } from '../lib/confirm-summary';
import type { SummaryControl } from '../lib/confirm-summary';
import { DATE_TEXT_INVALID_MESSAGE, parseDateText } from '../lib/date-input';
import { displayActionMessage, resolveActionFieldError } from '../lib/form-messages';
import {
  createSubmitGate,
  focusableIndexFor,
  formErrorSummary,
  normalizeQuantityText,
  plainLabel,
  planInvalidSubmit
} from '../lib/form-validation';
import type { ControlDescriptor, ControlKind } from '../lib/form-validation';
import type { ActionState } from '../lib/types';

/**
 * UI batch C (1-①, 1-③): the feedback layer every operator form shares.
 *
 * - Field errors: after hydration the form turns native validation off
 *   (noValidate) and its onSubmit reads each control's `validity`, showing an
 *   operator-Japanese message under the field (FormFeedbackContext), a count
 *   next to the button and moving focus to the first problem.
 * - Server refusals keep showing in the result line; when one names a field
 *   (lib/form-messages), that field shows it too and takes focus.
 * - Confirm: a valid submit with a confirm spec is held (preventDefault) and a
 *   dialog opens; キャンセル drops it, the confirm button re-submits once
 *   through form.requestSubmit(submitter).
 *
 * - While the action runs (pending) the submit buttons are aria-disabled, not
 *   disabled, so the focused button keeps focus; the shell ignores submits.
 *
 * The DOM is only read here: which controls stop a submit, the dialog rows and
 * the server-message → field step are pure functions in lib/ (tested there).
 *
 * React 19 runs a form's function action only when the submit event was not
 * default-prevented (react-dom FormActionEventPlugin: `if
 * (nativeEvent.defaultPrevented) …` skips the action), so preventDefault here
 * is what stops the server action. Before hydration none of this runs: the
 * browser validates natively (noValidate is only set once mounted) and the
 * server action handles the submit exactly as before.
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
}

interface FormFeedbackValue {
  errors: Readonly<Record<string, string>>;
  summaryCount: number;
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
  if (item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement) return { kind: 'text', value: item.value };
  return { kind: 'missing' };
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
  return (
    <>
      <span role="alert" className="form-result form-result--error">
        {failed ? (
          <>
            <span className="form-result-mark" aria-hidden="true">
              ✕
            </span>
            <span>{displayActionMessage(state.message)}</span>
          </>
        ) : null}
      </span>
      <span role="status" className="form-result form-result--ok">
        {succeeded ? (
          <>
            <span className="form-result-mark" aria-hidden="true">
              ✓
            </span>
            <span>{displayActionMessage(state.message)}</span>
            {successHint ? <span className="form-result-hint">{successHint}</span> : null}
          </>
        ) : null}
      </span>
    </>
  );
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
    summary: summaryFromFields(form, options.summaryFields ?? []),
    confirmLabel: options.confirmLabel ?? fallbackLabel
  });
}

interface FeedbackFormProps {
  action: (formData: FormData) => void;
  state: ActionState | null;
  /** The action is running: submits are ignored (the buttons are aria-disabled). */
  pending?: boolean | undefined;
  /**
   * The form's reset (React 19 resets the form after its action). A native
   * listener: React dispatches no synthetic events during its commit, which is
   * when it calls form.reset().
   */
  onReset?: (() => void) | undefined;
  confirm?: ConfirmResolver | undefined;
  /** What the closed dialog carries before a submit fills it (server markup, first paint). */
  dialogDefaults?: { options: ConfirmOptions; confirmLabel: string } | undefined;
  style?: CSSProperties | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/** The <form> shell: validation, server-field mapping, the held confirm and the dialog. */
export function FeedbackForm({ action, state, pending, onReset, confirm, dialogDefaults, style, className, children }: FeedbackFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summaryCount, setSummaryCount] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [gate] = useState(createSubmitGate);
  const [held, setHeld] = useState<{
    options: ConfirmOptions;
    summary: ConfirmSummaryItem[];
    confirmLabel: string;
  } | null>(null);
  const submitterRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

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

  function clearFieldError(event: FormEvent<HTMLFormElement>): void {
    const key = feedbackKey(event.target as Element);
    if (!key || !(key in errors)) return;
    const next = { ...errors };
    delete next[key];
    setErrors(next);
    setSummaryCount((count) => (count > 0 ? Object.keys(next).length : 0));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    const form = event.currentTarget;
    const native = event.nativeEvent as SubmitEvent;
    const submitter = native.submitter instanceof HTMLElement ? native.submitter : null;
    if (pending || gate.state === 'confirmed') {
      // The confirmed re-submit passes once; anything while pending is dropped.
      if (gate.submit({ invalid: false, needsConfirm: false, pending }) === 'ignore') event.preventDefault();
      return;
    }
    const check = checkForm(form);
    const dialog = check.count === 0 && confirm ? confirm(form, submitter) : null;
    const decision = gate.submit({ invalid: check.count > 0, needsConfirm: dialog !== null });
    if (decision === 'invalid') {
      event.preventDefault();
      setErrors(check.errors);
      setSummaryCount(check.count);
      check.focusTarget?.focus();
      return;
    }
    setErrors({});
    setSummaryCount(0);
    if (decision === 'confirm' && dialog) {
      event.preventDefault();
      submitterRef.current = submitter;
      setHeld(dialog);
    }
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

  function onConfirm(): void {
    const form = formRef.current;
    if (!form || !gate.confirm()) return;
    const submitter = submitterRef.current;
    setHeld(null);
    if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
      form.requestSubmit(submitter);
    } else {
      form.requestSubmit();
    }
  }

  function onCancel(): void {
    gate.cancel();
    setHeld(null);
  }

  const value = useMemo(() => ({ errors, summaryCount }), [errors, summaryCount]);

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
