import { ActionForm } from './ActionForm';
import { TextareaField } from './fields';
import { Bilingual } from './Bilingual';
import { approveFromCardAction, returnMakerPoAction } from '../app/approval-actions';
import type { ApprovalCardView, CardOrganization, SealState } from '../lib/approval-card';
import { PAYMENT_TERMS_LABELS } from '../lib/maker-po-data';
import { ISSUER_ENTITY_LABELS, EVIDENCE_SOURCE_LABELS, formatTimestamp } from '../lib/vocabulary';
import { webErrorText } from '../lib/error-dictionary';

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
  const mismatch = evidence?.issuerMatchesOrganization === false;
  return (
    <div className={`p1-seal-slot p1-seal-slot--${state === 'approved' ? 'approved' : 'open'}`}>
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
          {' ・ 発行元 '}
          {ISSUER_ENTITY_LABELS[evidence.issuerEntity as keyof typeof ISSUER_ENTITY_LABELS] ?? '不明'}
          {mismatch ? ' ✕ 承認組織と不一致' : evidence.issuerMatchesOrganization ? ' ✓' : ''}
        </p>
      ) : null}
    </div>
  );
}

export function ApprovalCard({ card, korean }: { card: ApprovalCardView; korean: boolean }) {
  const paperName = card.displayNumber ? `メーカー発注書 ${card.displayNumber}` : `${card.orderCode} のメーカー発注書`;
  const terms = card.paymentTerms ? PAYMENT_TERMS_LABELS[card.paymentTerms] ?? card.paymentTerms : '未記録';
  return (
    <section className="p1-card" aria-labelledby="approval-card-title" data-korean={korean ? 'on' : undefined}>
      <h3 id="approval-card-title" className="p1-card-title">
        <Bilingual ja={`${paperName}を代表承認`} ko="대표 승인" />
      </h3>
      <dl className="p1-facts">
        <dt><Bilingual ja="金額" ko="금액" /></dt>
        <dd className="p1-figure">{card.amountDisplay ?? '未記録'}{card.amountDisplay ? '（税込）' : ''}</dd>
        <dt><Bilingual ja="支払条件" ko="결제 조건" /></dt>
        <dd>{terms}<span className="p1-muted-inline"> ・ 入金確認は別の手順です</span></dd>
        <dt><Bilingual ja="希望納期" ko="희망 납기" /></dt>
        <dd>未記録<span className="p1-muted-inline">（納期の記録欄はまだありません）</span></dd>
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
        <dd translate="no">{card.recipient.address ?? '未記録'}{card.recipient.address && !card.recipient.isEmail ? ' ✕ メールアドレスではありません' : ''}</dd>
      </dl>

      {card.blockers.length > 0 ? (
        <div className="p1-blocked" role="group" aria-label="承認できない理由">
          <p className="p1-blocked-title"><span aria-hidden="true">✕ </span><Bilingual ja="承認できません" ko="승인할 수 없습니다" /></p>
          <ul className="p1-plain-list">
            {card.blockers.map((blocker) => {
              const text = webErrorText(blocker.code);
              return (
                <li key={blocker.code}>
                  {blocker.message || text.message}
                  {korean && text.messageKo ? <span className="form-result-ko" lang="ko">{text.messageKo}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {card.warnings.map((warning) => (
        <p key={warning.code} className="field-warning"><span aria-hidden="true">⚠</span> {warning.message || webErrorText(warning.code).message}</p>
      ))}

      <p className="p1-note">
        <Bilingual
          ja="承認すると取り消せません。内容を直すときは「差し戻す」を使います。"
          ko="승인 후에는 되돌릴 수 없습니다. 고칠 내용이 있으면 「差し戻す(반려)」를 누르세요."
        />
      </p>
      <div className="p1-card-actions">
        {card.canApprove && card.expectedPaymentTerms ? (
          <ActionForm action={approveFromCardAction} submitLabel={`${card.displayNumber ?? card.orderCode} を代表承認する`}>
            <input type="hidden" readOnly name="poId" value={card.poId} />
            <input type="hidden" readOnly name="expectedPaymentTerms" value={card.expectedPaymentTerms} />
            {card.expectedSnapshotSha256 ? <input type="hidden" readOnly name="expectedSnapshotSha256" value={card.expectedSnapshotSha256} /> : null}
          </ActionForm>
        ) : null}
        {card.canReturn ? (
          <ActionForm
            action={returnMakerPoAction}
            submitLabel="差し戻す"
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
