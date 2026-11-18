'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActionForm } from './ActionForm';
import type { ConfirmOptions, FormAction } from './ActionForm';
import { FormFeedbackContext } from './form-feedback';

/**
 * Recheck 7 Low-7 (d): a folded field that belongs to one choice of a select
 * in the same form (the 保留にする理由 of 「保留中」). It opens — and the
 * field becomes required, so the form's own validation stops an empty submit
 * and focuses it — when that choice is picked; it opens and takes focus when
 * a refusal names the field (a closed <details> cannot receive focus, so the
 * form shell's own focus() would miss it). Other choices leave it optional.
 */
export function ChoiceDisclosure({
  selectName,
  value,
  fieldName,
  summary,
  children
}: {
  /** The select whose choice the field belongs to. */
  selectName: string;
  /** The choice that needs the field. */
  value: string;
  /** The posted name of the field inside. */
  fieldName: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const feedback = useContext(FormFeedbackContext);
  const error = feedback?.errors[fieldName];

  useEffect(() => {
    const details = ref.current;
    const form = details?.closest('form');
    if (!details || !form) return undefined;
    const field = () => details.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${fieldName}"]`);
    const sync = () => {
      const select = form.elements.namedItem(selectName);
      const chosen = select instanceof HTMLSelectElement && select.value === value;
      const control = field();
      if (control) control.required = chosen;
      if (chosen) details.open = true;
    };
    const onChange = (event: Event) => {
      if (event.target instanceof HTMLSelectElement && event.target.name === selectName) sync();
    };
    // After a successful submit the form resets: the choice is blank again.
    const onReset = () => window.setTimeout(sync, 0);
    sync();
    form.addEventListener('change', onChange);
    form.addEventListener('reset', onReset);
    return () => {
      form.removeEventListener('change', onChange);
      form.removeEventListener('reset', onReset);
    };
  }, [selectName, value, fieldName]);

  useEffect(() => {
    const details = ref.current;
    if (!error || !details) return;
    details.open = true;
    details.querySelector<HTMLElement>(`[name="${fieldName}"]`)?.focus();
  }, [error, fieldName]);

  return (
    <details ref={ref}>
      <summary style={{ fontSize: 13, cursor: 'pointer' }}>{summary}</summary>
      {children}
    </details>
  );
}

/**
 * Recheck 7 Low-7 (e): an ActionForm whose button (and confirm dialog) take the
 * danger tone only while the chosen value of one select is the irreversible
 * one — 「取消で終了する」 of the cancellation review — and the primary tone
 * otherwise (「再開する」 is not destructive).
 */
export function ChoiceToneActionForm({
  selectName,
  dangerValue,
  dangerConfirmBody,
  action,
  submitLabel,
  hint,
  confirm,
  children
}: {
  selectName: string;
  dangerValue: string;
  /** Replaces confirm.body while the danger value is chosen (e.g. a live-paper warning). */
  dangerConfirmBody?: string | undefined;
  action: FormAction;
  submitLabel: string;
  hint?: string | undefined;
  confirm: ConfirmOptions;
  children: ReactNode;
}) {
  const [danger, setDanger] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Native listeners on the form (as in ChoiceDisclosure), read from the select itself.
  useEffect(() => {
    const form = ref.current?.querySelector('form');
    if (!form) return undefined;
    const sync = () => {
      const select = form.elements.namedItem(selectName);
      setDanger(select instanceof HTMLSelectElement && select.value === dangerValue);
    };
    const onReset = () => window.setTimeout(sync, 0);
    sync();
    form.addEventListener('change', sync);
    form.addEventListener('input', sync);
    form.addEventListener('reset', onReset);
    return () => {
      form.removeEventListener('change', sync);
      form.removeEventListener('input', sync);
      form.removeEventListener('reset', onReset);
    };
  }, [selectName, dangerValue]);
  const tone = danger ? 'danger' : 'primary';
  return (
    <div ref={ref}>
      <ActionForm
        action={action}
        submitLabel={submitLabel}
        hint={hint}
        tone={tone}
        confirm={{ ...confirm, tone, body: danger && dangerConfirmBody ? dangerConfirmBody : confirm.body }}
      >
        {children}
      </ActionForm>
    </div>
  );
}
