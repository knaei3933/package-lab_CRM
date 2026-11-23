import { LEGACY_HOLD_RELEASE_TARGETS } from '@kanei/core';
import { ActionForm } from './ActionForm';
import { ChoiceToneActionForm } from './ChoiceDrivenForm';
import { RoleGate } from './RoleGate';
import { SelectField, TextareaField } from './fields';
import {
  releaseFilmOrderHoldAction,
  resolveCancellationReviewAction,
  transitionFilmSupplyOrderAction
} from '../app/actions';
import { holdReleaseFacts, holdSummaryText } from '../lib/decision-facts';
import type { MakerPaperCleanupSummary } from '../lib/maker-po-data';
import { makerCleanupRecords, uncancellableLivePapers } from '../lib/project-data';
import type { FilmSupplyOrderView } from '../lib/project-data';
import { transitionChoicesFor } from '../lib/transitions';

/**
 * P4 §0 / M6: the exception forms of one film order — moved here from the old
 * 発注の一覧 table (OrdersScreen) so they run on the order screen. Same server
 * actions, same API endpoints, same confirm dialogs: the representative alone
 * releases a hold and resolves a cancellation review (approved server rule 3 and
 * 4 — the API decides; the screen only shows the form to the role that may use it).
 */

type Label = (key: string) => string;

/** The hidden fields every form of the order screen carries (the success link goes back to the order). */
function OrderHidden({ order, projectCode }: { order: FilmSupplyOrderView; projectCode: string }) {
  return (
    <>
      <input type="hidden" readOnly name="orderId" value={order.id} />
      <input type="hidden" readOnly name="orderCode" value={order.code} />
      <input type="hidden" readOnly name="projectCode" value={projectCode} />
    </>
  );
}

/**
 * A legacy hold or review whose origin the API has no audit row for: the API
 * then needs the resume target named (HOLD_ORIGIN_UNKNOWN /
 * CANCELLATION_RESUME_REQUIRED). Blank by default — nothing is sent unless picked.
 */
export function LegacyResumeField({ stateLabel, hint }: { stateLabel: Label; hint: string }) {
  return (
    <SelectField
      name="resumeStatus"
      label="再開する状態（前の状態が記録されていない古い発注で「再開する状態の指定が必要です」と表示されたときだけ）"
      includeBlank
      blankLabel="（選ばない：記録された前の状態に戻す）"
      width={320}
      hint={hint}
      choices={LEGACY_HOLD_RELEASE_TARGETS.map((value) => ({ value, label: stateLabel(value) }))}
    />
  );
}

/** Hold release: representative only, reason required; the API returns the order to the state it left. */
export function HoldReleaseForm({ order, role, stateLabel, projectCode }: { order: FilmSupplyOrderView; role: string | null; stateLabel: Label; projectCode: string }) {
  return (
    <RoleGate role={role} operation="film_order:release_hold" label="保留の解除">
      <ActionForm
        action={releaseFilmOrderHoldAction}
        submitLabel="保留を解除する"
        submitLabelKo="보류 해제"
        hint={`理由は必須です（1000字以内）。発注は保留にする前の状態に戻ります。保留中にその段階のメーカー発注書が取り消され、残っている発注書がない場合は「${stateLabel('MAKER_PO_READY')}」（発注書の作成）から再開します。`}
        hintKo="사유는 필수입니다. 발주는 보류 전 상태로 돌아갑니다."
        confirm={{
          title: '保留を解除しますか？',
          body: `発注 ${order.code} の保留を解除し、原則として保留にする前の状態に戻します（保留中にメーカー発注書がすべて取り消された場合は「${stateLabel('MAKER_PO_READY')}」に戻ります）。解除の理由と結果は履歴に記録されます（記録は消えません）。`,
          tone: 'primary',
          facts: holdReleaseFacts(order),
          summaryFields: ['reason', 'resumeStatus']
        }}
      >
        <OrderHidden order={order} projectCode={projectCode} />
        {order.hold ? <p className="ui-note">{holdSummaryText(order.hold)}</p> : null}
        <TextareaField name="reason" label="保留解除の理由" required rows={2} width={360} />
        <LegacyResumeField
          stateLabel={stateLabel}
          hint="保留前の状態が記録から分からない場合だけ選んでください。記録と違う状態を選ぶと、解除は記録されません。"
        />
      </ActionForm>
    </RoleGate>
  );
}

const CANCELLATION_OUTCOME_CHOICES = [
  { value: 'resume', label: '再開する（取消確認前の状態に戻す）' },
  { value: 'cancel', label: '取消で終了する（取消済・元に戻せません）' }
];

/**
 * Recheck 7 Medium-3: ending the order does not touch its maker paper (the
 * server resolves the review without retiring it), so the dialog says what
 * is left before 「取消で終了する」 is confirmed.
 */
export function makerPaperWarning(cleanup: MakerPaperCleanupSummary | undefined): string | null {
  if (cleanup === undefined || cleanup.state === 'unknown') {
    return '注意: この発注のメーカー発注書の状態を確認できませんでした。取消で終了しても、メーカー発注書は自動では取り消されません。下の「その他の操作」で残っている発注書がないか確認してください。';
  }
  if (cleanup.state === 'none') return null;
  const parts = [
    cleanup.livePapers > 0
      ? `取り消されていないメーカー発注書が${cleanup.livePapers}件あります（メーカーが生産する可能性があります）`
      : null,
    cleanup.acknowledgementPapers > 0
      ? `送信ずみのまま取り消し、取り消し承認が未記録の発注書が${cleanup.acknowledgementPapers}件あります`
      : null
  ].filter((part): part is string => part !== null);
  const stuck = uncancellableLivePapers(cleanup) > 0
    ? `そのうち${uncancellableLivePapers(cleanup)}件は取り消せない状態（送信未確認・受入済み）のため、メーカーへの連絡と対応を代表者が判断してください。`
    : '';
  const records = makerCleanupRecords(cleanup);
  return `注意: ${parts.join('。')}。${stuck}取消で終了しても、メーカー発注書は自動では取り消されません。`
    + (records.length > 0 ? `終了の前後に、下の「その他の操作」で${records.join('・')}を記録してください。` : '');
}

/** Cancellation review resolution: representative only, reason required; cancel ends the order for good. */
export function CancellationReviewForm({
  order,
  role,
  stateLabel,
  makerCleanup,
  projectCode
}: {
  order: FilmSupplyOrderView;
  role: string | null;
  stateLabel: Label;
  makerCleanup: MakerPaperCleanupSummary | undefined;
  projectCode: string;
}) {
  const body = `発注 ${order.code} の取消確認を、選んだ処理で終えます。「取消で終了する」は元に戻せません（以後、状態の変更・保留の解除・メーカー発注書の作成はできません）。「再開する」は取消確認前の状態に戻します。`;
  const warning = makerPaperWarning(makerCleanup);
  return (
    <RoleGate role={role} operation="film_order:resolve_cancellation_review" label="取消確認の処理">
      {warning ? <p className="role-notice">{warning}</p> : null}
      <ChoiceToneActionForm
        selectName="outcome"
        dangerValue="cancel"
        dangerConfirmBody={warning ? `${body}${warning}` : undefined}
        action={resolveCancellationReviewAction}
        submitLabel="取消確認を処理する"
        hint={`理由は必須です（1000字以内）。「取消で終了する」を選ぶと状態は「${stateLabel('CANCELLED')}」になり、以後この発注は進められません。`}
        confirm={{ title: '取消確認を処理しますか？', body, summaryFields: ['outcome', 'reason', 'resumeStatus'] }}
      >
        <OrderHidden order={order} projectCode={projectCode} />
        <SelectField name="outcome" label="処理" required includeBlank blankLabel="（処理を選ぶ）" width={320} choices={CANCELLATION_OUTCOME_CHOICES} />
        <TextareaField name="reason" label="処理の理由" required rows={2} width={360} />
        <LegacyResumeField
          stateLabel={stateLabel}
          hint="「再開する」で、取消確認前の状態が記録から分からない場合だけ選んでください（「取消で終了する」では使いません）。"
        />
      </ChoiceToneActionForm>
    </RoleGate>
  );
}

/** 変更確認中 → the state work resumes in (staff or the representative; the generic transition endpoint). */
export function ChangeReviewResumeForm({ order, role, stateLabel, projectCode }: { order: FilmSupplyOrderView; role: string | null; stateLabel: Label; projectCode: string }) {
  const set = transitionChoicesFor('CHANGE_REVIEW', stateLabel, order.lastNormalStatus, 'unknown');
  if (set.choices.length === 0) return <p className="ui-note">{set.emptyReason}</p>;
  return (
    <RoleGate role={role} operation="film_order:transition" label="変更確認からの再開">
      <ActionForm
        action={transitionFilmSupplyOrderAction}
        submitLabel="この段階から再開する"
        hint="変更の内容を確かめてから、作業を再開する段階を選びます（変更は履歴に残ります）。"
        confirm={{
          title: '変更確認から再開しますか？',
          body: `発注 ${order.code} を、選んだ段階から再開します。変更は履歴に記録されます（記録は消えません）。`,
          tone: 'primary',
          summaryFields: ['to']
        }}
      >
        <OrderHidden order={order} projectCode={projectCode} />
        <SelectField name="to" label="再開する段階" required includeBlank blankLabel="（段階を選ぶ）" width={320} choices={set.choices} />
      </ActionForm>
    </RoleGate>
  );
}

/** M6: the exception entries offered from a normal state (保留・変更確認・取消確認), by the core state machine. */
export type ExceptionEntry = 'ON_HOLD' | 'CHANGE_REVIEW' | 'CANCELLATION_REVIEW';

export function exceptionEntriesFor(status: string | null, stateLabel: Label): ExceptionEntry[] {
  if (status === null) return [];
  const values = transitionChoicesFor(status, stateLabel).choices.map((choice) => choice.value);
  return (['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'] as const).filter((entry) => values.includes(entry));
}

const ENTRY_COPY: Readonly<Record<ExceptionEntry, { submit: string; ko: string; hint: string; confirm: string }>> = {
  ON_HOLD: {
    submit: '保留にする',
    ko: '보류',
    hint: '理由は必須です。保留の解除は代表者が理由を書いて行います。',
    confirm: '発注を保留にします。解除は代表者だけができます。'
  },
  CHANGE_REVIEW: {
    submit: '変更確認にする',
    ko: '변경 확인',
    hint: '校了後のロット表記・ファイルなどを変えるときに使います。再開する段階はあとで選びます（担当者・代表）。',
    confirm: '発注を変更確認中にします。再開する段階はあとで選びます。'
  },
  CANCELLATION_REVIEW: {
    submit: '取消確認にする',
    ko: '취소 확인',
    hint: '取り消すかどうかを代表者が決める状態にします（再開するか、取消で終了するか）。',
    confirm: '発注を取消確認中にします。再開するか取消で終了するかは代表者が決めます。'
  }
};

/** One entry of the 「止める・変更する」 menu: the generic transition, the hold with its reason. */
export function ExceptionEntryForm({ order, entry, stateLabel, projectCode }: { order: FilmSupplyOrderView; entry: ExceptionEntry; stateLabel: Label; projectCode: string }) {
  const copy = ENTRY_COPY[entry];
  return (
    <ActionForm
      action={transitionFilmSupplyOrderAction}
      submitLabel={copy.submit}
      submitLabelKo={copy.ko}
      submitContext={order.code}
      hint={copy.hint}
      tone={entry === 'CANCELLATION_REVIEW' ? 'danger' : undefined}
      confirm={{
        title: `発注 ${order.code} を「${stateLabel(entry)}」にしますか？`,
        body: `${copy.confirm}変更は履歴に記録されます（記録は消えません）。`,
        tone: entry === 'CANCELLATION_REVIEW' ? 'danger' : 'primary',
        summaryFields: entry === 'ON_HOLD' ? ['holdReason'] : []
      }}
    >
      <OrderHidden order={order} projectCode={projectCode} />
      <input type="hidden" readOnly name="to" value={entry} />
      {entry === 'ON_HOLD' ? <TextareaField name="holdReason" label="保留にする理由" required rows={2} width={360} /> : null}
    </ActionForm>
  );
}
