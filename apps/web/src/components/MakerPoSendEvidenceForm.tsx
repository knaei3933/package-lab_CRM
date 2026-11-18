'use client';

import { useActionState, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { FormAction } from './ActionForm';
import { SelectField, TextField } from './fields';
import { datetimeLocalToIso } from '../lib/datetime';
import type { EmlFormEditedFields, EmlFormValues } from '../lib/eml-form';
import {
  insertMakerPoMailSubject,
  isSentAtBeforeCeoApproval,
  makerPoMailSubject,
  mergeEmlFormValues,
  readEmlFormDefaults,
  utf8TextToBase64
} from '../lib/eml-form';
import type { Choice } from '../lib/types';
import {
  buttonStyle,
  errorMessageStyle,
  infoBoxStyle,
  inputStyle,
  monoStyle,
  noteStyle,
  okMessageStyle,
  subtleButtonStyle
} from '../lib/ui';

interface MakerPoSendEvidenceFormProps {
  action: FormAction;
  poId: string;
  /** 送信証跡（send_evidence）の書類バージョン。事前に文書画面へ登録済みの原本。 */
  sendEvidenceChoices: Choice[];
  /** 発注書の凍結済み宛先（スナップショット）。宛先欄の初期値。 */
  recipientAddress?: string | null;
  /** この発注書を代表承認した時刻。送信日時の前段警告に使う。 */
  ceoApprovedAt?: string | null;
  /** G3: the frozen CRM order code inserted at the front of the mail subject. */
  orderCode?: string | null;
}

interface MakerPoEmlFormState {
  values: EmlFormValues;
  edited: EmlFormEditedFields;
}

/**
 * M8-UI2: 手動送信の記録フォーム。送信証跡は2つの入口のどちらかで渡す。
 *
 * 1. このフォームから原本（.eml／message/rfc822）を直接アップロードする
 *    （contentBase64）。API が send_evidence 書類として保存し、メール本文と
 *    宛先・添付を検証する。事前の文書登録は不要。
 * 2. 文書画面に登録済みの send_evidence 書類バージョンを引用する
 *    （evidenceDocumentVersionId）。保存済みのバイト列がそのまま検証される。
 *
 * どちらの場合も API は送信日時・送信元・宛先を必須とする
 * （POST /api/maker-purchase-orders/:poId/send-evidence の intake 規則）。
 * PDFやスクリーンショット・タイムスタンプだけの記録は「送信未確認」になり、
 * その後の操作が停止する。
 */
export function MakerPoSendEvidenceForm({
  action,
  poId,
  sendEvidenceChoices,
  recipientAddress,
  ceoApprovedAt,
  orderCode
}: MakerPoSendEvidenceFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [contentBase64, setContentBase64] = useState('');
  const [emlFilename, setEmlFilename] = useState('');
  const [formState, setFormState] = useState<MakerPoEmlFormState>({
    values: { senderAddress: '', sentAt: '' },
    edited: { senderAddress: false, sentAt: false }
  });
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    setMessage(null);
    if (!file) {
      setContentBase64('');
      setEmlFilename('');
      return;
    }
    const suffix = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (suffix !== 'eml') {
      setMessage('送信証跡には送信済みメールの原本（.eml）を選んでください。PDFやスクリーンショットでは送信は確認できません。');
      setContentBase64('');
      setEmlFilename('');
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setEmlFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      setContentBase64(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);

      // A data URL preserves attachment bytes exactly. Read the same file once
      // more as text solely to inspect the header block in the browser.
      const headerReader = new FileReader();
      headerReader.onload = () => {
        const emlText = typeof headerReader.result === 'string' ? headerReader.result : '';
        const defaults = readEmlFormDefaults(emlText);
        let outgoingEml = emlText;
        let outgoingSubject = defaults.subject ?? '製造先発注書';
        const notices: string[] = [];
        if (orderCode) {
          const subjectEdit = insertMakerPoMailSubject(emlText, orderCode);
          outgoingEml = subjectEdit.eml;
          outgoingSubject = subjectEdit.subject;
          notices.push(subjectEdit.inserted
            ? `件名の先頭に発注コード（${orderCode}）を挿入しました。`
            : `件名には発注コード（${orderCode}）が既にあります。`);
        }
        setContentBase64(utf8TextToBase64(outgoingEml));
        setSelectedSubject(outgoingSubject);
        setFormState((current) => ({
          values: mergeEmlFormValues(current.values, current.edited, defaults),
          edited: current.edited
        }));
        if (defaults.sentAt !== undefined) {
          notices.push(
            formState.edited.sentAt
              ? `EMLのDateヘッダーを読み取りました（${defaults.sentAt}）。編集済みの送信日時は保持します。`
              : `EMLのDateヘッダーから送信日時を既定値として設定しました（${defaults.sentAt}）。必要なら修正できます。`
          );
        } else {
          notices.push('EMLのDateヘッダーを読み取れませんでした。送信日時は手動で入力してください。');
        }
        setMessage(notices.join(' '));
      };
      headerReader.onerror = () => {
        setMessage('EMLヘッダーを読み取れませんでした。送信日時と送信元は手動で確認してください。');
      };
      headerReader.readAsText(file);
    };
    reader.onerror = () => {
      setMessage('ファイルを読み取れませんでした。別のファイルを試してください。');
      setContentBase64('');
    };
    reader.readAsDataURL(file);
  }

  function clearFile(): void {
    setContentBase64('');
    setEmlFilename('');
    setSelectedSubject(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <form action={formAction} style={{ display: 'grid', gap: 10 }}>
      <input type="hidden" readOnly name="poId" value={poId} />
      <input type="hidden" readOnly name="contentBase64" value={contentBase64} />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>送信済みメールの原本（.eml）</span>
          <input
            ref={fileInput}
            type="file"
            accept=".eml,message/rfc822"
            onChange={onFileChange}
            style={inputStyle}
          />
        </label>
        {contentBase64 ? (
          <>
            <span style={noteStyle}>読み込み済み: {emlFilename}</span>
            <button type="button" style={subtleButtonStyle} onClick={clearFile}>
              ファイルを外す
            </button>
          </>
        ) : null}
      </div>
      <p style={noteStyle}>
        原本をここで渡す場合は、下の「送信証跡の書類バージョン」は「（選択なし）」のままで構いません
        （APIが send_evidence 書類として保存して検証します）。Thunderbirdの送信済みフォルダから
        書き出した .eml を選ぶと、このフォームが件名の先頭に発注コードを挿入して送信します。
      </p>

      {orderCode ? (
        <div style={noteStyle}>
          送信するEMLの件名（先頭の発注コードは自動挿入されます）:
          <div data-testid="maker-po-subject-preview" style={monoStyle} translate="no">
            {makerPoMailSubject(orderCode, selectedSubject ?? undefined)}
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <SelectField
          name="evidenceDocumentVersionId"
          label="送信証跡の書類バージョン（文書画面に登録済みの原本）"
          includeBlank
          blankLabel="（選択なし：上のファイル添付を使う）"
          choices={sendEvidenceChoices}
          width={420}
        />
        <TextField
          name="senderAddress"
          label="送信元アドレス"
          required
          value={formState.values.senderAddress}
          onChange={(event) => {
            const senderAddress = event.target.value;
            setFormState((current) => ({
              values: { ...current.values, senderAddress },
              edited: { ...current.edited, senderAddress: true }
            }));
          }}
          width={260}
        />
        <TextField
          name="recipients"
          label="宛先アドレス（カンマ区切り）"
          required
          defaultValue={recipientAddress ?? undefined}
          width={260}
        />
        <TextField
          name="sentAtLocal"
          label="送信日時"
          type="datetime-local"
          required
          value={formState.values.sentAt}
          onChange={(event) => {
            const sentAt = event.target.value;
            setFormState((current) => ({
              values: { ...current.values, sentAt },
              edited: { ...current.edited, sentAt: true }
            }));
          }}
          width={240}
        />
      </div>

      {isSentAtBeforeCeoApproval(formState.values.sentAt, ceoApprovedAt) ? (
        <div style={{ ...infoBoxStyle, fontSize: 13 }}>
          注意: 入力された送信日時が、この発注書の代表承認時刻より前です。日付や時刻の誤りを確認してください。
          （この警告は記録を止めませんが、承認前の送信はAPIで保留になります。）
        </div>
      ) : null}

      <input readOnly type="hidden" name="sentAt" value={datetimeLocalToIso(formState.values.sentAt) ?? ''} />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <button type="submit" disabled={pending} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? '送信中…' : '手動送信を記録する'}
        </button>
        {message ? <span aria-live="polite" style={errorMessageStyle}>{message}</span> : null}
        {state ? <span aria-live="polite" style={state.ok ? okMessageStyle : errorMessageStyle}>{state.message}</span> : null}
      </div>
    </form>
  );
}
