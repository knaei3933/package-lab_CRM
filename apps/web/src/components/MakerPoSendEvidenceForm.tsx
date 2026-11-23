'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { FormAction } from './ActionForm';
import { DateTimeInputs } from './DateTimeInputs';
import { SelectField, TextField } from './fields';
import { FeedbackForm, FieldError, FieldFeedback, FormErrorSummary, FormResult, resolverFromOptions, SubmitLock } from './form-feedback';
import type { ConfirmOptions, ConfirmResolver } from './form-feedback';
import { FILE_TOO_LARGE_MESSAGE, isUploadTooLarge, megabytesText } from '../lib/form-validation';
import { MAKER_PO_SEND_CONFIRM_TITLE, MAKER_PO_SEND_SUBMIT_LABEL, makerPoSendConfirmSpec } from '../lib/confirm-summary';
import { datetimeLocalToIso } from '../lib/datetime';
import { FILE_FIELD } from '../lib/form-messages';
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
import { infoBoxStyle, inputStyle, monoStyle, noteStyle } from '../lib/ui';

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
  /** UI batch C: replaces the built-in 「送信を記録しますか？」 confirmation. */
  confirm?: ConfirmOptions | undefined;
  /** Appended after 「記録しました。」. */
  successHint?: string | undefined;
}

const SUBMIT_LABEL = MAKER_PO_SEND_SUBMIT_LABEL;

interface MakerPoEmlFormState {
  values: EmlFormValues;
  edited: EmlFormEditedFields;
}

const INITIAL_FORM_STATE: MakerPoEmlFormState = {
  values: { senderAddress: '', sentAt: '' },
  edited: { senderAddress: false, sentAt: false }
};

/** A line next to the button about the picked file: a notice (auto-fill, subject) or an error (wrong / unreadable file). */
interface FileNotice {
  text: string;
  tone: 'note' | 'error';
}

/**
 * M8-UI2: 送信の記録フォーム。送信証跡は2つの入口のどちらかで渡す。
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
  orderCode,
  confirm,
  successHint
}: MakerPoSendEvidenceFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [contentBase64, setContentBase64] = useState('');
  const [emlFilename, setEmlFilename] = useState('');
  const [formState, setFormState] = useState<MakerPoEmlFormState>(INITIAL_FORM_STATE);
  const [message, setMessage] = useState<FileNotice | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Only the latest picked file may fill the form (a read finishing after a reset is dropped). */
  const readToken = useRef(0);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);

  /** Forgets the EML held for the submit: bytes, file name, subject and its notices (review Q1). */
  function forgetEml(): void {
    readToken.current += 1;
    setContentBase64('');
    setEmlFilename('');
    setSelectedSubject(null);
    setMessage(null);
  }

  // Review Q1: after a recorded send the previous EML must not be sent again
  // (nor named in the next confirmation).
  useEffect(() => {
    if (state?.ok) forgetEml();
  }, [state]);

  /**
   * The form's reset (the shell resets only after a recorded send, review H1):
   * the file input is emptied natively, so is the held EML. A refused send
   * keeps the EML, 送信元・宛先 and the send time for the retry (review M2).
   */
  function onFormReset(): void {
    forgetEml();
    setFormState((current) => ({
      values: { ...current.values, senderAddress: INITIAL_FORM_STATE.values.senderAddress },
      edited: { ...current.edited, senderAddress: false }
    }));
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    const token = ++readToken.current;
    setMessage(null);
    if (!file) {
      setContentBase64('');
      setEmlFilename('');
      return;
    }
    const suffix = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (suffix !== 'eml') {
      setMessage({
        text: '送信証跡には送信済みメールの原本（.eml）を選んでください。PDFやスクリーンショットでは送信は確認できません。',
        tone: 'error'
      });
      setContentBase64('');
      setEmlFilename('');
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    // P0 R07 (H15): the API stores at most 5MB; a larger EML is explained before it is read.
    if (isUploadTooLarge(file.size)) {
      setMessage({ text: `${FILE_TOO_LARGE_MESSAGE}（選んだファイル: ${megabytesText(file.size)}）`, tone: 'error' });
      setContentBase64('');
      setEmlFilename('');
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setEmlFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (token !== readToken.current) return;
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      setContentBase64(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);

      // A data URL preserves attachment bytes exactly. Read the same file once
      // more as text solely to inspect the header block in the browser.
      const headerReader = new FileReader();
      headerReader.onload = () => {
        if (token !== readToken.current) return;
        const emlText = typeof headerReader.result === 'string' ? headerReader.result : '';
        const defaults = readEmlFormDefaults(emlText);
        let outgoingEml = emlText;
        let outgoingSubject = defaults.subject ?? 'メーカー発注書';
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
        setMessage({ text: notices.join(' '), tone: 'note' });
      };
      headerReader.onerror = () => {
        if (token !== readToken.current) return;
        setMessage({ text: 'EMLヘッダーを読み取れませんでした。送信日時と送信元は手動で確認してください。', tone: 'note' });
      };
      headerReader.readAsText(file);
    };
    reader.onerror = () => {
      if (token !== readToken.current) return;
      setMessage({ text: 'ファイルを読み取れませんでした。別のファイルを試してください。', tone: 'error' });
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

  // UI batch C (1-③): what will be recorded, read back before the send is filed (texts: lib/confirm-summary).
  const builtInConfirm: ConfirmResolver = (form) => {
    const read = (name: string): string => {
      const item = form.elements.namedItem(name);
      return item instanceof HTMLInputElement || item instanceof HTMLSelectElement ? item.value : '';
    };
    const versionSelect = form.elements.namedItem('evidenceDocumentVersionId');
    const versionText = versionSelect instanceof HTMLSelectElement && versionSelect.value.length > 0
      ? versionSelect.selectedOptions[0]?.textContent?.trim() ?? versionSelect.value
      : '';
    return makerPoSendConfirmSpec({
      senderAddress: read('senderAddress'),
      recipients: read('recipients'),
      sentAtLocal: formState.values.sentAt,
      emlFilename,
      hasEmlContent: contentBase64.length > 0,
      versionText
    });
  };

  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      onReset={onFormReset}
      confirm={resolverFromOptions(confirm, SUBMIT_LABEL) ?? builtInConfirm}
      dialogDefaults={{
        options: confirm ?? { title: MAKER_PO_SEND_CONFIRM_TITLE, body: '' },
        confirmLabel: confirm?.confirmLabel ?? SUBMIT_LABEL
      }}
      style={{ display: 'grid', gap: 10 }}
    >
      <input type="hidden" readOnly name="poId" value={poId} />
      <input type="hidden" readOnly name="contentBase64" value={contentBase64} />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <FieldFeedback name={FILE_FIELD}>
          {(fileFeedback) => (
            <div className="field" style={{ display: 'grid', gap: 4, maxWidth: '100%' }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 13 }}>送信済みメールの原本（.eml）</span>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".eml,message/rfc822"
                  onChange={onFileChange}
                  aria-describedby={fileFeedback.describedBy}
                  aria-invalid={fileFeedback.invalid}
                  data-feedback-name={FILE_FIELD}
                  data-feedback-label="送信済みメールの原本（.eml）"
                  style={inputStyle}
                />
              </label>
              <FieldError id={fileFeedback.errorId} message={fileFeedback.error} />
            </div>
          )}
        </FieldFeedback>
        {contentBase64 ? (
          <>
            <span style={noteStyle}>読み込み済み: {emlFilename}</span>
            <button type="button" className="ui-button--subtle" onClick={clearFile}>
              ファイルを外す
            </button>
          </>
        ) : null}
      </div>
      <p style={noteStyle}>
        {'原本をここで渡す場合は、下の「送信証跡の書類バージョン」は「（選択なし）」のままで構いません'
          + '（送信証跡の書類として保存して確認します）。メールソフトの送信済みフォルダから書き出した .eml を選んでください。'
          + 'この画面からメールは送信されません。メーカーへ送るメールの件名は、先頭に発注コードを付けます（下の例）。'}
      </p>

      {orderCode ? (
        <div style={noteStyle}>
          メーカーへ送るメールの件名（例。先頭に発注コードを付けます）:
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
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
        />
        <TextField
          name="recipients"
          label="宛先アドレス（カンマ区切り）"
          required
          defaultValue={recipientAddress ?? undefined}
          width={260}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
        />
        {/* UI batch C (1-②): text date + time; the posted sentAtLocal / sentAt stay as before. */}
        <input readOnly type="hidden" name="sentAtLocal" value={formState.values.sentAt} />
        <DateTimeInputs
          name="sentAt"
          label="送信日時"
          required
          value={formState.values.sentAt}
          onChange={(sentAt) => {
            setFormState((current) => ({
              values: { ...current.values, sentAt },
              edited: { ...current.edited, sentAt: true }
            }));
          }}
          onReset={(sentAt) => {
            // Back to the empty start, not an operator edit: the next EML may fill it again.
            setFormState((current) => ({
              values: { ...current.values, sentAt },
              edited: { ...current.edited, sentAt: false }
            }));
          }}
        />
      </div>

      {isSentAtBeforeCeoApproval(formState.values.sentAt, ceoApprovedAt) ? (
        <div style={{ ...infoBoxStyle, fontSize: 13 }}>
          注意: 入力された送信日時が、この発注書の代表承認時刻より前です。日付や時刻の誤りを確認してください。
          （この警告は記録を止めませんが、承認前の送信はAPIで保留になります。）
        </div>
      ) : null}

      <input readOnly type="hidden" name="sentAt" value={datetimeLocalToIso(formState.values.sentAt) ?? ''} />

      <div className="form-actions">
        <SubmitLock>
          {(locked) => (
            <button
              type="submit"
              aria-disabled={pending || undefined}
              disabled={locked || undefined}
              className="ui-button"
            >
              {pending ? '送信中…' : SUBMIT_LABEL}
            </button>
          )}
        </SubmitLock>
        <FormErrorSummary />
        {/* File-reading notices (EML header, subject insertion): polite, always present;
            notices in the note colour, only a wrong or unreadable file in red (review L11). */}
        <span aria-live="polite" className={`form-result form-result--${message?.tone ?? 'note'}`}>
          {message?.text ?? ''}
        </span>
        <FormResult state={state} successHint={successHint} />
      </div>
    </FeedbackForm>
  );
}
