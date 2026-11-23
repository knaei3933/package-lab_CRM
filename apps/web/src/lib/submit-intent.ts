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

let current: { label: string; detail: string | null; at: number } | null = null;

/** A submit goes out. A form without a label (null) clears the memory: its success must not be named after an older submit. */
export function noteSubmitIntent(label: string | null, detail: string | null = null, now: number = Date.now()): void {
  current = label && label.trim().length > 0 ? { label: label.trim(), detail, at: now } : null;
}

/** The action was refused or failed: nothing was recorded, so nothing is announced. */
export function withdrawSubmitIntent(): void {
  current = null;
}

/** The status region takes the label once (null when there is none, or it is older than the TTL). */
export function takeSubmitIntent(now: number = Date.now()): SubmitIntent | null {
  const taken = current;
  current = null;
  if (!taken || now - taken.at > SUBMIT_INTENT_TTL_MS) return null;
  return { label: taken.label, detail: taken.detail };
}

export interface SubmitIntent {
  label: string;
  /** What the operator chose when the form asked for a result (「却下」/「確認」), else null. */
  detail: string | null;
}

const RESULT_WORDS: Readonly<Record<string, string>> = { confirmed: '確認', rejected: '却下' };

/** p6 review L-4: the result a 手動確認 form was submitted with, in the screens' words; null for a form without one. */
export function resultDetailOf(value: unknown): string | null {
  return typeof value === 'string' ? RESULT_WORDS[value] ?? null : null;
}

/** The part of a button the label is read from (structural, so it needs no browser to be tested). */
export interface LabelledButton {
  cloneNode(deep: boolean): LabelledButton;
  querySelectorAll(selector: string): Iterable<{ remove(): void }>;
  textContent: string | null;
}

/**
 * p6 review M-1: a form that does not name its action (it uses the shell directly) is named by the button that was pressed —
 * without the Korean gloss and the screen-reader-only record name (「（RE-A-FILM-1）」) that ride inside the button.
 */
export function labelOfButton(button: LabelledButton | null): string | null {
  if (!button || typeof button.cloneNode !== 'function') return null;
  const copy = button.cloneNode(true);
  for (const extra of copy.querySelectorAll('.p1-ko, .visually-hidden')) extra.remove();
  const text = (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/**
 * 「手動確認を記録する」 → 「手動確認を記録しました」. Only the endings the product's buttons really use are turned into the past
 * tense (〜する, 〜作る, 〜す: 差し戻す・残す・記録し直す), and a closing 「（…）」 of the label (「（確認は代表）」) is left out; any
 * other label is quoted as it is (「…」を実行しました) — never guessed into a wrong verb.
 */
export function pastTenseOf(label: string): string {
  const text = label.trim();
  const core = text.replace(/[（(][^）)]*[）)]$/, '').trim();
  if (core.endsWith('する')) return `${core.slice(0, -2)}しました`;
  if (core.endsWith('作る')) return `${core.slice(0, -1)}りました`;
  if (core.endsWith('す')) return `${core.slice(0, -1)}しました`;
  return `「${text}」を実行しました`;
}

/**
 * The line the status region reads after the progress changed: the submit's own action when it is known, else the
 * newest record (the old reading, still right for a change made by someone else), then what to do now.
 */
export function announcementText(input: { intent: SubmitIntent | string | null; latest: string | null; now: string | null }): string {
  const intent = typeof input.intent === 'string' ? { label: input.intent, detail: null } : input.intent;
  const done = intent ? `${pastTenseOf(intent.label)}${intent.detail ? `（${intent.detail}）` : ''}。` : `記録しました${input.latest ? `（${input.latest}）` : ''}。`;
  return `${done}${input.now ? `いまの手順: ${input.now}` : 'この発注の手順はすべて終わりました。'}`;
}
