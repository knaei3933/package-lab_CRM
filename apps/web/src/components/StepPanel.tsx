import Link from 'next/link';
import { ActionForm } from './ActionForm';
import { MakerPoSendEvidenceForm } from './MakerPoSendEvidenceForm';
import { StepFileField } from './StepFileField';
import { CheckboxField, SelectField, TextareaField, TextField } from './fields';
import {
  assumeFilmReceiptAction,
  transitionFilmSupplyOrderAction,
  updateFilmPaymentTermsAction
} from '../app/actions';
import { approveMakerPoAction, recordMakerPoSendEvidenceAction, verifyMakerPoSendAction } from '../app/maker-po/actions';
import {
  createMakerPoStepAction,
  recordAcceptanceStepAction,
  recordApprovalStepAction,
  recordDeliveryStepAction,
  submitProofStepAction
} from '../app/step-actions';
import { EVIDENCE_NOTE_FIELD } from '../lib/transition-evidence';
import { PAYMENT_TERMS_LABELS } from '../lib/maker-po-data';
import type { MakerPoEventRow, MakerPoViewRow } from '../lib/maker-po-data';
import { currentPaymentTerms, waitingText } from '../lib/order-flow';
import type { ApprovalSlotDesign, ApprovalSlotState, OrderFlowView } from '../lib/order-flow';
import type { ApprovalGateView, DocumentView, FilmSupplyOrderView, SevenPurchaseOrderView } from '../lib/project-data';
import { projectPath } from '../lib/project-route';
import { unitLabel } from '../lib/vocabulary';
import { formatAmount, formatQuantity, formatQuantityWithUnit } from '../lib/number-format';

/**
 * P1 R21: the 「現在の手順」 panel — ONE primary action for the step, the
 * reason and the one fix when it is blocked (§3-3), or what the step waits for
 * when the signed-in role cannot do it (相手待ち). Forms are the shared shells
 * (FeedbackForm: rendered project, Idempotency-Key, field errors, focus on the
 * result); evidence is uploaded inside the step (R22). The API decides.
 */
interface StepPanelProps {
  flow: OrderFlowView;
  order: FilmSupplyOrderView;
  projectCode: string;
  role: string;
  po: SevenPurchaseOrderView | null;
  gate: ApprovalGateView | null;
  maker: MakerPoViewRow | null;
  makerEvents: readonly MakerPoEventRow[];
  documents: readonly DocumentView[];
  stateLabel: (key: string) => string;
}

const TERMS_CHOICES = [
  { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
  { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
  { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
];

const CURRENCY_CHOICES = [
  { value: 'JPY', label: '日本円（JPY）' },
  { value: 'USD', label: '米ドル（USD）' },
  { value: 'CNY', label: '人民元（CNY）' },
  { value: 'KRW', label: '韓国ウォン（KRW）' }
];

/** The hidden fields every step form carries (the order, and where its success link goes). */
function OrderFields({ order, projectCode }: { order: FilmSupplyOrderView; projectCode: string }) {
  return (
    <>
      <input type="hidden" readOnly name="orderId" value={order.id} />
      <input type="hidden" readOnly name="orderCode" value={order.code} />
      <input type="hidden" readOnly name="projectCode" value={projectCode} />
    </>
  );
}

function Waiting({ text }: { text: string }) {
  return <p className="p1-waiting"><span aria-hidden="true">… </span>{text}</p>;
}

export function StepPanelView(props: StepPanelProps) {
  const { flow, order, projectCode } = props;
  const { action, canAct, actor, blocked } = flow.panel;

  if (blocked) {
    return (
      <div className="p1-blocked" role="group" aria-labelledby="blocked-title">
        <p id="blocked-title" className="p1-blocked-title"><span aria-hidden="true">✕ </span>進められません</p>
        <p>{blocked.reason}</p>
        {blocked.fix === 'payment_terms' && canAct ? (
          <ActionForm
            action={updateFilmPaymentTermsAction}
            submitLabel="支払条件を記録する"
            hint="変更できる人: 担当者・代表 ／ 変更は履歴に残ります。記録は入金確認ではありません。"
          >
            <input type="hidden" readOnly name="orderId" value={order.id} />
            <SelectField name="paymentTerms" label="支払条件" required includeBlank blankLabel="（選ぶ）" choices={TERMS_CHOICES.filter((choice) => choice.value !== 'undetermined')} />
            <TextField name="reason" label="変更の理由（任意）" width={360} />
          </ActionForm>
        ) : (
          <Waiting text="支払条件は担当者か代表が記録します。" />
        )}
      </div>
    );
  }

  if (!canAct && actor !== null) {
    return <Waiting text={`${waitingText(actor)}${waitDetail(action)}`} />;
  }

  switch (action.kind) {
    case 'po_check':
      return (
        <>
          <p>{action.registered ? 'セブン化学発注書の照合（7項目のチェック）がまだです。' : 'セブン化学発注書の本登録がまだです。'}</p>
          <p><Link className="p1-button p1-button--primary" href={`${projectPath(projectCode, 'orders')}#seven-po-${action.poId ?? ''}`}>発注一覧で照合する</Link></p>
        </>
      );
    case 'advance':
      return (
        <ActionForm action={transitionFilmSupplyOrderAction} submitLabel={action.label} hint={action.hint}>
          <OrderFields order={order} projectCode={projectCode} />
          <input type="hidden" readOnly name="to" value={action.to} />
          {action.evidenceNote === 'none' ? null : (
            <TextareaField
              name={EVIDENCE_NOTE_FIELD}
              label={action.to === 'ARTWORK_RECEIVED' ? '受け取ったデザインのメモ（履歴に保存）' : '証跡のメモ（履歴に保存）'}
              required={action.evidenceNote === 'required'}
              hint="例: 表面A・裏面B の入稿データを 11/20 に顧客からメールで受領（ファイル名 …）"
              rows={2}
            />
          )}
        </ActionForm>
      );
    case 'proof':
      return <ProofStep {...props} designKeys={action.designKeys} />;
    case 'approvals':
      return <ApprovalSlots {...props} designs={action.designs} />;
    case 'evidence_check':
      return (
        <>
          <p>PDF・画像の承認証跡が {action.count} 件、代表の確認を待っています。発行元と識別子を確かめて記録します。</p>
          <p><Link className="p1-button p1-button--primary" href={`${projectPath(projectCode, 'approvals')}#manual-verification`}>証跡を確認する</Link></p>
        </>
      );
    case 'payment_terms':
      return null;
    case 'maker_po_create':
      return (
        <ActionForm
          action={createMakerPoStepAction}
          submitLabel={`${order.code} のメーカー発注書を作る`}
          hint="明細・校了した版・支払条件はこの発注から写されます（スナップショット）。作成のあとに代表承認をします。"
        >
          <OrderFields order={order} projectCode={projectCode} />
          <input type="hidden" readOnly name="needsReadyTransition" value={action.needsReadyTransition ? 'true' : 'false'} />
          <TextField name="recipientAddress" label="メーカーの送信先メールアドレス" type="email" required width={360} autoComplete="off" spellCheck={false} placeholder="order@maker.example" />
          <div className="p1-row">
            <SelectField name="currency" label="通貨" choices={CURRENCY_CHOICES} defaultValue="JPY" width={200} />
            <TextField name="totalAmount" label="金額（税抜）" required width={200} placeholder="480000" autoComplete="off" />
          </div>
        </ActionForm>
      );
    case 'ceo_approve':
      return <CeoApproveStep {...props} poId={action.poId} />;
    case 'send':
      return (
        <MakerPoSendEvidenceForm
          action={recordMakerPoSendEvidenceAction}
          poId={action.poId}
          sendEvidenceChoices={[]}
          recipientAddress={props.maker?.recipientAddress ?? props.maker?.snapshot?.recipient?.address ?? null}
          ceoApprovedAt={props.maker?.ceoApprovedAt ?? null}
          orderCode={order.code}
        />
      );
    case 'send_verify':
      return (
        <ActionForm action={verifyMakerPoSendAction} submitLabel="送信の確認を記録する" hint="確認者と日時は自動で記録されます。">
          <input type="hidden" readOnly name="eventId" value={action.eventId} />
          <p>送信メールを自動では確かめられませんでした。宛先・送信日時・件名を原本で確認してください。</p>
          <SelectField name="result" label="確認の結果" required includeBlank blankLabel="（選ぶ）" choices={[{ value: 'confirmed', label: '確認済み（送信された）' }, { value: 'rejected', label: '相違あり（送信として認めない）' }]} />
          <TextareaField name="reasonNote" label="根拠（何を確かめたか）" required rows={2} />
        </ActionForm>
      );
    case 'send_stuck':
      return (
        <>
          <p>送信未確認のまま止まっています（証跡なしの送信）。証跡をそろえたうえで代表が判断します。</p>
          <p><Link href={`${projectPath(projectCode, 'maker-po')}#maker-order-${order.id}`}>メーカー発注の一覧で確認する</Link></p>
        </>
      );
    case 'accept':
      return <AcceptStep {...props} poId={action.poId} provisionalRecorded={action.provisionalRecorded} />;
    case 'deliver':
      return (
        <ActionForm action={recordDeliveryStepAction} submitLabel="納品を記録する" hint="明細ごとに受け取った数量を確かめます（初期値は発注数量）。">
          <OrderFields order={order} projectCode={projectCode} />
          {order.lines.map((line) => (
            <div key={line.id} className="p1-row">
              <input type="hidden" readOnly name="lineId" value={line.id} />
              <input type="hidden" readOnly name={`unit_${line.id}`} value={line.unit} />
              <TextField
                name={`quantity_${line.id}`}
                label={`明細${line.lineNumber} ${line.description}（${unitLabel(line.unit)}）の納品数量`}
                required
                width={200}
                defaultValue={formatQuantity(line.orderedQuantity).replace(/,/g, '')}
              />
            </div>
          ))}
          <TextField name="deliveredAt" label="納品日（任意）" type="date" width={200} />
        </ActionForm>
      );
    case 'receipt':
      return (
        <ActionForm
          action={assumeFilmReceiptAction}
          submitLabel="問題なしで完了する"
          hint={`受領の証跡がない場合に、問題なしとみなして完了します。状態は「${props.stateLabel('FILM_RECEIPT_ASSUMED_NO_ISSUE')}」になり、取り消せません。`}
          confirm={{
            title: '問題なしで完了しますか？',
            body: `発注 ${order.code} を、証跡なしで問題なしとみなして完了します。記録は取り消せません。`,
            summaryFields: ['note']
          }}
        >
          <OrderFields order={order} projectCode={projectCode} />
          <TextField name="note" label="確認メモ" required width={360} />
          <CheckboxField name="acknowledgeNoEvidence" label="証跡なしで問題なしとみなすことに同意します" required />
        </ActionForm>
      );
    case 'done':
      return (
        <>
          <p className="p1-done"><span aria-hidden="true">✓ </span>この発注はすべての手順が終わりました。</p>
          <p>手数料計算の準備は納品数量の確定で判定されます（フィルムのみの発注は充填の納品要件が対象外）。<Link href={projectPath(projectCode, 'deliveries')}>納品・手数料の一覧</Link></p>
        </>
      );
    case 'hold':
    case 'cancellation_review':
      return (
        <>
          <p>{action.kind === 'hold' ? 'この発注は保留中です。解除は代表が理由を書いて行います。' : 'この発注は取消確認中です。再開するか取消で終了するかを代表が決めます（取消で終了は元に戻せません）。'}</p>
          <p><Link className="p1-button p1-button--primary" href={`${projectPath(projectCode, 'orders')}#order-${order.id}`}>{action.kind === 'hold' ? '保留を解除する' : '取消確認を処理する'}</Link></p>
        </>
      );
    case 'change_review':
      return (
        <>
          <p>この発注は変更確認中です（承認後のロット表記・ファイルの変更）。再開する段階を選んで戻します。</p>
          <p><Link className="p1-button p1-button--primary" href={`${projectPath(projectCode, 'orders')}#order-${order.id}`}>再開する段階を選ぶ</Link></p>
        </>
      );
    case 'cancelled':
      return <p>この発注は取消で終了しました。これ以上の手順はありません。</p>;
    case 'unreadable':
      return <p>{action.reason}</p>;
    default:
      return null;
  }
}

function waitDetail(action: OrderFlowView['panel']['action']): string {
  switch (action.kind) {
    case 'maker_po_create':
      return '（代表がメーカー発注書を作ります）';
    case 'ceo_approve':
      return '（メーカー発注書の代表承認）';
    case 'evidence_check':
      return '（PDF・画像の承認証跡の確認）';
    case 'send_verify':
      return '（送信メールの確認）';
    case 'accept':
      return '（メーカー受注の最終確認）';
    case 'hold':
      return '（保留の解除は代表）';
    case 'cancellation_review':
      return '（取消確認の処理は代表）';
    default:
      return '';
  }
}

/** 5 校正: one design's proof file → 版 → 校了確認待ち, in one submit. */
function ProofStep({ order, projectCode, po, designKeys }: StepPanelProps & { designKeys: string[] }) {
  if (!po) return <p>セブン化学発注書が紐付いていないため、校正を登録できません。発注一覧で確認してください。</p>;
  return (
    <ActionForm
      action={submitProofStepAction}
      submitLabel="校正を登録して校了の確認へ"
      hint="メーカーの校正ゲラ（PDF・画像）を選びます。版の登録と、校了の確認待ちへの切り替えまでこの1回で行います。"
    >
      <OrderFields order={order} projectCode={projectCode} />
      <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po.id} />
      <input type="hidden" readOnly name="currentStatus" value={order.status} />
      <TextField
        name="designKey"
        label="デザイン名"
        required
        width={240}
        defaultValue={designKeys[0] ?? '表面A'}
        hint="この発注の中でデザインを区別する名前です（例: 表面A・裏面B）。"
      />
      <StepFileField label="校正ゲラのファイル" hint="5MBまで。形式はファイルから判別します。" />
      <TextField name="lotMarking" label="ロット表記（任意）" width={240} />
    </ActionForm>
  );
}

const SLOT_TEXT: Record<ApprovalSlotState, string> = {
  approved: '承認',
  pending_check: '代表の確認待ち',
  open: '未承認'
};

/** 6 校了: the 押印 slots — each organization's own approval, on its own evidence (B2). */
function ApprovalSlots({ order, projectCode, po, designs, role }: StepPanelProps & { designs: ApprovalSlotDesign[] }) {
  if (designs.length === 0) return <p>承認する版がまだありません（校正の登録が先です）。</p>;
  if (!po) return <p>セブン化学発注書が紐付いていません。発注一覧で確認してください。</p>;
  return (
    <div className="p1-approvals">
      {designs.map((design) => (
        <div key={design.revisionId} className="p1-approval-design">
          <p className="p1-approval-head">デザイン <span translate="no">{design.designKey}</span>・第{design.revisionNo}版</p>
          <div className="p1-seal-row">
            {(['customer', 'seven'] as const).map((organization) => {
              const state = design[organization];
              const name = organization === 'customer' ? '顧客' : 'セブン化学';
              return (
                <div key={organization} className={`p1-seal-slot p1-seal-slot--${state}`}>
                  <p className="p1-seal-name">{name}の承認</p>
                  {state === 'approved' ? (
                    <p className="p1-seal" aria-label={`${name} 承認済み`}><span className="p1-seal-mark">承認</span></p>
                  ) : state === 'pending_check' ? (
                    <Waiting text={role === 'admin' ? '証跡の確認が必要です（上の「証跡を確認する」）' : '代表の確認を待っています'} />
                  ) : (
                    <ActionForm action={recordApprovalStepAction} submitLabel={`${name}の承認を記録する`}>
                      <OrderFields order={order} projectCode={projectCode} />
                      <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po.id} />
                      <input type="hidden" readOnly name="revisionId" value={design.revisionId} />
                      <input type="hidden" readOnly name="designKey" value={design.designKey} />
                      <input type="hidden" readOnly name="organization" value={organization} />
                      <StepFileField
                        label={`${name}が送った承認メール`}
                        hint={`.eml 推奨（識別子と日時を自動で読み取ります）。PDF・画像は代表の確認が必要です。選べるのは${name}が発行した証跡だけです。`}
                      />
                      <TextField name="evidenceIdentifier" label="PDF・画像のとき: 承認証跡の識別子（8文字以上）" width={320} autoComplete="off" spellCheck={false} />
                    </ActionForm>
                  )}
                  <p className="p1-seal-state">{SLOT_TEXT[state]}</p>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 8 代表承認 (stage 1): the facts of the frozen paper and the one approval button. */
function CeoApproveStep({ order, maker, poId, ...rest }: StepPanelProps & { poId: string }) {
  const snapshot = maker?.snapshot;
  const terms = currentPaymentTerms({ order, paymentGate: null });
  const amount = snapshot?.amounts ? formatAmount(snapshot.amounts.currency, snapshot.amounts.totalAmount) : null;
  return (
    <div className="p1-approve">
      <dl className="p1-facts">
        <dt>金額</dt><dd>{amount ?? '未記録'}</dd>
        <dt>支払条件</dt><dd>{terms ? PAYMENT_TERMS_LABELS[terms] ?? terms : '未記録'}（入金確認は別の手順です）</dd>
        <dt>送信先</dt><dd translate="no">{snapshot?.recipient?.address ?? maker?.recipientAddress ?? '未記録'}</dd>
        <dt>明細</dt>
        <dd>
          {(snapshot?.items ?? []).length === 0 ? '—' : (
            <ul className="p1-plain-list">
              {snapshot!.items!.map((item) => (
                <li key={item.lineNumber}>{item.lineNumber}. {item.description} {formatQuantityWithUnit(item.orderedQuantity, item.unit)}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt>校了した版</dt>
        <dd>
          {(snapshot?.specs?.artworkFiles ?? []).length === 0 ? '—' : (
            <ul className="p1-plain-list">
              {snapshot!.specs!.artworkFiles.map((file) => (
                <li key={`${file.designKey}-${file.revisionNo}`}><span translate="no">{file.designKey}</span> 第{file.revisionNo}版 <span className="p1-hash" translate="no">SHA-256 {file.fileSha256.slice(0, 4)}…{file.fileSha256.slice(-4)}</span></li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      {amount === null ? (
        <p className="p1-blocked-inline">金額が記録されていないため承認できません。メーカー発注書を作り直してください。</p>
      ) : terms === null || terms === 'undetermined' ? (
        <p className="p1-blocked-inline">支払条件が「未定」のため承認できません。</p>
      ) : (
        <ActionForm
          action={approveMakerPoAction}
          submitLabel={`${order.code} のメーカー発注書を代表承認する`}
          hint="承認すると取り消せません。内容を直すときは、メーカー発注の一覧で発注書を取り消して作り直します。"
        >
          <input type="hidden" readOnly name="poId" value={poId} />
          <input type="hidden" readOnly name="expectedPaymentTerms" value={terms} />
        </ActionForm>
      )}
      {rest.role ? null : null}
    </div>
  );
}

/** 10 メーカー受注確認: staff 仮 with the maker's reply; the representative confirms (最終). */
function AcceptStep({ order, projectCode, po, role, documents, poId, provisionalRecorded }: StepPanelProps & { poId: string; provisionalRecorded: boolean }) {
  const final = role === 'admin';
  const evidence = documents
    .filter((document) => document.documentType === 'acceptance_evidence' && document.filmSupplyOrderId === order.id)
    .at(-1);
  const version = evidence?.versions.at(-1) ?? null;
  return (
    <ActionForm
      action={recordAcceptanceStepAction}
      submitLabel={final ? 'メーカーの受注を確定する（最終受入）' : '受入記録（仮）を残す'}
      hint={final
        ? '受領証跡を確認済みにして最終受入を記録します。確認者と日時は自動で記録されます。'
        : 'メーカーからの受注確認（メール・書面）を登録し、仮の受入として記録します。確定は代表です。'}
    >
      <OrderFields order={order} projectCode={projectCode} />
      <input type="hidden" readOnly name="poId" value={poId} />
      <input type="hidden" readOnly name="sevenPurchaseOrderId" value={po?.id ?? ''} />
      <input type="hidden" readOnly name="mode" value={final ? 'final' : 'provisional'} />
      {final && version ? (
        <>
          <input type="hidden" readOnly name="evidenceDocumentVersionId" value={version.id} />
          <input type="hidden" readOnly name="evidenceDocumentId" value={evidence!.id} />
          <input type="hidden" readOnly name="evidenceVerified" value={evidence!.verificationStatus === 'verified' ? 'true' : 'false'} />
          <p>受領証跡: {version.originalFilename}（{evidence!.verificationStatus === 'verified' ? '確認済み' : '未確認'}）{provisionalRecorded ? '・受入記録（仮）あり' : ''}</p>
        </>
      ) : (
        <StepFileField label="メーカーの受注確認（受領証跡）" hint="メーカーからの返信メール（.eml）や書面。5MBまで。" />
      )}
    </ActionForm>
  );
}
