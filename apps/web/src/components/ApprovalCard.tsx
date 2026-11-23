import { ActionForm } from './ActionForm';
import { DateTextField, SelectField, TextareaField, TextField } from './fields';
import { Bilingual } from './Bilingual';
import { MobileFold } from './MobileFold';
import { EvidenceLineText, hasEvidenceWarning, SenderFromLine, SenderStatusNote, SenderWarningNotes } from './EvidenceFacts';
import { approveFromCardAction, recordRequestedDeliveryDateAction, returnMakerPoAction } from '../app/approval-actions';
import { approvalCardNeeds, approvalEvidenceStamp, declarationLineOf } from '../lib/approval-card';
import type { ApprovalCardView, ApprovalNotice, CardOrganization, SealState } from '../lib/approval-card';
import { approvalNoticeText } from '../lib/approval-notice';
import { PAYMENT_TERMS_LABELS } from '../lib/maker-po-data';
import { ISSUER_ENTITY_LABELS, EVIDENCE_SOURCE_LABELS, formatTimestamp } from '../lib/vocabulary';
import { webErrorText } from '../lib/error-dictionary';
import { ISSUER_DECLARED_LABEL } from '../lib/sender-check';
import { ERROR_DICTIONARY } from '../lib/error-dictionary-data';
import { dateCell, DeliveryTermsRows } from './OrderTermsSection';
import type { TermCell } from './OrderTermsSection';

/** P2 R30 / P-8: the card's 条件ブロック cells; the web fallback card has none (「—」). */
function termCells(card: ApprovalCardView): { requested: TermCell; planned: TermCell; quantity: TermCell; amount: TermCell } {
  const terms = card.deliveryTerms;
  const unknown: TermCell = { missing: 'unknown' };
  if (!terms) return { requested: unknown, planned: unknown, quantity: unknown, amount: unknown };
  const date = (value: string | null | undefined): TermCell => (value === undefined ? unknown : dateCell(value, true));
  const seven = terms.sevenPo;
  const fact = (value: string | null): TermCell => (value ? { text: value } : { missing: 'unrecorded' });
  return {
    requested: date(terms.requestedDeliveryDate),
    planned: date(terms.plannedDeliveryDate),
    quantity: seven === 'unlinked' ? { missing: 'unlinked' } : seven === 'unknown' ? unknown : fact(seven.quantityDisplay),
    amount: seven === 'unlinked' ? { missing: 'unlinked' } : seven === 'unknown' ? unknown : fact(seven.amountDisplay)
  };
}

/** P0 R09: a known code is said in the dictionary's words; the API's own text only for an unknown one. */
function noteText(code: string, message: string): string {
  return ERROR_DICTIONARY[code] ? webErrorText(code).message : message || webErrorText(code).message;
}

/**
 * P1 R24 (REDESIGN §5-4): the representative's approval card. Every fact the
 * approval rests on, read from the paper's frozen snapshot (not "the order now"):
 * amount, 支払条件, lines, the approved 版 with its hash, the 押印欄 — one slot
 * per organization, stamped only when THAT organization's own evidence was
 * accepted (B2) — the セブン化学発注書 and the recipient. The approve button names
 * the paper (M13) and is the only confirmation (no extra dialog). 差し戻す
 * asks for the reason. Korean lines in the bilingual mode (R29).
 */
const SEAL_TEXT: Record<SealState, { ja: string; ko: string }> = {
  approved: { ja: '承認', ko: '승인' },
  pending_manual_verification: { ja: '確認待ち', ko: '확인 대기' },
  rejected: { ja: '相違あり', ko: '불일치' },
  revoked: { ja: '取消', ko: '취소' },
  missing: { ja: '未承認', ko: '미승인' }
};

function Seal({ name, ko, organization }: { name: string; ko: string; organization: CardOrganization | null }) {
  const state: SealState = organization?.state ?? 'missing';
  const evidence = organization?.evidence ?? null;
  const declaration = declarationLineOf(evidence);
  const warnings = evidence?.warnings ?? [];
  const facts = evidence ?? {};
  const warn = hasEvidenceWarning(declaration, facts);
  return (
    <div className={`p1-seal-slot p1-seal-slot--${state === 'approved' ? 'approved' : 'open'}${warn ? ' p4w3-seal--warning' : ''}`} data-seal={name}>
      <p className="p1-seal-name"><Bilingual ja={name} ko={ko} /></p>
      {state === 'approved' ? (
        <p className="p1-seal" aria-label={`${name} 承認済み`}><span className="p1-seal-mark">承認</span></p>
      ) : (
        <p className="p1-seal-empty"><Bilingual ja={SEAL_TEXT[state].ja} ko={SEAL_TEXT[state].ko} /></p>
      )}
      {organization?.eventTime ? <p className="p1-seal-state">{formatTimestamp(organization.eventTime)}</p> : null}
      {evidence ? (
        <p className="p1-seal-state">
          {EVIDENCE_SOURCE_LABELS[evidence.evidenceSource as keyof typeof EVIDENCE_SOURCE_LABELS] ?? '証跡'}
          {' ・ '}{ISSUER_DECLARED_LABEL}{' '}
          {ISSUER_ENTITY_LABELS[evidence.issuerEntity as keyof typeof ISSUER_ENTITY_LABELS] ?? '不明'}
        </p>
      ) : null}
      {declaration ? <p className="p1-seal-state"><EvidenceLineText line={declaration} kind="declaration" /></p> : null}
      {evidence?.filename ? <p className="p1-seal-state p4-seal-file">ファイル <span translate="no">{evidence.filename}</span></p> : null}
      <SenderFromLine facts={facts} className="p1-seal-state p4w3-seal-from" />
      <SenderStatusNote facts={facts} className="p1-seal-state" />
      {evidence?.uploadedBy ? (
        <p className="p1-seal-state p4w3-seal-uploader">
          登録した人 {evidence.uploadedBy}{evidence.uploadedAt ? `（${formatTimestamp(evidence.uploadedAt)}）` : ''}
        </p>
      ) : null}
      <SenderWarningNotes warnings={warnings} className="p1-seal-state" />
    </div>
  );
}

/** p4/web3 (a): the 押印欄 shows the first design; a warning on another design's evidence is said under it. */
function otherDesignWarnings(card: ApprovalCardView): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  card.designs.slice(1).forEach((design) => {
    for (const [organization, label] of [['customer', '顧客'], ['seven', 'セブン化学']] as const) {
      const evidence = design[organization].evidence;
      const line = declarationLineOf(evidence);
      const warnings = evidence?.warnings ?? [];
      if (line?.tone !== 'warning' && warnings.length === 0) continue;
      const parts = [line?.tone === 'warning' ? line.label : null, ...warnings.map((warning) => warning.ja)].filter((part): part is string => Boolean(part));
      out.push({ key: `${design.designKey}-${organization}`, text: `デザイン ${design.designKey} の${label}の証跡: ${parts.join(' ')}` });
    }
  });
  return out;
}

/** p4/web3 (b) / web2b review L-1: why the last approval from this card stopped (kept across the redraw). */
function ApprovalStopNotice({ notice, status }: { notice: ApprovalNotice | null | undefined; status: string }) {
  if (!notice || status !== 'DRAFT') return null;
  const text = approvalNoticeText(notice.reason);
  return (
    <p className="p1-banner p4w3-notice" role="alert" data-notice={notice.reason}>
      <span aria-hidden="true">⚠ </span>
      {formatTimestamp(notice.at)} の代表承認は止まりました。<Bilingual ja={text.ja} ko={text.ko} />
    </p>
  );
}

/** p5 R2: a one-line summary of the folded evidence, so the folded card still says what stands. */
function FoldSummary({ card }: { card: ApprovalCardView }) {
  const first = card.designs[0] ?? null;
  const say = (organization: CardOrganization | null) => SEAL_TEXT[organization?.state ?? 'missing'].ja;
  return (
    <>
      <Bilingual ja="明細・校了した版・押印・送信先" ko="명세·확정된 판·날인·송신처" />
      <span className="p1-muted-inline"> ／ 顧客 {say(first?.customer ?? null)}・セブン化学 {say(first?.seven ?? null)}</span>
    </>
  );
}

/**
 * p5 R2: the evidence stays open on a phone when anything in it needs the representative's eyes — a warning on a stamp (or on another
 * design's), a stamp that is not an approval, a typed recipient outside the maker master or no address, a セブン化学発注書 not checked,
 * an artwork file that differs from the approved version.
 */
export function foldMustStayOpen(card: ApprovalCardView, otherDesignWarningCount: number): boolean {
  if (otherDesignWarningCount > 0) return true;
  const first = card.designs[0] ?? null;
  for (const organization of [first?.customer ?? null, first?.seven ?? null]) {
    if ((organization?.state ?? 'missing') !== 'approved') return true;
    const evidence = organization?.evidence ?? null;
    if (hasEvidenceWarning(declarationLineOf(evidence), evidence ?? {})) return true;
  }
  if (card.recipient.address && (!card.recipient.isEmail || card.recipient.inMakerMaster === false)) return true;
  if (card.sevenPo && card.sevenPo.verificationStatus !== 'verified') return true;
  if (card.artworkFiles.some((file) => file.matchesApprovedRevision === false)) return true;
  return false;
}

export function ApprovalCard({ card, korean }: { card: ApprovalCardView; korean: boolean }) {
  const paperName = card.displayNumber ? `メーカー発注書 ${card.displayNumber}` : `${card.orderCode} のメーカー発注書`;
  const terms = card.paymentTerms ? PAYMENT_TERMS_LABELS[card.paymentTerms] ?? card.paymentTerms : '未記録';
  const cells = termCells(card);
  const needs = approvalCardNeeds(card);
  const evidenceStamp = approvalEvidenceStamp(card);
  const elsewhere = otherDesignWarnings(card);
  return (
    <section className="p1-card" aria-labelledby="approval-card-title" data-korean={korean ? 'on' : undefined}>
      <h3 id="approval-card-title" className="p1-card-title">
        <Bilingual ja={`${paperName}を代表承認`} ko="대표 승인" />
      </h3>
      <ApprovalStopNotice notice={card.notice} status={card.status} />
      <dl className="p1-facts p5-card-facts">
        <dt><Bilingual ja="金額" ko="금액" /></dt>
        <dd className="p1-figure">{card.amountDisplay ?? '未入力'}</dd>
        <dt><Bilingual ja="支払条件" ko="결제 조건" /></dt>
        <dd>{terms}<span className="p1-muted-inline"> ・ 入金確認は別の手順です</span></dd>
        {/* P2 R30 / P-8: the same 条件ブロック as the order screen (DESIGN §3). */}
        <DeliveryTermsRows
          requested={cells.requested}
          planned={cells.planned}
          quantity={cells.quantity}
          amount={cells.amount}
          emptyHint={<span className="p1-muted-inline">（承認前に<a href="#order-terms">発注の条件</a>で記録できます）</span>}
        />
      </dl>
      <p className="p1-note p2-terms-fix p5-card-fix">
        {card.status === 'DRAFT' ? (
          <Bilingual
            ja="承認すると、この納期・数量で固定されます。変えるにはメーカー発注書を取り消して作り直します。"
            ko="승인하면 이 납기·수량으로 고정됩니다. 바꾸려면 제조사 발주서를 취소하고 다시 만드세요."
          />
        ) : (
          <Bilingual ja="納期・数量は代表承認で固定されています。" ko="납기·수량은 대표 승인으로 고정되어 있습니다." />
        )}
      </p>
      {/* p5 R2 / M12: the long evidence folds on a phone (open on a wide screen); the inputs and the buttons below stay outside. */}
      <MobileFold
        keepOpen={foldMustStayOpen(card, elsewhere.length)}
        summary={<FoldSummary card={card} />}
      >
      <dl className="p1-facts">
        <dt><Bilingual ja="明細" ko="명세" /></dt>
        <dd>
          {card.items.length === 0 ? '—' : (
            <ol className="p1-plain-list">
              {card.items.map((item) => (
                <li key={item.lineNumber}>
                  <span className="p1-line-no-inline">{item.lineNumber}</span> {item.description}
                  <span className="p1-figure"> {item.quantityDisplay}</span>
                </li>
              ))}
            </ol>
          )}
        </dd>
        <dt><Bilingual ja="校了した版" ko="확정된 판" /></dt>
        <dd>
          {card.artworkFiles.length === 0 ? '—' : (
            <ul className="p1-plain-list">
              {card.artworkFiles.map((file) => (
                <li key={`${file.designKey}-${file.revisionNo}`}>
                  <span translate="no">{file.designKey}</span> 第{file.revisionNo}版
                  {file.filename ? <> <span translate="no">{file.filename}</span></> : null}
                  <span className="p1-hash" translate="no"> SHA-256 {file.sha256.slice(0, 4)}…{file.sha256.slice(-4)}</span>
                  {file.matchesApprovedRevision === true ? ' ✓ 校了した版と一致' : file.matchesApprovedRevision === false ? ' ✕ 校了した版と違います' : ''}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      <div className="p1-seal-row p1-seal-row--three" role="group" aria-label="承認の押印欄">
        <Seal name="顧客" ko="고객" organization={card.designs[0]?.customer ?? null} />
        <Seal name="セブン化学" ko="세븐화학" organization={card.designs[0]?.seven ?? null} />
        <div className="p1-seal-slot p1-seal-slot--open">
          <p className="p1-seal-name"><Bilingual ja="代表" ko="대표" /></p>
          <p className="p1-seal-empty">{card.status === 'DRAFT' ? '未承認' : '承認済み'}</p>
        </div>
      </div>
      {elsewhere.map((entry) => (
        <p key={entry.key} className="field-warning" role="note" data-warning-design={entry.key}><span aria-hidden="true">⚠</span> {entry.text}</p>
      ))}
      {card.designs.length > 1 ? (
        <p className="p1-muted">デザインが{card.designs.length}つあります。押印欄は最初のデザインです（すべてのデザインの承認がそろうと校了です: {card.dualApproved ? 'そろっています' : 'そろっていません'}）。</p>
      ) : null}

      <dl className="p1-facts">
        <dt><Bilingual ja="セブン化学発注書" ko="세븐화학 발주서" /></dt>
        <dd>
          {card.sevenPo
            ? <><span translate="no">{card.sevenPo.poNumber ?? '（番号は閲覧権限なし）'}</span>{card.sevenPo.officialRegisteredAt ? ` ・ 本登録 ${formatTimestamp(card.sevenPo.officialRegisteredAt)}` : ''}{card.sevenPo.verificationStatus === 'verified' ? ' ・ 照合OK' : ' ・ 照合未完了'}</>
            : '紐付けなし'}
        </dd>
        <dt><Bilingual ja="送信先" ko="송신처" /></dt>
        <dd>
          <span translate="no">{card.recipient.address ?? '未記録'}</span>{card.recipient.address && !card.recipient.isEmail ? ' ✕ メールアドレスではありません' : ''}
          {/* P2 contract v1.1 L2: where the address comes from (a typed address is allowed, but visible). */}
          {card.recipient.address && card.recipient.inMakerMaster === true ? (
            <span className="p2-terms-source p1-muted-inline"><span aria-hidden="true">✓ </span><Bilingual ja="メーカーマスターの宛先" ko="제조사 마스터의 수신처" /></span>
          ) : null}
          {card.recipient.address && card.recipient.inMakerMaster === false ? (
            <span className="p2-terms-source field-warning">
              <span aria-hidden="true">⚠</span>{' '}
              <Bilingual
                ja="直接入力の宛先（メーカーマスター外）です。メーカーのメールアドレスと一致しているか確かめてから承認してください。"
                ko="직접 입력한 수신처(제조사 마스터 외)입니다. 제조사의 메일 주소와 일치하는지 확인한 뒤 승인하세요."
              />
            </span>
          ) : null}
        </dd>
      </dl>
      </MobileFold>

      {needs.amount || needs.requestedDeliveryDate ? (
        <div className="p4-needs p5-card-needs" role="group" aria-label="承認の前に入力するもの">
          <p className="p4-needs-title">
            <Bilingual ja="承認の前に、次を入力してください" ko="승인 전에 다음을 입력하세요" />
          </p>
          <ul className="p1-plain-list">
            {needs.requestedDeliveryDate ? (
              <li data-need="requestedDeliveryDate">
                <Bilingual
                  ja="希望納期が記録されていません。下の欄に入れて「希望納期を記録する」を押すと、この画面が更新されます。"
                  ko="희망 납기가 기록되어 있지 않습니다. 아래 칸에 입력하고 「希望納期を記録する」를 누르면 이 화면이 갱신됩니다."
                />
              </li>
            ) : null}
            {needs.amount ? (
              <li data-need="amount">
                <Bilingual
                  ja="金額が入力されていません。承認ボタンの上の「金額」に入れると承認できます。"
                  ko="금액이 입력되지 않았습니다. 승인 버튼 위의 「金額」에 입력하면 승인할 수 있습니다."
                />
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {needs.otherBlockers.length > 0 ? (
        <div className="p1-blocked p5-card-needs" role="group" aria-label="承認できない理由">
          <p className="p1-blocked-title"><span aria-hidden="true">✕ </span><Bilingual ja="承認できません" ko="승인할 수 없습니다" /></p>
          <ul className="p1-plain-list">
            {needs.otherBlockers.map((blocker) => {
              const text = webErrorText(blocker.code);
              return (
                <li key={blocker.code}>
                  {noteText(blocker.code, blocker.message)}
                  {korean && text.messageKo ? <span className="form-result-ko" lang="ko">{text.messageKo}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {card.warnings.filter((warning) => warning.code !== 'MAKER_PO_AMOUNT_MISSING').map((warning) => (
        <p key={warning.code} className="field-warning p5-card-needs"><span aria-hidden="true">⚠</span> {noteText(warning.code, warning.message)}</p>
      ))}

      <p className="p1-note p5-card-confirm-note">
        <Bilingual
          ja="承認すると取り消せません。内容を直すときは「差し戻す」を使います。"
          ko="승인 후에는 되돌릴 수 없습니다. 고칠 내용이 있으면 「差し戻す(반려)」를 누르세요."
        />
      </p>
      <div className="p1-card-actions p5-card-actions">
        {needs.requestedDeliveryDate && card.status === 'DRAFT' && card.orderId ? (
          <ActionForm
            action={recordRequestedDeliveryDateAction}
            submitLabel="希望納期を記録する"
            hint="お客様が希望する納品日です。記録すると承認カードが読み込み直され、金額の入力と承認に進めます。"
            hintKo="고객이 희망하는 납품일입니다. 기록하면 승인 카드가 다시 로드되어 금액 입력과 승인으로 진행할 수 있습니다."
          >
            <input type="hidden" readOnly name="orderId" value={card.orderId} />
            <DateTextField name="requestedDeliveryDate" label="希望納期" required hint="例 2026/12/01（日本時間の日付）" />
          </ActionForm>
        ) : null}
        {needs.canSubmitApproval && card.expectedPaymentTerms ? (
          // web2b review L-4: no draft — a redrawn card (new hash) never gets an old amount back.
          <ActionForm action={approveFromCardAction} submitLabel={`${card.displayNumber ?? card.orderCode} を代表承認する`} draft={false}>
            <input type="hidden" readOnly name="poId" value={card.poId} />
            <input type="hidden" readOnly name="expectedPaymentTerms" value={card.expectedPaymentTerms} />
            {card.expectedSnapshotSha256 ? <input type="hidden" readOnly name="expectedSnapshotSha256" value={card.expectedSnapshotSha256} /> : null}
            {/* p4/web3 (b): the evidence set this card showed — compared only to say why a 409 stopped the approval. */}
            {evidenceStamp ? <input type="hidden" readOnly name="expectedEvidenceStamp" value={evidenceStamp} /> : null}
            {/* P2 verifier M1: the 納期・数量 this card showed (re-checked before the approval). */}
            {card.termsStamp ? <input type="hidden" readOnly name="expectedTermsStamp" value={card.termsStamp} /> : null}
            {/* P4 H4①: a paper without an amount cannot be approved (the API refuses it, AMOUNT_REQUIRED) — the
                amount is typed here, saved into the paper pinned to the content this card shows, and approved with it. */}
            {needs.amount ? <input type="hidden" readOnly name="amountRequired" value="true" /> : null}
            <div className="p1-row">
              <SelectField name="currency" label="通貨" choices={[{ value: 'JPY', label: '日本円（JPY）' }, { value: 'USD', label: '米ドル（USD）' }, { value: 'CNY', label: '人民元（CNY）' }, { value: 'KRW', label: '韓国ウォン（KRW）' }]} defaultValue="JPY" width={180} />
              <TextField
                name="totalAmount"
                label={needs.amount ? '金額（数字のみ）' : '金額を直す（数字のみ・任意）'}
                required={needs.amount}
                width={200}
                autoComplete="off"
                placeholder="480000"
                inputMode="decimal"
              />
            </div>
          </ActionForm>
        ) : null}
        {card.canReturn ? (
          <ActionForm
            action={returnMakerPoAction}
            submitLabel="差し戻す"
            draft={false}
            tone="danger"
            confirm={{
              title: '差し戻しますか？',
              body: `${paperName}を代表承認せずに戻します。発注書は取り消され、理由が履歴に残ります。内容を直して作り直します。`,
              summaryFields: ['reason']
            }}
          >
            <input type="hidden" readOnly name="poId" value={card.poId} />
            <TextareaField name="reason" label="差し戻しの理由" required rows={2} hint="例: 金額が見積と違います（1000字まで）" />
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}
