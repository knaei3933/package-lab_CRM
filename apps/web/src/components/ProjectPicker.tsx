'use client';

import { useActionState, useEffect, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, PointerEvent } from 'react';
import type { FormAction } from './ActionForm';
import { createProjectPickerIntent, MAIN_REGION_ID } from '../lib/project-picker-intent';
import type { Choice } from '../lib/types';

/**
 * UI batch B (②): the header's project selector on one line. A project picked
 * with the pointer switches at once (requestSubmit). From the keyboard the
 * arrow keys only move the choice (WCAG 3.2.2: no change of context on input);
 * Enter or the small 「切り替え」 button switches, and the button also covers a
 * browser where the script did not run. The posted fields
 * are unchanged (projectId, directProjectId → selectProjectAction): the list
 * wins when both are filled, so the id input sits under 「詳細」 for a project
 * the list does not offer. The pointer/keyboard rules and the focus move after
 * a switch live in lib/project-picker-intent (REVIEW.md B-M3, B-M4).
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
  const [intent] = useState(createProjectPickerIntent);

  // B-M3: the switch remounts the select (key below), which drops focus to the
  // body. After a switch submitted here succeeds, focus goes to the page's
  // main region (tabIndex -1, no ring); never on page load or after a refusal.
  // UI batch C (1-⑦): preventScroll — the header stays where the operator was.
  useEffect(() => {
    if (intent.settled(state)) document.getElementById(MAIN_REGION_ID)?.focus({ preventScroll: true });
  }, [intent, state]);

  function submitIfChosen(select: HTMLSelectElement): void {
    if (select.value.length > 0) select.form?.requestSubmit();
  }

  function onChange(event: ChangeEvent<HTMLSelectElement>): void {
    if (intent.change(event.timeStamp)) submitIfChosen(event.currentTarget);
  }

  function onKeyDown(event: KeyboardEvent<HTMLSelectElement>): void {
    if (!intent.keyDown(event.key)) return;
    event.preventDefault();
    // Read the value after the key has been applied to the select.
    const select = event.currentTarget;
    setTimeout(() => submitIfChosen(select), 0);
  }

  return (
    <form
      action={formAction}
      className="project-picker"
      onSubmit={(event) => {
        // UI batch C (review M3): the button is aria-disabled, not disabled, while
        // a switch runs, so it keeps focus; a second submit is dropped here.
        if (pending) {
          event.preventDefault();
          return;
        }
        intent.submitted();
      }}
    >
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
            onPointerDown={(event: PointerEvent<HTMLSelectElement>) => intent.pointerDown(event.timeStamp)}
            onBlur={() => intent.blur()}
          >
            <option value="">（選択なし）</option>
            {(Array.isArray(choices) ? choices : []).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="project-picker-submit" aria-disabled={pending || undefined}>
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
