'use client';

import { useActionState } from 'react';
import type { FormAction } from './ActionForm';
import { FeedbackForm, FormResult, SubmitLock } from './form-feedback';
import type { Choice } from '../lib/types';

/** P1 R29: the three display modes as radio buttons (no select: every choice is visible). */
export function LanguageForm({ action, current, choices }: { action: FormAction; current: string; choices: Choice[] }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <FeedbackForm action={formAction} state={state} pending={pending} className="p1-wizard">
      <fieldset className="p1-fieldset">
        <legend className="p1-legend">表示言語</legend>
        {choices.map((choice) => (
          <label key={choice.value} className="p1-radio">
            <input type="radio" name="language" value={choice.value} defaultChecked={choice.value === current} required />
            {choice.label}
          </label>
        ))}
      </fieldset>
      <div className="form-actions">
        <SubmitLock>
          {(locked) => (
            <button type="submit" className="p1-button p1-button--primary" aria-disabled={pending || undefined} disabled={locked || undefined}>
              {pending ? '保存しています…' : '保存する'}
            </button>
          )}
        </SubmitLock>
        <FormResult state={state} />
      </div>
    </FeedbackForm>
  );
}
