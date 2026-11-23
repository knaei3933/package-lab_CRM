/**
 * p6 X6: what the operator just submitted, said in the button's own words.
 *
 * After a step is recorded the screen is drawn again and the form that answered is gone with its result line, so the
 * order screen's status region (components/StepAnnouncer) says what was recorded. It used to read the NEWEST RECORD of the
 * order — which is not always this submit's (a manual check announced 「書類を登録」). The submit's own button label is the
 * one thing that is exact: the form shell notes it when a submit goes out, a refusal withdraws it, and the status region
 * takes it when the progress changes.
 *
 * Module state on purpose: the form and the region are separate client components that share a page, and the form is
 * unmounted by the very redraw the region reacts to. Kept for a minute at most, so a later change made elsewhere
 * (another tab, a refresh) is never announced as this submit.
 */
export const SUBMIT_INTENT_TTL_MS = 60_000;

let current: { label: string; at: number } | null = null;

/** A submit goes out. A form without a label (null) clears the memory: its success must not be named after an older submit. */
export function noteSubmitIntent(label: string | null, now: number = Date.now()): void {
  current = label && label.trim().length > 0 ? { label: label.trim(), at: now } : null;
}

/** The action was refused or failed: nothing was recorded, so nothing is announced. */
export function withdrawSubmitIntent(): void {
  current = null;
}

/** The status region takes the label once (null when there is none, or it is older than the TTL). */
export function takeSubmitIntent(now: number = Date.now()): string | null {
  const taken = current;
  current = null;
  if (!taken || now - taken.at > SUBMIT_INTENT_TTL_MS) return null;
  return taken.label;
}

/**
 * 「手動確認を記録する」 → 「手動確認を記録しました」. Only the endings the product's buttons really use are turned into the past
 * tense (〜する, 〜作る, 〜す: 差し戻す・残す・記録し直す), and a closing 「（…）」 of the label (「（確認は代表）」) is left out; any
 * other label is quoted as it is (「…」を実行しました) — never guessed into a wrong verb.
 */
export function pastTenseOf(label: string): string {
  const text = label.trim();
  const core = text.replace(/[（(][^）)]*[）)]$/, '').trim() || text;
  if (core.endsWith('する')) return `${core.slice(0, -2)}しました`;
  if (core.endsWith('作る')) return `${core.slice(0, -1)}りました`;
  if (core.endsWith('す')) return `${core.slice(0, -1)}しました`;
  return `「${text}」を実行しました`;
}

/**
 * The line the status region reads after the progress changed: the submit's own action when it is known, else the
 * newest record (the old reading, still right for a change made by someone else), then what to do now.
 */
export function announcementText(input: { intent: string | null; latest: string | null; now: string | null }): string {
  const done = input.intent ? `${pastTenseOf(input.intent)}。` : `記録しました${input.latest ? `（${input.latest}）` : ''}。`;
  return `${done}${input.now ? `いまの手順: ${input.now}` : 'この発注の手順はすべて終わりました。'}`;
}
