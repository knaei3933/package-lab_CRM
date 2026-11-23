'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import { DraftAutosave } from './DraftAutosave';
import { KoGloss } from './RenderedContext';
import { FeedbackForm, FormErrorSummary, FormResult, resolverFromOptions, SubmitLock } from './form-feedback';
import type { ConfirmOptions, FormTone } from './form-feedback';
import type { ActionState } from '../lib/types';
import { noteStyle } from '../lib/ui';

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
  /** P4 H11: the Korean line of `hint` (shown in the bilingual / Korean modes, P-7). */
  hintKo?: string | undefined;
  /** P4 H11: the Korean line under the button's label (the representative's actions). */
  submitLabelKo?: string | undefined;
  /** The submit button's colour: danger for cancellations and similar. */
  tone?: FormTone | undefined;
  /** Appended after 「記録しました。」, e.g. 「次の手順: …」. */
  successHint?: string | undefined;
  /**
   * P2: which record the button acts on, read by screen readers only (visually
   * hidden) — for lists that repeat the same button text on every row.
   */
  submitContext?: string | undefined;
  /** P4 web2a: a secondary action beside the step's one primary action (a quiet button). */
  quiet?: boolean | undefined;
  /**
   * P4 R-1: a form on an order screen keeps what was typed while it is typed (sessionStorage), so a
   * 「戻る」 the page cannot ask about (no Navigation API, or not cancelable) does not lose it. false: no draft.
   */
  draft?: boolean | undefined;
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
export function ActionForm({ action, submitLabel, children, hint, hintKo, submitLabelKo, confirm, tone, successHint, submitContext, quiet, draft = true }: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  // P4 H13: a class, not an inline style — an inline style beat the 44px target and the hover of p3-polish.
  const buttonClass = tone === 'danger' ? 'ui-button--danger' : quiet ? 'ui-button--subtle' : 'ui-button';
  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      confirm={resolverFromOptions(confirm, submitLabel)}
      dialogDefaults={confirm ? { options: confirm, confirmLabel: confirm.confirmLabel ?? submitLabel } : undefined}
      style={{ display: 'grid', gap: 10 }}
    >
      {draft ? <DraftAutosave name={`step:${submitLabel}${submitContext ? `:${submitContext}` : ''}`} orderScreenOnly /> : null}
      {children}
      {hint ? <p style={noteStyle}>{hint}<KoGloss ko={hintKo} /></p> : null}
      <div className="form-actions">
        {/* aria-disabled (not disabled) while pending: focus stays on the button after a confirm.
            disabled only before hydration when a confirm dialog guards the form (review M1). */}
        <SubmitLock>
          {(locked) => (
            <button
              type="submit"
              aria-disabled={pending || undefined}
              disabled={locked || undefined}
              className={buttonClass}
            >
              {pending ? '送信中…' : submitLabel}
              {pending ? null : <KoGloss ko={submitLabelKo} />}
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
