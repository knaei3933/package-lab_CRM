'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import { dangerButtonStyle } from './ConfirmDialog';
import { FeedbackForm, FormErrorSummary, FormResult, resolverFromOptions, SubmitLock } from './form-feedback';
import type { ConfirmOptions, FormTone } from './form-feedback';
import type { ActionState } from '../lib/types';
import { buttonStyle, noteStyle } from '../lib/ui';

export type FormAction = (state: ActionState | null, formData: FormData) => Promise<ActionState>;
export type { ConfirmOptions, FormTone } from './form-feedback';

interface ActionFormProps {
  action: FormAction;
  submitLabel: string;
  children?: ReactNode;
  /** Explains what the form records, shown under the fields. */
  hint?: string | undefined;
  /** UI batch C (1-③): ask before the action runs (serializable; passed from server pages). */
  confirm?: ConfirmOptions | undefined;
  /** The submit button's colour: danger for cancellations and similar. */
  tone?: FormTone | undefined;
  /** Appended after 「記録しました。」, e.g. 「次の手順: …」. */
  successHint?: string | undefined;
  /**
   * P2: which record the button acts on, read by screen readers only (visually
   * hidden) — for lists that repeat the same button text on every row.
   */
  submitContext?: string | undefined;
}

/**
 * One form + one server action + one status line. Every mutation screen uses
 * this shell, so the API's Japanese message is always visible next to the
 * button that produced it. UI batch C: field-level errors, a result line that
 * is always a live region, and an optional confirm dialog (form-feedback).
 * After hydration the shell dispatches the action and resets the form only
 * after a success, so a refused submit keeps its values (review H1); with a
 * confirm dialog the button stays disabled until hydration (review M1).
 */
export function ActionForm({ action, submitLabel, children, hint, confirm, tone, successHint, submitContext }: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const style = tone === 'danger' ? dangerButtonStyle : buttonStyle;
  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      confirm={resolverFromOptions(confirm, submitLabel)}
      dialogDefaults={confirm ? { options: confirm, confirmLabel: confirm.confirmLabel ?? submitLabel } : undefined}
      style={{ display: 'grid', gap: 10 }}
    >
      {children}
      {hint ? <p style={noteStyle}>{hint}</p> : null}
      <div className="form-actions">
        {/* aria-disabled (not disabled) while pending: focus stays on the button after a confirm.
            disabled only before hydration when a confirm dialog guards the form (review M1). */}
        <SubmitLock>
          {(locked) => (
            <button
              type="submit"
              aria-disabled={pending || undefined}
              disabled={locked || undefined}
              style={{ ...style, opacity: pending || locked ? 0.6 : 1 }}
            >
              {pending ? '送信中…' : submitLabel}
              {submitContext ? <span className="visually-hidden">（{submitContext}）</span> : null}
            </button>
          )}
        </SubmitLock>
        <FormErrorSummary />
        <FormResult state={state} successHint={successHint} />
      </div>
    </FeedbackForm>
  );
}
