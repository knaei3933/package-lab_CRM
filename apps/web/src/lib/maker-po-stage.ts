import { isFilmOrderPastMakerAcceptance } from '@kanei/core';
import type { MakerPoEventRow, MakerPoSendManualVerification, MakerPoViewRow } from './maker-po-data';
import { shortId } from './short-id';
import { formatTimestamp } from './vocabulary';

/**
 * UI batch C (2-④): the stages of one order's maker paper, for the /maker-po
 * card — ① 発注書の作成 → ② 代表承認 → ③ 送信の記録 → ③′ 送信の手動確認
 * (only when a send waits for, or went through, the representative's manual
 * check) → ④ 受入 → 完了.
 *
 * Display only, and pure: it reads the maker PO statuses, the approval time,
 * the event trail and whether a send still waits for the manual check — all
 * values the screen already loaded — and never decides what the API allows.
 * The forms stay where their own status conditions put them.
 */
export type MakerPoStageKey = 'create' | 'approve' | 'send' | 'verify' | 'accept' | 'complete';
export type MakerPoStageState = 'done' | 'current' | 'upcoming' | 'skipped';

/**
 * normal: the paper moves on; attention: the current stage needs a redo
 * (snapshot voided); halted: stopped (send unverified, cancelled paper);
 * complete: the paper is accepted.
 */
export type MakerPoStageCondition = 'normal' | 'attention' | 'halted' | 'complete';

export interface MakerPoStage {
  key: MakerPoStageKey;
  /** ① ② ③ ③′ ④, empty for 完了. */
  number: string;
  name: string;
  state: MakerPoStageState;
  /** One line of what was recorded, for a done stage (JST times). */
  summary: string | null;
}

export interface MakerPoStageView {
  stages: MakerPoStage[];
  current: MakerPoStage | null;
  condition: MakerPoStageCondition;
  /** The id of the paper the stages describe (the live one, else the latest). */
  primaryPoId: string | null;
  /** One line per earlier cancelled paper of the same order. */
  cancelledPapers: string[];
}

export interface MakerPoStagePaper {
  po: Pick<MakerPoViewRow, 'id' | 'status' | 'ceoApprovedAt' | 'createdAt'>;
  events: ReadonlyArray<MakerPoEventRow>;
  /** A send of this paper still waits for the representative's manual check. */
  pendingVerification: boolean;
  /** The representative's confirmation of a send of this paper, if recorded. */
  confirmedVerification: MakerPoSendManualVerification | null;
}

export interface MakerPoStageInput {
  /** The film order's status; null when the role may not read it. */
  orderStatus: string | null;
  papers: ReadonlyArray<MakerPoStagePaper>;
}

const STAGE_NAMES: Readonly<Record<MakerPoStageKey, { number: string; name: string }>> = {
  create: { number: '①', name: '発注書の作成' },
  approve: { number: '②', name: '代表承認' },
  send: { number: '③', name: '送信の記録' },
  verify: { number: '③′', name: '送信の手動確認' },
  accept: { number: '④', name: '受入' },
  complete: { number: '', name: '完了' }
};

/** 「① 発注書の作成」, 「完了」. */
export function stageLabel(stage: Pick<MakerPoStage, 'number' | 'name'>): string {
  return stage.number ? `${stage.number} ${stage.name}` : stage.name;
}

/** 「このあと: ③ 送信の記録 → ④ 受入 → 完了」, or null when nothing follows. */
export function upcomingStagesLine(view: MakerPoStageView): string | null {
  const upcoming = view.stages.filter((stage) => stage.state === 'upcoming');
  return upcoming.length === 0 ? null : `このあと: ${upcoming.map(stageLabel).join(' → ')}`;
}

function sendEvent(events: ReadonlyArray<MakerPoEventRow>): MakerPoEventRow | null {
  const sends = events.filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
  return sends.find((event) => event.verificationStatus === 'VERIFIED') ?? sends[0] ?? null;
}

function hadManualCheck(paper: MakerPoStagePaper): boolean {
  return paper.pendingVerification
    || paper.confirmedVerification !== null
    || paper.events.some((event) =>
      event.eventType === 'SEND_EVIDENCE_REGISTERED' && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION');
}

function summaries(paper: MakerPoStagePaper): Record<MakerPoStageKey, string | null> {
  const { po, events } = paper;
  const sent = sendEvent(events);
  const accepted = events.find((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED') ?? null;
  const confirmed = paper.confirmedVerification;
  return {
    create: po.createdAt
      ? `発注書 ${shortId(po.id)} を作成（${formatTimestamp(po.createdAt)}）`
      : `発注書 ${shortId(po.id)} を作成`,
    approve: po.ceoApprovedAt ? `代表承認（${formatTimestamp(po.ceoApprovedAt)}）` : '代表承認を記録済み',
    send: sent?.sentAt
      ? `送信の記録（送信日時 ${formatTimestamp(sent.sentAt)}）`
      : '送信を記録済み',
    verify: confirmed
      ? `手動確認: 確認（${confirmed.verifierName ?? '検証者未記録'}／${formatTimestamp(confirmed.verifiedAt ?? confirmed.recordedAt)}）`
      : '手動確認を記録済み',
    accept: accepted?.recordedAt ? `最終受入確認（${formatTimestamp(accepted.recordedAt)}）` : '受入確認済み',
    complete: null
  };
}

function build(
  states: Partial<Record<MakerPoStageKey, MakerPoStageState>>,
  withVerify: boolean,
  lines: Record<MakerPoStageKey, string | null> | null
): MakerPoStage[] {
  const keys: MakerPoStageKey[] = withVerify
    ? ['create', 'approve', 'send', 'verify', 'accept', 'complete']
    : ['create', 'approve', 'send', 'accept', 'complete'];
  return keys.map((key) => {
    const state = states[key] ?? 'upcoming';
    return {
      key,
      ...STAGE_NAMES[key],
      state,
      summary: state === 'done' && lines ? lines[key] : null
    };
  });
}

function createdTime(paper: MakerPoStagePaper): number | null {
  const time = paper.po.createdAt ? Date.parse(paper.po.createdAt) : Number.NaN;
  return Number.isNaN(time) ? null : time;
}

/**
 * Newest first by createdAt. The API lists the papers newest first
 * (GET …/maker-purchase-orders orders by createdAt desc), so papers without a
 * readable createdAt keep that list order, after the dated ones.
 */
export function papersNewestFirst<T extends MakerPoStagePaper>(papers: ReadonlyArray<T>): T[] {
  return papers
    .map((paper, index) => ({ paper, index, time: createdTime(paper) }))
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) return b.time - a.time;
      if (a.time !== null && b.time === null) return -1;
      if (a.time === null && b.time !== null) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.paper);
}

/** The paper the stages describe: the newest live one, else the newest of all. */
function primaryPaper(papers: ReadonlyArray<MakerPoStagePaper>): MakerPoStagePaper | null {
  const ordered = papersNewestFirst(papers);
  return ordered.find((paper) => paper.po.status !== 'CANCELLED') ?? ordered[0] ?? null;
}

function cancelledLine(paper: MakerPoStagePaper): string {
  const cancelled = paper.events.find((event) => event.eventType === 'MAKER_PO_CANCELLED');
  return cancelled?.recordedAt
    ? `取り消した発注書 ${shortId(paper.po.id)}（取消 ${formatTimestamp(cancelled.recordedAt)}）`
    : `取り消した発注書 ${shortId(paper.po.id)}`;
}

export function makerPoStages(input: MakerPoStageInput): MakerPoStageView {
  const primary = primaryPaper(input.papers);
  const cancelledPapers = papersNewestFirst(input.papers)
    .filter((paper) => paper !== primary && paper.po.status === 'CANCELLED')
    .map(cancelledLine);
  const view = (
    stages: MakerPoStage[],
    condition: MakerPoStageCondition
  ): MakerPoStageView => ({
    stages,
    current: stages.find((stage) => stage.state === 'current') ?? null,
    condition,
    primaryPoId: primary?.po.id ?? null,
    cancelledPapers
  });
  const lines = primary ? summaries(primary) : null;
  const withVerify = primary ? hadManualCheck(primary) : false;
  const allDone = { create: 'done', approve: 'done', send: 'done', verify: 'done', accept: 'done', complete: 'done' } as const;

  // The order itself has moved past the maker acceptance: the paper is closed.
  if (input.orderStatus !== null && isFilmOrderPastMakerAcceptance(input.orderStatus)) {
    return view(build(allDone, withVerify, lines), 'complete');
  }
  if (!primary) {
    return view(build({ create: 'current' }, false, null), 'normal');
  }

  const { po, events } = primary;
  switch (po.status) {
    case 'DRAFT':
      return view(build({ create: 'done', approve: 'current' }, withVerify, lines), 'normal');
    case 'SNAPSHOT_VOIDED':
      return view(build({ create: 'done', approve: 'current' }, withVerify, lines), 'attention');
    case 'APPROVED_FOR_MANUAL_SEND':
      // A send recorded but waiting for the representative's check: ③′ is now.
      return primary.pendingVerification
        ? view(build({ create: 'done', approve: 'done', send: 'done', verify: 'current' }, true, lines), 'normal')
        : view(build({ create: 'done', approve: 'done', send: 'current' }, false, lines), 'normal');
    case 'SEND_UNVERIFIED':
      return view(build({ create: 'done', approve: 'done', send: 'current' }, withVerify, lines), 'halted');
    case 'MAKER_PO_SENT_MANUALLY':
      return view(
        build({ create: 'done', approve: 'done', send: 'done', verify: 'done', accept: 'current' }, withVerify, lines),
        'normal'
      );
    case 'MAKER_PO_ACCEPTED':
      return view(build(allDone, withVerify, lines), 'complete');
    case 'CANCELLED': {
      // No live paper left: what this paper reached stays done, the rest is
      // not going to happen for it. The next paper starts again at ①.
      const sent = events.some((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
      const reached = (done: boolean): MakerPoStageState => (done ? 'done' : 'skipped');
      return view(build({
        create: 'done',
        approve: reached(Boolean(po.ceoApprovedAt)),
        send: reached(sent),
        verify: reached(primary.confirmedVerification !== null),
        accept: 'skipped',
        complete: 'skipped'
      }, withVerify, lines), 'halted');
    }
    default:
      // A status this table does not know: claim nothing past the paper itself.
      return view(build({ create: 'done' }, withVerify, lines), 'attention');
  }
}

/**
 * The 「いまの段階」 headline. Without a current stage: complete → 完了;
 * halted (every paper cancelled) → waiting for a new paper; a status this
 * table does not know → a neutral 「状態を確認できません」 (never a claim that
 * the paper was cancelled).
 */
export function stageHeadline(view: Pick<MakerPoStageView, 'current' | 'condition'>): string {
  if (view.current) return stageLabel(view.current);
  if (view.condition === 'complete') return '完了（受入確認済み）';
  if (view.condition === 'halted') return '取り消し済み（新しい発注書の作成待ち）';
  return '状態を確認できません';
}

/**
 * The G6 payment-gate box is large while the gate still decides the next step:
 * at ① or ②, and when no stage is current and the paper is not complete (all
 * papers cancelled → the next step is ① again; an unknown status). Afterwards
 * it shrinks to one line.
 */
export function paymentGateDecides(view: Pick<MakerPoStageView, 'current' | 'condition'>): boolean {
  if (!view.current) return view.condition !== 'complete';
  return view.current.key === 'create' || view.current.key === 'approve';
}
