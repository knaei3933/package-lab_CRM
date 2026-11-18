'use client';

import { useEffect, useRef, useState } from 'react';
import { datetimeLocalToIso } from '../lib/datetime';
import {
  composeDatetimeLocal,
  datetimeTextsFor,
  dateTextForDisplay,
  dateTimeIssue,
  formatJstWithWeekday,
  parseDateText,
  parseTimeText,
  previewLocalValue
} from '../lib/date-input';
import { inputStyle, noteStyle } from '../lib/ui';
import { FieldError, useFieldFeedback } from './form-feedback';

interface DateTimeInputsProps {
  /**
   * The feedback key — the form field the value is posted under (the parent
   * renders the hidden inputs). The two text inputs themselves carry no name,
   * so nothing ambiguous reaches the server.
   */
  name: string;
  label: string;
  /** datetime-local value (YYYY-MM-DDTHH:MM) or ''. */
  value: string;
  onChange: (value: string) => void;
  required?: boolean | undefined;
  hint?: string | undefined;
  /**
   * Called on the form's reset event with the value the field started with
   * (React 19 resets a form after its action; the uncontrolled inputs go back
   * to their defaults, so this field does too). Defaults to onChange.
   */
  onReset?: ((value: string) => void) | undefined;
}

/**
 * UI batch C (1-②): date and time as two plain text inputs (2026/11/18 and
 * 14:30) instead of the browser's datetime-local, whose picker follows the OS
 * locale. The value stays the datetime-local string the forms always used;
 * an incomplete or impossible entry yields '' and a field error on submit.
 * Below the inputs the moment that will be recorded is spelled out in Japan
 * time, computed from the browser-side conversion the hidden field submits.
 *
 * The confirmation line is a polite live region, so it only changes when the
 * entry is complete (both parts typed out in full) or committed (blur, a value
 * set from outside, reset) — a transient parse such as 143 → 01:43 on the way
 * to 1430 is never announced.
 *
 * Before hydration the inputs are read-only: the hidden fields can only carry
 * what the component state holds, so a value typed before the script runs
 * would otherwise be silently replaced by the default on submit.
 */
export function DateTimeInputs({ name, label, value, onChange, required, hint, onReset }: DateTimeInputsProps) {
  const [texts, setTexts] = useState(() => datetimeTextsFor(value));
  const [mounted, setMounted] = useState(false);
  /** What the confirmation line shows (datetime-local), updated only on complete or committed entries. */
  const [preview, setPreview] = useState(value);
  const lastEmitted = useRef(value);
  /** The value this field returns to on the form's reset. */
  const initialValue = useRef(value);
  const resetHandler = useRef<(value: string) => void>(onReset ?? onChange);

  useEffect(() => {
    resetHandler.current = onReset ?? onChange;
  });
  const dateRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const feedback = useFieldFeedback(name, Boolean(hint));

  useEffect(() => {
    setMounted(true);
  }, []);

  // A value set from outside (EML auto-fill, a parent's reset) replaces the texts.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setTexts(datetimeTextsFor(value));
    setPreview(value);
  }, [value]);

  // The form's reset (after an action) brings the texts back to the starting value.
  useEffect(() => {
    const form = dateRef.current?.form;
    if (!form) return undefined;
    const reset = () => {
      const initial = initialValue.current;
      lastEmitted.current = initial;
      setTexts(datetimeTextsFor(initial));
      setPreview(initial);
      resetHandler.current(initial);
    };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, []);

  // The form shell reads validity on submit; the custom error sits on the part to fix.
  useEffect(() => {
    const issue = dateTimeIssue(texts.date, texts.time, Boolean(required), label);
    dateRef.current?.setCustomValidity(issue?.part === 'date' ? issue.message : '');
    timeRef.current?.setCustomValidity(issue?.part === 'time' ? issue.message : '');
  }, [texts, required, label]);

  function update(next: { date: string; time: string }): void {
    setTexts(next);
    setPreview(previewLocalValue(next, 'input') ?? '');
    const composed = composeDatetimeLocal(next.date, next.time) ?? '';
    if (composed !== lastEmitted.current) {
      lastEmitted.current = composed;
      onChange(composed);
    }
  }

  /** Leaving either input: normalize the spelling and let the line show any valid entry. */
  function commit(next: { date: string; time: string }): void {
    setTexts(next);
    setPreview(previewLocalValue(next, 'commit') ?? '');
  }

  const iso = mounted && preview ? datetimeLocalToIso(preview) : null;
  const jst = iso ? formatJstWithWeekday(iso) : null;

  return (
    <fieldset className="datetime-field">
      <legend>
        {label}
        {required ? <span style={{ color: 'var(--danger)' }}>（必須）</span> : null}
      </legend>
      <div className="datetime-row">
        <label className="datetime-part datetime-part--date">
          <span>日付（年/月/日）</span>
          <input
            ref={dateRef}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="2026/11/18"
            value={texts.date}
            readOnly={!mounted}
            onChange={(event) => update({ ...texts, date: event.target.value })}
            onBlur={() => {
              const parsed = parseDateText(texts.date);
              commit(parsed ? { ...texts, date: dateTextForDisplay(parsed) } : texts);
            }}
            aria-describedby={feedback.describedBy}
            aria-invalid={feedback.invalid}
            data-feedback-name={name}
            data-feedback-label={label}
            style={inputStyle}
          />
        </label>
        <label className="datetime-part datetime-part--time">
          <span>時刻（24時間表記）</span>
          <input
            ref={timeRef}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="14:30"
            value={texts.time}
            readOnly={!mounted}
            onChange={(event) => update({ ...texts, time: event.target.value })}
            onBlur={() => {
              const parsed = parseTimeText(texts.time);
              commit(parsed ? { ...texts, time: parsed } : texts);
            }}
            aria-describedby={feedback.describedBy}
            aria-invalid={feedback.invalid}
            data-feedback-name={name}
            data-feedback-label={label}
            style={inputStyle}
          />
        </label>
      </div>
      <FieldError id={feedback.errorId} message={feedback.error} />
      <p className="datetime-confirm" aria-live="polite">
        {jst ? `日本時間 ${jst} として記録します` : ''}
      </p>
      {hint ? (
        <span id={feedback.hintId} style={noteStyle}>
          {hint}
        </span>
      ) : null}
    </fieldset>
  );
}
