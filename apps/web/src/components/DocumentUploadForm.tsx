'use client';

import { useActionState, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { FormAction } from './ActionForm';
import { FeedbackForm, FieldError, FieldFeedback, FormErrorSummary, FormResult, resolverFromOptions, SubmitLock } from './form-feedback';
import type { ConfirmOptions } from './form-feedback';
import type { Choice } from '../lib/types';
import { defaultSevenPoId, isMakerPoBoundDocumentType, requiresSevenPo } from '../lib/document-maker-po';
import type { MakerPoChoice, SevenPoChoice } from '../lib/document-maker-po';
import { FILE_FIELD } from '../lib/form-messages';
import { FILE_READ_FAILED_MESSAGE, FILE_READING_MESSAGE, fileReadIssue } from '../lib/form-validation';
import type { FileReadState } from '../lib/form-validation';
import { buttonStyle, inputStyle, noteStyle, subtleButtonStyle } from '../lib/ui';

interface DocumentUploadFormProps {
  action: FormAction;
  documentTypeChoices: Choice[];
  issuerEntityChoices: Choice[];
  contentTypeChoices: Choice[];
  sevenPurchaseOrderChoices: SevenPoChoice[];
  filmSupplyOrderChoices: Choice[];
  makerPurchaseOrderChoices?: MakerPoChoice[];
  /** UI batch C: optional confirmation before the upload. */
  confirm?: ConfirmOptions | undefined;
  /** Appended after 「記録しました。」. */
  successHint?: string | undefined;
}

const SUBMIT_LABEL = '書類をアップロードする';

/** Filename suffix → the content types the API accepts. */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  csv: 'text/csv',
  // 送信証跡（send_evidence）は Thunderbird の送信済みフォルダから書き出した
  // メール原本（.eml）。API が受け付ける message/rfc822 として宣言する。
  eml: 'message/rfc822'
};

/** The file input's accept list: the suffixes the API's allow-list can hold. */
const ACCEPT_ATTRIBUTE = Object.keys(EXTENSION_CONTENT_TYPES)
  .map((suffix) => `.${suffix}`)
  .join(',');

/**
 * Criterion 4: the document upload form. The file is read with FileReader and
 * posted as contentBase64; the filename is filled from the selected file and
 * stays editable (the API treats it as display metadata). The declared content
 * type follows the file's suffix and can be corrected by hand, because the API
 * checks it against its allow-list before persisting anything. The optional
 * order / design bindings follow the API's intake rules: proof and approval
 * evidence need a design key when they are bound to an order.
 *
 * UI batch C (review M5): while the file is still being read, or after the
 * read failed, the file input carries a custom error, so the form shell holds
 * the submit and explains it on the file field — an empty contentBase64 never
 * reaches the server under a visibly selected file.
 */
export function DocumentUploadForm({
  action,
  documentTypeChoices,
  issuerEntityChoices,
  contentTypeChoices,
  sevenPurchaseOrderChoices,
  filmSupplyOrderChoices,
  makerPurchaseOrderChoices = [],
  confirm,
  successHint
}: DocumentUploadFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [contentBase64, setContentBase64] = useState('');
  const [filename, setFilename] = useState('');
  const [contentType, setContentType] = useState(contentTypeChoices[0]?.value ?? '');
  const [designKey, setDesignKey] = useState('');
  const [documentType, setDocumentType] = useState(documentTypeChoices[0]?.value ?? '');
  const [filmSupplyOrderId, setFilmSupplyOrderId] = useState('');
  // UI batch E (F-07): the PO link is required for the official artifacts, and
  // preselected when the project has exactly one ready PO.
  const poDefault = defaultSevenPoId(sevenPurchaseOrderChoices);
  const [sevenPurchaseOrderId, setSevenPurchaseOrderId] = useState(() => (requiresSevenPo(documentType) ? poDefault : ''));
  const poRequired = requiresSevenPo(documentType);

  /** A type that needs the PO link fills the one ready PO in, unless one is already chosen. */
  function onDocumentTypeChange(next: string): void {
    setDocumentType(next);
    if (requiresSevenPo(next) && sevenPurchaseOrderId === '') setSevenPurchaseOrderId(poDefault);
  }
  const showMakerPo = isMakerPoBoundDocumentType(documentType);
  const makerPoOptions = makerPurchaseOrderChoices.filter((choice) => choice.filmSupplyOrderId === filmSupplyOrderId);
  const [readState, setReadState] = useState<FileReadState>('idle');
  /** Only the latest picked file may fill the hidden field (a slower earlier read is dropped). */
  const readToken = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const readNoteId = useId();
  const wide = (max: number) => ({ ...inputStyle, width: '100%', maxWidth: max });
  /** UI batch C (1-④): the label keeps the old width as its flex basis and shrinks on narrow screens. */
  const fieldLabel = (basis?: number) =>
    ({ display: 'grid', gap: 4, maxWidth: '100%', minWidth: 'min(200px, 100%)', ...(basis ? { flex: `0 1 ${basis}px` } : {}) }) as const;
  /** Review L5: the <label> wraps the caption + control only; error and notes follow it. */
  const labelOnly = { display: 'grid', gap: 4 } as const;

  /** The read state is also the file input's custom validity (checked by the shell on submit), set at once. */
  function markRead(next: FileReadState): void {
    setReadState(next);
    fileInput.current?.setCustomValidity(fileReadIssue(next) ?? '');
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    const token = ++readToken.current;
    setContentBase64('');
    if (!file) {
      setFilename('');
      markRead('idle');
      return;
    }
    setFilename(file.name);
    markRead('reading');
    const suffix = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    const guessed = EXTENSION_CONTENT_TYPES[suffix];
    if (guessed) setContentType(guessed);
    const reader = new FileReader();
    reader.onload = () => {
      if (token !== readToken.current) return;
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      setContentBase64(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      markRead('read');
    };
    reader.onerror = () => {
      if (token !== readToken.current) return;
      setContentBase64('');
      markRead('failed');
    };
    reader.readAsDataURL(file);
  }

  /**
   * Drops the picked file's state (ファイルを外す, and the form reset after a
   * successful upload, which empties the file input). A refused upload keeps
   * the file, its bytes and the other fields (review H1 / L7).
   */
  function forgetFile(): void {
    readToken.current += 1;
    setContentBase64('');
    setFilename('');
    markRead('idle');
  }

  function clearFile(): void {
    forgetFile();
    if (fileInput.current) fileInput.current.value = '';
  }

  /** The file field's message: the shell's (submit / server) first, else a failed read. */
  const fileErrorFor = (shellError: string | undefined) => shellError ?? (readState === 'failed' ? FILE_READ_FAILED_MESSAGE : undefined);
  const fileDescribedBy = (errorId: string, error: string | undefined) =>
    [error ? errorId : null, readState === 'reading' ? readNoteId : null].filter((id): id is string => id !== null).join(' ') || undefined;

  return (
    <FeedbackForm
      action={formAction}
      state={state}
      pending={pending}
      onReset={forgetFile}
      confirm={resolverFromOptions(confirm, SUBMIT_LABEL)}
      dialogDefaults={confirm ? { options: confirm, confirmLabel: confirm.confirmLabel ?? SUBMIT_LABEL } : undefined}
      style={{ display: 'grid', gap: 10 }}
    >
      <input type="hidden" readOnly name="contentBase64" value={contentBase64} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <label className="field" style={fieldLabel(260)}>
          <span style={{ fontSize: 13 }}>書類種別<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <select name="documentType" required value={documentType} onChange={(event) => onDocumentTypeChange(event.target.value)} style={wide(260)}>
            {documentTypeChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={fieldLabel(220)}>
          <span style={{ fontSize: 13 }}>発行主体<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <select name="issuerEntity" required style={wide(220)}>
            {issuerEntityChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={fieldLabel(220)}>
          <span style={{ fontSize: 13 }}>書類の形式<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <select
            name="contentType"
            value={contentType}
            onChange={(event) => setContentType(event.target.value)}
            style={wide(220)}
          >
            {contentTypeChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <FieldFeedback name={FILE_FIELD}>
          {(fileFeedback) => {
            const fileError = fileErrorFor(fileFeedback.error);
            return (
              <div className="field" style={fieldLabel()}>
                <label style={labelOnly}>
                  <span style={{ fontSize: 13 }}>ファイル<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
                  {/* UI batch C: required so the empty case is explained instead of a disabled button. */}
                  <input
                    ref={fileInput}
                    type="file"
                    accept={ACCEPT_ATTRIBUTE}
                    required
                    onChange={onFileChange}
                    aria-describedby={fileDescribedBy(fileFeedback.errorId, fileError)}
                    aria-invalid={fileError ? true : undefined}
                    data-feedback-name={FILE_FIELD}
                    data-feedback-label="ファイル"
                    style={inputStyle}
                  />
                </label>
                <FieldError id={fileFeedback.errorId} message={fileError} />
                <span id={readNoteId} aria-live="polite" className="form-live" style={noteStyle}>
                  {readState === 'reading' ? FILE_READING_MESSAGE : ''}
                </span>
              </div>
            );
          }}
        </FieldFeedback>
        <FieldFeedback name="filename">
          {(filenameFeedback) => (
            <div className="field" style={fieldLabel(320)}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>ファイル名（書類の表示名）<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
                <input
                  name="filename"
                  value={filename}
                  required
                  onChange={(event) => setFilename(event.target.value)}
                  aria-describedby={filenameFeedback.describedBy}
                  aria-invalid={filenameFeedback.invalid}
                  data-feedback-label="ファイル名"
                  style={wide(320)}
                />
              </label>
              <FieldError id={filenameFeedback.errorId} message={filenameFeedback.error} />
            </div>
          )}
        </FieldFeedback>
        {contentBase64 ? (
          <button type="button" style={subtleButtonStyle} onClick={clearFile}>
            ファイルを外す
          </button>
        ) : null}
      </div>
      <p style={noteStyle}>
        選んだファイルは、この画面からそのままサーバーへ送ります（事前の保存は不要です）。同じ内容の再送は同じ版として扱われます。
        書類種別が「送信証跡」のときは、送信済みメールの原本（.eml／メール原文 EML）を選んでください。
        PDFやスクリーンショット、メモでは送信は「確認済み」になりません。
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <FieldFeedback name="sevenPurchaseOrderId" hasHint>
          {(poFeedback) => (
            <div className="field" style={fieldLabel(300)}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>
                  セブン化学発注書の紐付け
                  {poRequired ? <span style={{ color: 'var(--danger)' }}>（必須）</span> : '（任意）'}
                </span>
                <select
                  name="sevenPurchaseOrderId"
                  value={sevenPurchaseOrderId}
                  required={poRequired}
                  onChange={(event) => setSevenPurchaseOrderId(event.target.value)}
                  aria-describedby={poFeedback.describedBy}
                  aria-invalid={poFeedback.invalid}
                  data-feedback-label="セブン化学発注書の紐付け"
                  style={wide(300)}
                >
                  <option value="">{poRequired ? '（発注書を選ぶ）' : '紐付けない'}</option>
                  {sevenPurchaseOrderChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError id={poFeedback.errorId} message={poFeedback.error} />
              <span id={poFeedback.hintId} style={noteStyle}>
                {poRequired
                  ? '校正ゲラ・承認証跡・送信証跡・受領証跡は、確認済み（公式登録と真性行チェックリスト済み）の発注書に紐付けて登録します。'
                  : '発注書・見積書は紐付けなしでも登録できます。'}
              </span>
            </div>
          )}
        </FieldFeedback>
        <label className="field" style={fieldLabel(300)}>
          <span style={{ fontSize: 13 }}>フィルム発注の紐付け（任意）</span>
          <select name="filmSupplyOrderId" value={filmSupplyOrderId} onChange={(event) => setFilmSupplyOrderId(event.target.value)} style={wide(300)}>
            <option value="">紐付けない</option>
            {filmSupplyOrderChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {showMakerPo ? (
          <FieldFeedback name="makerPurchaseOrderId">
            {(makerPoFeedback) => (
              <div className="field" style={fieldLabel(360)}>
                <label style={labelOnly}>
                  <span style={{ fontSize: 13 }}>メーカー発注書の紐付け（受入証跡・送信証跡では必須）</span>
                  <select
                    name="makerPurchaseOrderId"
                    required
                    aria-describedby={makerPoFeedback.describedBy}
                    aria-invalid={makerPoFeedback.invalid}
                    data-feedback-label="メーカー発注書の紐付け"
                    style={wide(360)}
                  >
                    <option value="">
                      {filmSupplyOrderId ? '選択してください' : '先にフィルム発注を選んでください'}
                    </option>
                    {makerPoOptions.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                <FieldError id={makerPoFeedback.errorId} message={makerPoFeedback.error} />
              </div>
            )}
          </FieldFeedback>
        ) : null}
        <FieldFeedback name="designKey">
          {(designKeyFeedback) => (
            <div className="field" style={fieldLabel(200)}>
              <label style={labelOnly}>
                <span style={{ fontSize: 13 }}>デザインキー（校正ゲラ・承認証跡を発注に紐付ける場合は必須）</span>
                <input
                  name="designKey"
                  value={designKey}
                  onChange={(event) => setDesignKey(event.target.value)}
                  placeholder="例：T-35"
                  aria-describedby={designKeyFeedback.describedBy}
                  aria-invalid={designKeyFeedback.invalid}
                  data-feedback-label="デザインキー"
                  style={wide(200)}
                />
              </label>
              <FieldError id={designKeyFeedback.errorId} message={designKeyFeedback.error} />
            </div>
          )}
        </FieldFeedback>
      </div>

      <label className="field" style={fieldLabel(360)}>
        <span style={{ fontSize: 13 }}>備考（任意）</span>
        <textarea name="note" rows={2} style={wide(360)} />
      </label>

      <div className="form-actions">
        <SubmitLock>
          {(locked) => (
            <button
              type="submit"
              aria-disabled={pending || undefined}
              disabled={locked || undefined}
              style={{ ...buttonStyle, opacity: pending || locked ? 0.6 : 1 }}
            >
              {pending ? 'アップロード中…' : SUBMIT_LABEL}
            </button>
          )}
        </SubmitLock>
        <FormErrorSummary />
        <FormResult state={state} successHint={successHint} />
      </div>
    </FeedbackForm>
  );
}
