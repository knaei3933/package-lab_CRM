'use client';

import { useActionState, useRef } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { FormAction } from './ActionForm';
import type { Choice } from '../lib/types';

/**
 * UI batch B (②): the header's project selector on one line. A project picked
 * with the pointer switches at once (requestSubmit). From the keyboard the
 * arrow keys only move the choice (WCAG 3.2.2: no change of context on input);
 * Enter or the small 「切り替え」 button switches, and the button also covers a
 * browser where the script did not run. The posted fields
 * are unchanged (projectId, directProjectId → selectProjectAction): the list
 * wins when both are filled, so the id input sits under 「詳細」 for a project
 * the list does not offer.
 */
export function ProjectPicker({
  action,
  choices,
  currentProjectId
}: {
  action: FormAction;
  choices: Choice[];
  currentProjectId: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  // True while the current choice is being made with the pointer.
  const pointerChoice = useRef(false);

  function submitIfChosen(select: HTMLSelectElement): void {
    if (select.value.length > 0) select.form?.requestSubmit();
  }

  function onChange(event: ChangeEvent<HTMLSelectElement>): void {
    if (pointerChoice.current) submitIfChosen(event.currentTarget);
  }

  function onKeyDown(event: KeyboardEvent<HTMLSelectElement>): void {
    pointerChoice.current = false;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // Read the value after the key has been applied to the select.
    const select = event.currentTarget;
    setTimeout(() => submitIfChosen(select), 0);
  }

  return (
    <form action={formAction} className="project-picker">
      <div className="project-picker-row">
        <label className="project-picker-field">
          <span>案件</span>
          {/* B1: keyed by the selected project so the refreshed layout remounts the
              select with the new default (the form resets to the old one after the action). */}
          <select
            key={currentProjectId ?? ''}
            name="projectId"
            defaultValue={currentProjectId ?? ''}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPointerDown={() => {
              pointerChoice.current = true;
            }}
          >
            <option value="">（選択なし）</option>
            {(Array.isArray(choices) ? choices : []).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="project-picker-submit" disabled={pending}>
          {pending ? '切り替え中…' : '切り替え'}
        </button>
        {/* Always present so assistive tech hears the result when it appears. */}
        <span role="status" className={state && !state.ok ? 'project-picker-error' : 'project-picker-ok'}>
          {state?.message ?? ''}
        </span>
      </div>
      <details className="tech-details project-picker-details">
        <summary>詳細（案件IDで開く）</summary>
        <div className="tech-details-body">
          <label className="project-picker-field">
            <span>案件ID</span>
            <input name="directProjectId" placeholder="UUIDを貼り付け…" autoComplete="off" spellCheck={false} />
          </label>
          <p>一覧にない案件は、「案件」を（選択なし）にしてから案件IDを入力し、「切り替え」を押します。</p>
          {currentProjectId ? <p>現在の案件ID: {currentProjectId}</p> : null}
        </div>
      </details>
    </form>
  );
}
