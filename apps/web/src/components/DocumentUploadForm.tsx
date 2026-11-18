'use client';

import { useActionState, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { FormAction } from './ActionForm';
import type { Choice } from '../lib/types';
import { isMakerPoBoundDocumentType } from '../lib/document-maker-po';
import type { MakerPoChoice } from '../lib/document-maker-po';
import { buttonStyle, errorMessageStyle, inputStyle, noteStyle, okMessageStyle, subtleButtonStyle } from '../lib/ui';

interface DocumentUploadFormProps {
  action: FormAction;
  documentTypeChoices: Choice[];
  issuerEntityChoices: Choice[];
  contentTypeChoices: Choice[];
  sevenPurchaseOrderChoices: Choice[];
  filmSupplyOrderChoices: Choice[];
  makerPurchaseOrderChoices?: MakerPoChoice[];
}

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
 */
export function DocumentUploadForm({
  action,
  documentTypeChoices,
  issuerEntityChoices,
  contentTypeChoices,
  sevenPurchaseOrderChoices,
  filmSupplyOrderChoices,
  makerPurchaseOrderChoices = []
}: DocumentUploadFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [contentBase64, setContentBase64] = useState('');
  const [filename, setFilename] = useState('');
  const [contentType, setContentType] = useState(contentTypeChoices[0]?.value ?? '');
  const [designKey, setDesignKey] = useState('');
  const [documentType, setDocumentType] = useState(documentTypeChoices[0]?.value ?? '');
  const [filmSupplyOrderId, setFilmSupplyOrderId] = useState('');
  const showMakerPo = isMakerPoBoundDocumentType(documentType);
  const makerPoOptions = makerPurchaseOrderChoices.filter((choice) => choice.filmSupplyOrderId === filmSupplyOrderId);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    setMessage(null);
    if (!file) {
      setContentBase64('');
      setFilename('');
      return;
    }
    setFilename(file.name);
    const suffix = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    const guessed = EXTENSION_CONTENT_TYPES[suffix];
    if (guessed) setContentType(guessed);
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      setContentBase64(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => {
      setMessage('ファイルを読み取れませんでした。別のファイルを試してください。');
      setContentBase64('');
    };
    reader.readAsDataURL(file);
  }

  function clearFile(): void {
    setContentBase64('');
    setFilename('');
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <form action={formAction} style={{ display: 'grid', gap: 10 }}>
      <input type="hidden" readOnly name="contentBase64" value={contentBase64} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>書類種別<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <select name="documentType" required value={documentType} onChange={(event) => setDocumentType(event.target.value)} style={{ ...inputStyle, width: 260 }}>
            {documentTypeChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>発行主体<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <select name="issuerEntity" required style={{ ...inputStyle, width: 220 }}>
            {issuerEntityChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>書類の形式（contentType）<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <select
            name="contentType"
            value={contentType}
            onChange={(event) => setContentType(event.target.value)}
            style={{ ...inputStyle, width: 220 }}
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
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>ファイル<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <input ref={fileInput} type="file" accept={ACCEPT_ATTRIBUTE} onChange={onFileChange} style={inputStyle} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>ファイル名（書類の表示名）<span style={{ color: 'var(--danger)' }}>（必須）</span></span>
          <input
            name="filename"
            value={filename}
            required
            onChange={(event) => setFilename(event.target.value)}
            style={{ ...inputStyle, width: 320 }}
          />
        </label>
        {contentBase64 ? (
          <button type="button" style={subtleButtonStyle} onClick={clearFile}>
            ファイルを外す
          </button>
        ) : null}
      </div>
      <p style={noteStyle}>
        選んだファイルはブラウザ内でBase64に変換してAPIへ送ります（contentBase64）。同じ内容の再送は同じ版として扱われます。
        書類種別が「送信証跡（send_evidence）」のときは、送信済みメールの原本（.eml／メール原文 EML）を選んでください。
        PDFやスクリーンショット、メモでは送信は「確認済み」になりません。
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>セブン化学発注書の紐付け（任意）</span>
          <select name="sevenPurchaseOrderId" style={{ ...inputStyle, width: 300 }}>
            <option value="">紐付けない</option>
            {sevenPurchaseOrderChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>フィルム発注の紐付け（任意）</span>
          <select name="filmSupplyOrderId" value={filmSupplyOrderId} onChange={(event) => setFilmSupplyOrderId(event.target.value)} style={{ ...inputStyle, width: 300 }}>
            <option value="">紐付けない</option>
            {filmSupplyOrderChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {showMakerPo ? (
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13 }}>メーカー発注書の紐付け（受入証跡・送信証跡では必須）</span>
            <select name="makerPurchaseOrderId" required style={{ ...inputStyle, width: 360 }}>
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
        ) : null}
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13 }}>デザインキー（校正ゲラ・承認証跡を発注に紐付ける場合は必須）</span>
          <input
            name="designKey"
            value={designKey}
            onChange={(event) => setDesignKey(event.target.value)}
            placeholder="例：T-35"
            style={{ ...inputStyle, width: 200 }}
          />
        </label>
      </div>

      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 13 }}>備考（任意）</span>
        <textarea name="note" rows={2} style={{ ...inputStyle, width: 360 }} />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="submit" disabled={pending || contentBase64.length === 0} style={{ ...buttonStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? 'アップロード中…' : '書類をアップロードする'}
        </button>
        {message ? <span style={errorMessageStyle}>{message}</span> : null}
        {state ? <span style={state.ok ? okMessageStyle : errorMessageStyle}>{state.message}</span> : null}
      </div>
    </form>
  );
}
