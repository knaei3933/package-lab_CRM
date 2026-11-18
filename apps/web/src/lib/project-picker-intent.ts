/**
 * REVIEW.md B-M3/B-M4: the header ProjectPicker's intent rules, kept apart from
 * React so they can be checked without a DOM.
 *
 * - A change switches the project at once only when it follows a pointer press
 *   directly (a mouse or touch pick from the list). Any other change — arrow
 *   keys, a screen reader's virtual cursor, voice control — only moves the
 *   choice (WCAG 3.2.2); Enter or the 「切り替え」 button switches.
 * - The pointer mark is used once: it is cleared after every change, on every
 *   key press and when the select loses focus. It also lapses after
 *   POINTER_PICK_WINDOW_MS, because a press that opened the list and closed it
 *   without a change leaves the select focused and fires nothing to clear it.
 * - Focus moves into the page only after a switch this picker submitted
 *   succeeded (WCAG 2.4.3: the remounted select would otherwise drop focus to
 *   the body); never on page load or after a refused switch.
 */
/** How long after a pointer press a change still counts as that pointer pick. */
export const POINTER_PICK_WINDOW_MS = 10_000;

export interface ProjectPickerIntent {
  /** `at`: the event's timeStamp (ms). */
  pointerDown(at: number): void;
  /** True for Enter: switch once the key has been applied to the select. */
  keyDown(key: string): boolean;
  /** True when this change should switch at once (`at`: the event's timeStamp). */
  change(at: number): boolean;
  blur(): void;
  /** The form was submitted from this picker (button, Enter or pointer pick). */
  submitted(): void;
  /** The action answered; true when focus should move to the page's main region. */
  settled(result: { ok: boolean } | null): boolean;
}

export function createProjectPickerIntent(): ProjectPickerIntent {
  // The time of the pointer press the next change may follow, or null.
  let pointerAt: number | null = null;
  let switchRequested = false;
  return {
    pointerDown(at) {
      pointerAt = at;
    },
    keyDown(key) {
      pointerAt = null;
      return key === 'Enter';
    },
    change(at) {
      const switchNow = pointerAt !== null && at >= pointerAt && at - pointerAt <= POINTER_PICK_WINDOW_MS;
      pointerAt = null;
      return switchNow;
    },
    blur() {
      pointerAt = null;
    },
    submitted() {
      switchRequested = true;
    },
    settled(result) {
      const moveFocus = switchRequested && result !== null && result.ok;
      switchRequested = false;
      return moveFocus;
    }
  };
}

/** The layout's <main id="main" tabIndex={-1}> (also the skip link's target). */
export const MAIN_REGION_ID = 'main';
