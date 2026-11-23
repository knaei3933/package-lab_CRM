import { ActionForm } from './ActionForm';
import { DraftAutosave } from './DraftAutosave';
import { RoleGate } from './RoleGate';
import { CheckboxField, DateTextField, SelectField, TextField } from './fields';
import { registerSevenPurchaseOrderAction, verifySevenPurchaseOrderAction } from '../app/actions';

/**
 * P4 §0: the セブン化学発注書 本登録 and 照合 forms, moved here from the old
 * 発注の一覧 table so steps 1–2 of the order screen are done on the order
 * screen (the step used to link out to /orders#seven-po-…). Same server actions,
 * same endpoints (POST …/official-registration, …/verification-checklist).
 */

const QUOTE_MATCH_CHOICES = [
  { value: 'true', label: '見積と一致している' },
  { value: 'false', label: '見積と一致していない' }
];

export function SevenPoRegisterForm({ poId, poNumber, role }: { poId: string; poNumber: string | null; role: string | null }) {
  return (
    <RoleGate role={role} operation="seven_po:register" label="本登録日の記録">
      <ActionForm
        action={registerSevenPurchaseOrderAction}
        submitLabel="本登録する"
        submitContext={poNumber ?? undefined}
        confirm={{
          title: '本登録日を記録しますか？',
          body: 'このセブン化学発注書の本登録日を記録します。本登録はフィルム発注を進める前提の一つです。記録した本登録日をあとから変更できるのは代表者だけです。',
          tone: 'primary',
          summaryFields: ['officialRegisteredAt']
        }}
      >
        <input type="hidden" readOnly name="poId" value={poId} />
        <DateTextField name="officialRegisteredAt" label="本登録日" required width={200} />
      </ActionForm>
    </RoleGate>
  );
}

export function SevenPoChecklistForm({ poId, poNumber, role }: { poId: string; poNumber: string | null; role: string | null }) {
  return (
    <RoleGate role={role} operation="seven_po:verify" label="チェックリストの記録">
      <ActionForm
        action={verifySevenPurchaseOrderAction}
        submitLabel="照合チェックを記録する"
        submitContext={poNumber ?? undefined}
        hint="必須の確認項目をすべて埋めてください。見積と一致していない場合は「相違あり・確認中」になり、この発注は進められません。"
        confirm={{
          title: '発注書の照合チェックを記録しますか？',
          body: 'このセブン化学発注書の照合として、チェック内容を記録します。突合結果が「見積と一致していない」のときは「相違あり・確認中」になります。記録し直すと最新の内容で上書きされ、以前の記録は履歴に残ります。',
          tone: 'primary',
          summaryFields: ['quoteMatchesPo', 'quoteCompared', 'uncertain', 'confirmationReplyRecorded', 'documentNumber', 'issueDate']
        }}
      >
        <input type="hidden" readOnly name="poId" value={poId} />
        <DraftAutosave name={`po-check-${poId}`} />
        <div className="p4w2-check-grid">
          <CheckboxField name="issuerNameRecorded" label="発行者名を確認した" />
          <TextField name="issuerName" label="発行者名" width={200} />
          <CheckboxField name="documentNumberRecorded" label="文書番号を確認した" />
          <TextField name="documentNumber" label="文書番号" width={200} />
          <CheckboxField name="issueDateRecorded" label="発行日を確認した" />
          <DateTextField name="issueDate" label="発行日" width={200} />
          <CheckboxField name="sendingChannelRecorded" label="送信経路を確認した" />
          <TextField name="sendingChannel" label="送信経路" width={200} />
          <CheckboxField name="pastTransactionCompared" label="過去取引と突合した" />
          <TextField name="pastTransactionNote" label="突合メモ（過去取引）" width={200} />
          <CheckboxField name="quoteCompared" label="見積と突合した" />
          <SelectField name="quoteMatchesPo" label="突合結果" required includeBlank blankLabel="（選ぶ）" choices={QUOTE_MATCH_CHOICES} width={220} />
          <TextField name="quoteComparisonNote" label="突合メモ（見積）" width={200} />
          <TextField name="tamperHints" label="改ざん疑いのメモ（任意・参考記録）" width={240} />
          <CheckboxField name="uncertain" label="確認が不確かだった" />
          <CheckboxField name="confirmationReplyRecorded" label="確認の返信を記録した（不確かな場合必須）" />
          <TextField name="confirmationReplyNote" label="返信メモ" width={200} />
          <TextField name="verificationNote" label="検証メモ" width={240} />
        </div>
      </ActionForm>
    </RoleGate>
  );
}
