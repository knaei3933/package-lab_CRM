import {
  FILM_ORDER_CANCELLATION_STATE,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES,
  FILM_SUPPLY_ORDER_STATES,
  FILM_SUPPLY_ORDER_TERMINAL_STATE,
  filmSupplyOrderTransitions,
  isExceptionFilmSupplyOrderState,
  isFilmOrderMakerChainState
} from '@kanei/core';
import type { FilmSupplyOrderState } from '@kanei/core';
import type { Choice } from './types';

/**
 * UI batch B (③): the 「状態を進める」 choices of one film order, read from the
 * core state machine. Two kinds of target the generic transition endpoint
 * always refuses are left out: the maker chain (written only by the maker PO
 * operations) and the assumed-receipt terminal state (its own 受領確認 form).
 * Leaving a hold or a review, a third kind is left out on the UI side only:
 * a jump past MAKER_PO_ACCEPTED for an order that left before it (it would
 * skip the maker send and acceptance; see transitionChoicesFor).
 * The API still decides every request; this only stops offering refusals.
 */
export const EXCEPTION_GROUP_LABEL = '例外（保留・見直し）';
export const RESUME_GROUP_LABEL = '再開する状態';
/**
 * Resume targets past the state the order left — allowed by the state machine,
 * but a jump. Never past MAKER_PO_ACCEPTED unless the order left at or after it.
 */
export const SKIP_AHEAD_GROUP_LABEL = '先の段階へ進める（注意）';
export const MAKER_CHAIN_NOTICE = '次はメーカー発注画面の操作で進みます';

/**
 * ON_HOLD and CANCELLATION_REVIEW are left only through their own admin-only
 * endpoints (hold-release / cancellation-review-resolve, reason required). The
 * generic transition endpoint refuses every target from them: core
 * transitionFilmSupplyOrder needs the exception origin, which only those
 * endpoints read, and CANCELLATION_REVIEW answers 422
 * CANCELLATION_REVIEW_RESOLUTION_REQUIRED. The resume target is the state the
 * order left, chosen by the server — the screen never names one.
 */
export const HOLD_RELEASE_NOTICE =
  '保留の解除は下の「保留を解除する（代表者のみ）」で行います。再開する状態は、保留にする前の状態にシステムが戻します。';
export const CANCELLATION_REVIEW_NOTICE =
  '取消確認は下の「取消確認を処理する（代表者のみ）」で、再開するか取消で終了するかを決めます。';
export const CANCELLED_ORDER_NOTICE = 'この発注は取消で終了しています（取消済）。これ以上進める先はありません。';
/**
 * Recheck 7 Medium-3: a cancelled order whose maker paper still needs
 * cleaning up (live paper, an owed 取り消し承認), or whose paper could not be
 * read — the plain notice above is then never shown.
 */
export const CANCELLED_ORDER_CLEANUP_NOTICE =
  'この発注は取消で終了しています（取消済）。状態はこれ以上進みませんが、メーカー発注書の整理（取り消し・取り消し承認）が残っています。メーカー発注画面で代表者が記録してください。';
export const CANCELLED_ORDER_UNREAD_NOTICE =
  'この発注は取消で終了しています（取消済）。状態はこれ以上進みません。メーカー発注書の整理が残っていないかは、メーカー発注画面で確認してください。';

/** none: the maker paper is settled; cleanup: some is left; unknown (or not read): cannot tell. */
export type MakerCleanupHint = 'none' | 'cleanup' | 'unknown';

export interface TransitionChoiceSet {
  choices: Choice[];
  /** The next normal state belongs to the maker chain (メーカー発注画面で進む). */
  makerChainNotice: boolean;
  /** A note under the select, when one target needs explaining. */
  hint: string | null;
  /** Shown above the form: the state the order left cannot be named here. */
  resumeNotice: string | null;
  /** Why there is nothing to choose; the form is replaced by this line. */
  emptyReason: string | null;
}

const ALL_STATES: readonly string[] = [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES];

export function isFilmSupplyOrderState(value: string): value is FilmSupplyOrderState {
  return ALL_STATES.includes(value);
}

export function transitionChoicesFor(
  status: string,
  label: (key: string) => string,
  lastNormalStatus: string | null = null,
  makerCleanup: MakerCleanupHint = 'unknown'
): TransitionChoiceSet {
  if (status === FILM_ORDER_CANCELLATION_STATE) {
    const emptyReason = makerCleanup === 'none'
      ? CANCELLED_ORDER_NOTICE
      : makerCleanup === 'cleanup'
        ? CANCELLED_ORDER_CLEANUP_NOTICE
        : CANCELLED_ORDER_UNREAD_NOTICE;
    return { choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason };
  }
  if (!isFilmSupplyOrderState(status)) {
    return { choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: 'この状態からの進め方は画面に表示できません。' };
  }
  if (status === FILM_SUPPLY_ORDER_TERMINAL_STATE) {
    return { choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: 'この発注は完了しています。進める先はありません。' };
  }

  if (status === 'ON_HOLD') {
    return { choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: HOLD_RELEASE_NOTICE };
  }
  if (status === 'CANCELLATION_REVIEW') {
    return { choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: CANCELLATION_REVIEW_NOTICE };
  }

  const all = filmSupplyOrderTransitions(status);
  const offered = all.filter((to) => !isFilmOrderMakerChainState(to) && to !== FILM_SUPPLY_ORDER_TERMINAL_STATE);
  const choice = (to: string, group?: string): Choice => (group ? { value: to, label: label(to), group } : { value: to, label: label(to) });

  if (isExceptionFilmSupplyOrderState(status)) {
    // Leaving a hold or a review names the state work resumes in; the state the
    // order was in before it entered the exception comes first. States past it
    // are a jump forward and sit apart under 「先の段階へ進める（注意）」.
    const chainIndex = (state: string) => (FILM_SUPPLY_ORDER_STATES as readonly string[]).indexOf(state);
    const leftAt = lastNormalStatus === null ? -1 : chainIndex(lastNormalStatus);
    // B-M2 (demo-eml/ui-audit/batch-b-review/REVIEW.md): an order that left
    // before MAKER_PO_ACCEPTED (or whose left state is unknown) is never
    // offered a state past it — 製造中・出荷済み・納品済み would skip the maker
    // send and acceptance while the maker PO stays unsent. The API currently accepts that jump (200: core
    // EXCEPTION_RELEASE_TARGETS has no maker gate; evidence in
    // demo-eml/ui-audit/batch-b-review/logs/api-probes.txt). Whether the server
    // should refuse it is an open representative decision, so only the UI holds
    // back here; a jump that skips no maker step stays under the 注意 group.
    const acceptedAt = chainIndex('MAKER_PO_ACCEPTED');
    const skipsMakerSteps = (to: string) => leftAt < acceptedAt && chainIndex(to) > acceptedAt;
    const ahead = (to: string) => leftAt >= 0 && chainIndex(to) > leftAt;
    const offeredHere = offered.filter((to) => !skipsMakerSteps(to));
    const resume = offeredHere
      .filter((to) => !ahead(to))
      .sort((a, b) => Number(b === lastNormalStatus) - Number(a === lastNormalStatus));
    const skip = offeredHere.filter(ahead);
    return {
      choices: [...resume.map((to) => choice(to, RESUME_GROUP_LABEL)), ...skip.map((to) => choice(to, SKIP_AHEAD_GROUP_LABEL))],
      makerChainNotice: false,
      hint: null,
      resumeNotice: null,
      emptyReason: offeredHere.length === 0 ? '再開できる状態がありません。' : null
    };
  }

  const normal = offered.filter((to) => !isExceptionFilmSupplyOrderState(to));
  const exceptions = offered.filter((to) => isExceptionFilmSupplyOrderState(to));
  return {
    choices: [...normal.map((to) => choice(to)), ...exceptions.map((to) => choice(to, EXCEPTION_GROUP_LABEL))],
    makerChainNotice: all.some((to) => !isExceptionFilmSupplyOrderState(to) && isFilmOrderMakerChainState(to)),
    hint: status === 'APPROVAL_PENDING'
      ? `「${label('DUAL_APPROVED')}」へは、通常は承認の記録で自動的に進みます。`
      : status === 'FILM_DELIVERED'
        ? '受領確認は下の「受領確認（問題なしとみなす）」で記録します。'
        : null,
    resumeNotice: null,
    emptyReason: offered.length === 0 ? 'この画面から進める先はありません。' : null
  };
}
