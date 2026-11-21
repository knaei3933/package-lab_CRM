'use client';

import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { FieldError, FormFeedbackContext } from './form-feedback';
import {
  bytesToBase64,
  detectFileKind,
  EMPTY_FILE_MESSAGE,
  readMailIdentifiers,
  STEP_FILE_ACCEPT,
  UNSUPPORTED_FILE_MESSAGE
} from '../lib/file-kind';
import {
  FILE_READ_FAILED_MESSAGE,
  FILE_READING_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  isUploadTooLarge,
  megabytesText
} from '../lib/form-validation';

/**
 * P1 R22: the evidence file of one step. The step already fixed what the file
 * is (document type, issuer, the order and design it belongs to) — the
 * operator picks the file and nothing else. The content type is read from the
 * file's own bytes (lib/file-kind; the API checks the same signatures), the
 * size is checked before anything is sent (5MB, R07), and an approval mail
 * (.eml) hands its Message-ID and Date to the form so they are not typed by
 * hand. Posted fields: contentBase64, filename, contentType, mailMessageId,
 * mailDate (empty when not a mail).
 */
type ReadState =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'read'; label: string; size: number }
  | { kind: 'error'; message: string };

export function StepFileField({
  name = 'file',
  label,
  hint,
  required = true
}: {
  name?: string;
  label: string;
  hint?: string | undefined;
  required?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const token = useRef(0);
  const [read, setRead] = useState<ReadState>({ kind: 'idle' });
  const [fields, setFields] = useState({ contentBase64: '', filename: '', contentType: '', mailMessageId: '', mailDate: '' });
  const feedback = useContext(FormFeedbackContext);
  const shellError = feedback?.errors[name];

  // The read state is the input's validity, so the form shell holds a submit while
  // a file is being read, was refused, or is too large (never an empty upload).
  useEffect(() => {
    const issue = read.kind === 'reading' ? FILE_READING_MESSAGE : read.kind === 'error' ? read.message : '';
    input.current?.setCustomValidity(issue);
  }, [read]);

  // A successful submit resets the form (the shell); the picked file is forgotten with it.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return undefined;
    const onReset = () => {
      token.current += 1;
      setRead({ kind: 'idle' });
      setFields({ contentBase64: '', filename: '', contentType: '', mailMessageId: '', mailDate: '' });
    };
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  async function onChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    const mine = ++token.current;
    setFields({ contentBase64: '', filename: '', contentType: '', mailMessageId: '', mailDate: '' });
    if (!file) {
      setRead({ kind: 'idle' });
      return;
    }
    if (isUploadTooLarge(file.size)) {
      setRead({ kind: 'error', message: `${FILE_TOO_LARGE_MESSAGE}（選んだファイル: ${megabytesText(file.size)}）` });
      return;
    }
    setRead({ kind: 'reading' });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mine !== token.current) return;
      const kind = detectFileKind(bytes, file.name);
      if (!kind.ok) {
        setRead({ kind: 'error', message: kind.reason === 'empty' ? EMPTY_FILE_MESSAGE : UNSUPPORTED_FILE_MESSAGE });
        return;
      }
      const mail = kind.contentType === 'message/rfc822'
        ? readMailIdentifiers(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
        : { messageId: null, date: null };
      setFields({
        contentBase64: bytesToBase64(bytes),
        filename: file.name,
        contentType: kind.contentType,
        mailMessageId: mail.messageId ?? '',
        mailDate: mail.date ?? ''
      });
      setRead({ kind: 'read', label: kind.label, size: file.size });
    } catch {
      if (mine === token.current) setRead({ kind: 'error', message: FILE_READ_FAILED_MESSAGE });
    }
  }

  const error = shellError ?? (read.kind === 'error' ? read.message : undefined);
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="p1-file">
      <label className="p1-field-label" htmlFor={id}>
        {label}
        {required ? <span className="p1-required">（必須）</span> : null}
      </label>
      <input
        ref={input}
        id={id}
        className="p1-file-input"
        type="file"
        // No name: only the Base64 below is posted (the raw file would double the body, R07).
        data-feedback-name={name}
        data-feedback-label={label}
        accept={STEP_FILE_ACCEPT}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => void onChange(event)}
      />
      <input type="hidden" readOnly name="contentBase64" value={fields.contentBase64} />
      <input type="hidden" readOnly name="filename" value={fields.filename} />
      <input type="hidden" readOnly name="contentType" value={fields.contentType} />
      <input type="hidden" readOnly name="mailMessageId" value={fields.mailMessageId} />
      <input type="hidden" readOnly name="mailDate" value={fields.mailDate} />
      {hint ? <p id={hintId} className="p1-field-hint">{hint}</p> : null}
      <p className="p1-file-state" aria-live="polite">
        {read.kind === 'reading' ? FILE_READING_MESSAGE : null}
        {read.kind === 'read'
          ? `${read.label}（${megabytesText(read.size)}）${fields.mailMessageId ? '・メールの識別子を読み取りました' : ''}`
          : null}
      </p>
      <FieldError id={errorId} message={error} />
    </div>
  );
}
