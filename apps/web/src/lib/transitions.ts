import {
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
 * The API still decides every request; this only stops offering refusals.
 */
export const EXCEPTION_GROUP_LABEL = '例外（保留・見直し）';
export const RESUME_GROUP_LABEL = '再開する状態';
/** Resume targets past the state the order left — allowed by the state machine, but a jump. */
export const SKIP_AHEAD_GROUP_LABEL = '先の段階へ進める（注意）';
export const MAKER_CHAIN_NOTICE = '次はメーカー発注画面の操作で進みます';

/**
 * The order left a maker-chain state (送信確認待ち など) for a hold or review.
 * The generic transition endpoint never targets those states, so the resume
 * choices cannot contain it; say so instead of offering a silent substitute.
 */
export function makerChainResumeNotice(
  lastNormalStatus: string | null,
  label: (key: string) => string
): string | null {
  if (lastNormalStatus === null || !isFilmOrderMakerChainState(lastNormalStatus)) return null;
  return `中断前の「${label(lastNormalStatus)}」へはこの画面から戻せません。メーカー発注画面の記録で進めるか、代表者に相談してください。`;
}

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
  lastNormalStatus: string | null = null
): TransitionChoiceSet {
  if (!isFilmSupplyOrderState(status)) {
    return { choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: 'この状態からの進め方は画面に表示できません。' };
  }
  if (status === FILM_SUPPLY_ORDER_TERMINAL_STATE) {
    return { choices: [], makerChainNotice: false, hint: null, resumeNotice: null, emptyReason: 'この発注は完了しています。進める先はありません。' };
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
    const ahead = (to: string) => leftAt >= 0 && chainIndex(to) > leftAt;
    const resume = offered
      .filter((to) => !ahead(to))
      .sort((a, b) => Number(b === lastNormalStatus) - Number(a === lastNormalStatus));
    const skip = offered.filter(ahead);
    return {
      choices: [...resume.map((to) => choice(to, RESUME_GROUP_LABEL)), ...skip.map((to) => choice(to, SKIP_AHEAD_GROUP_LABEL))],
      makerChainNotice: false,
      hint: null,
      resumeNotice: makerChainResumeNotice(lastNormalStatus, label),
      emptyReason: offered.length === 0 ? '再開できる状態がありません。' : null
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
