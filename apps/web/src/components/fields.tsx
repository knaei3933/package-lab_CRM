'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ChangeEventHandler, FocusEvent } from 'react';
import type { Choice } from '../lib/types';
import { fieldRowStyle, inputStyle, noteStyle } from '../lib/ui';
import { FieldError, normalizeDateTextInput, useFieldFeedback } from './form-feedback';

/**
 * Form fields shared by every screen. UI batch C: client components so each
 * field can read its error from the surrounding form shell
 * (FormFeedbackContext); outside a shell they render the same controls with
 * no error. The label wraps only its caption and the control (the accessible
 * name); the error and the hint follow outside it, linked through
 * aria-describedby, and `width` is the control's maximum width — on a narrow
 * screen it shrinks to the column.
 */

interface FieldProps {
  name: string;
  label: string;
  /** Optional props declare `| undefined` so call sites may pass undefined. */
  required?: boolean | undefined;
  hint?: string | undefined;
}

function wrapperStyle(width: number) {
  return { display: 'grid', gap: 2, minWidth: 'min(220px, 100%)', maxWidth: '100%', flex: `0 1 ${width}px` } as const;
}

function controlStyle(width: number) {
  return { ...inputStyle, width: '100%', maxWidth: width };
}

function LabelWrapper({
  label,
  required,
  hint,
  hintId,
  errorId,
  error,
  width,
  className,
  children
}: {
  label: string;
  required?: boolean | undefined;
  hint?: string | undefined;
  hintId: string;
  errorId: string;
  error: string | undefined;
  width: number;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={className ? `field ${className}` : 'field'} style={wrapperStyle(width)}>
      <label className="field-label">
        <span style={{ fontSize: 13, color: 'var(--ink)' }}>
          {label}
          {required ? <span style={{ color: 'var(--danger)' }}>（必須）</span> : null}
        </span>
        {children}
      </label>
      <FieldError id={errorId} message={error} />
      {hint ? (
        <span id={hintId} style={noteStyle}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  name,
  label,
  required,
  hint,
  type = 'text',
  defaultValue,
  placeholder,
  width,
  value,
  onChange
}: FieldProps & {
  type?: 'text' | 'password' | 'datetime-local' | 'date' | 'number';
  defaultValue?: string | undefined;
  placeholder?: string | undefined;
  /** Maximum control width in px (UI batch C: no longer a fixed width). */
  width?: number | undefined;
  value?: string | undefined;
  onChange?: ChangeEventHandler<HTMLInputElement> | undefined;
}) {
  const feedback = useFieldFeedback(name, Boolean(hint));
  const max = width ?? 260;
  return (
    <LabelWrapper label={label} required={required} hint={hint} width={max} {...feedback}>
      <input
        name={name}
        type={type}
        value={value}
        defaultValue={value === undefined ? defaultValue : undefined}
        placeholder={placeholder}
        required={required}
        onChange={onChange}
        aria-describedby={feedback.describedBy}
        aria-invalid={feedback.invalid}
        data-feedback-label={label}
        style={controlStyle(max)}
      />
    </LabelWrapper>
  );
}

/** Shown under a DateTextField when the caller gives no hint of its own. */
export const DATE_TEXT_HINT = '例 2026/11/18（日本時間の日付）';

/**
 * UI batch C (1-②): a date-only field without the browser's locale-bound date
 * picker. One text input under the same `name`; 2026/11/18, 2026-11-18 and
 * 20261118 are accepted and normalized to YYYY-MM-DD on blur and before the
 * submit, so the server still receives YYYY-MM-DD. Before hydration the
 * pattern lets a typed YYYY-MM-DD through natively. The input is
 * uncontrolled, so the form's reset (React 19 resets a form after its action)
 * restores the default value natively; the reset listener drops a leftover
 * 「not a calendar date」 custom error with it.
 */
export function DateTextField({
  name,
  label,
  required,
  hint,
  defaultValue,
  width = 200
}: FieldProps & {
  defaultValue?: string | undefined;
  width?: number | undefined;
}) {
  const shownHint = hint ?? DATE_TEXT_HINT;
  const feedback = useFieldFeedback(name, true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    const form = input?.form;
    if (!input || !form) return undefined;
    const onReset = () => input.setCustomValidity('');
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  return (
    <LabelWrapper label={label} required={required} hint={shownHint} width={width} className="date-text-field" {...feedback}>
      <input
        ref={inputRef}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="2026/11/18"
        pattern="\d{4}-\d{2}-\d{2}"
        defaultValue={defaultValue}
        required={required}
        onBlur={(event: FocusEvent<HTMLInputElement>) => normalizeDateTextInput(event.currentTarget)}
        aria-describedby={feedback.describedBy}
        aria-invalid={feedback.invalid}
        data-date-text=""
        data-feedback-label={label}
        data-feedback-format="2026/11/18 の形"
        style={controlStyle(width)}
      />
    </LabelWrapper>
  );
}

/**
 * UI batch B: ungrouped choices first, then one <optgroup> per group label in
 * the order the groups first appear (e.g. 例外（保留・見直し）).
 */
function choiceOptions(choices: Choice[]) {
  const option = (choice: Choice) => (
    <option key={choice.value} value={choice.value}>
      {choice.label}
    </option>
  );
  const groups: string[] = [];
  for (const choice of choices) {
    if (choice.group && !groups.includes(choice.group)) groups.push(choice.group);
  }
  return (
    <>
      {choices.filter((choice) => !choice.group).map(option)}
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {choices.filter((choice) => choice.group === group).map(option)}
        </optgroup>
      ))}
    </>
  );
}

export function SelectField({
  name,
  label,
  choices,
  required,
  hint,
  includeBlank = false,
  blankLabel = '（選択なし）',
  defaultValue,
  width,
  onChange
}: FieldProps & {
  choices: Choice[];
  includeBlank?: boolean | undefined;
  blankLabel?: string | undefined;
  defaultValue?: string | undefined;
  /** Maximum control width in px. */
  width?: number | undefined;
  onChange?: ChangeEventHandler<HTMLSelectElement> | undefined;
}) {
  const feedback = useFieldFeedback(name, Boolean(hint));
  const max = width ?? 280;
  return (
    <LabelWrapper label={label} required={required} hint={hint} width={max} {...feedback}>
      <select
        name={name}
        defaultValue={defaultValue}
        required={required}
        onChange={onChange}
        aria-describedby={feedback.describedBy}
        aria-invalid={feedback.invalid}
        data-feedback-label={label}
        style={controlStyle(max)}
      >
        {includeBlank ? <option value="">{blankLabel}</option> : null}
        {/* M8-UI3 FIX 1: a choice list is always server-assembled, so a read
            that came back empty-handed must render an empty selector rather
            than throw `choices.map is not a function` inside the client form. */}
        {choiceOptions(Array.isArray(choices) ? choices : [])}
      </select>
    </LabelWrapper>
  );
}

export function CheckboxField({ name, label, hint, required }: FieldProps) {
  const feedback = useFieldFeedback(name, Boolean(hint));
  return (
    <div className="field" style={{ display: 'grid', gap: 2, minWidth: 'min(200px, 100%)' }}>
      {/* The hint stays on the checkbox's line but outside the label (not part of its name). */}
      <div style={{ ...fieldRowStyle, fontSize: 13 }}>
        <label style={{ ...fieldRowStyle, display: 'inline-flex' }}>
          <input
            type="checkbox"
            name={name}
            required={required}
            aria-describedby={feedback.describedBy}
            aria-invalid={feedback.invalid}
            data-feedback-label={label}
          />
          <span>{label}</span>
        </label>
        {hint ? (
          <span id={feedback.hintId} style={noteStyle}>
            {hint}
          </span>
        ) : null}
      </div>
      <FieldError id={feedback.errorId} message={feedback.error} />
    </div>
  );
}

/** Multi-line free text: 取消理由・確認の根拠（reasonNote）など、長い日本語の記録欄。 */
export function TextareaField({
  name,
  label,
  required,
  hint,
  rows = 3,
  width = 480
}: FieldProps & {
  rows?: number | undefined;
  /** Maximum control width in px. */
  width?: number | undefined;
}) {
  const feedback = useFieldFeedback(name, Boolean(hint));
  return (
    <LabelWrapper label={label} required={required} hint={hint} width={width} {...feedback}>
      <textarea
        name={name}
        rows={rows}
        required={required}
        aria-describedby={feedback.describedBy}
        aria-invalid={feedback.invalid}
        data-feedback-label={label}
        style={controlStyle(width)}
      />
    </LabelWrapper>
  );
}
