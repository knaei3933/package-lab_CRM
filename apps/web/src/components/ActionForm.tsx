'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import type { ActionState } from '../lib/types.js';
import { buttonStyle, errorMessageStyle, noteStyle, okMessageStyle } from '../lib/ui.js';

export type FormAction = (state: ActionState | null, formData: FormData) => Promise<ActionState>;

interface ActionFormProps {
  action: FormAction;
  submitLabel: string;
  children?: ReactNode;
  /** Explains what the form records, shown under the fields. */
  hint?: string | undefined;
}

/**
 * One form + one server action + one status line. Every mutation screen uses
 * this shell, so the API's Japanese message is always visible next to the
 * button that produced it.
 */
export function ActionForm({ action, submitLabel, children, hint }: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} style={{ display: 'grid', gap: 10 }}>
      {children}
      {hint ? <p style={noteStyle}>{hint}</p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <button type="submit" disabled={pending} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? '送信中…' : submitLabel}
        </button>
        {state ? (
          <span style={state.ok ? okMessageStyle : errorMessageStyle}>{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
