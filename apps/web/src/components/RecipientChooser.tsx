'use client';

import { useRef } from 'react';
import type { MakerRecipientAddressView, RecipientChoices } from '../lib/maker-master';
import { TextField } from './fields';
import { FieldError, useFieldFeedback } from './form-feedback';

/**
 * P2 R33 (DESIGN §4): the maker PO's 送信先 — the project maker's addresses
 * (the default first and preselected) or 「直接入力する」 with an always-present
 * e-mail input. Works without JS: the radio decides, the server action sends
 * either `recipientAddressId` or `recipientAddress`, never both. With JS,
 * typing in the input selects 「直接入力する」. When the list cannot be used
 * (no maker, no address, unreadable) only the typed address remains, with the
 * reason in one line. Display only — the API checks the chosen address again.
 */

/** Client-safe copies of lib/maker-master TYPED_RECIPIENT / RECIPIENT_CHOICE_FIELD (a test keeps them equal). */
export const TYPED_RECIPIENT_VALUE = '__typed';
export const RECIPIENT_CHOICE_NAME = 'recipientChoice';

const TYPED_HINT = '「直接入力する」を選んだときだけ使います。メーカーマスター外の宛先になります。';

function addressLabel(address: MakerRecipientAddressView): string {
  return address.label ?? '宛先';
}

export function RecipientChooser({
  choices,
  previousTyped,
  showMakersLink = false,
  width = 360
}: {
  choices: RecipientChoices;
  /** The latest paper's typed address when it is not in the master (a hint only, never filled in). */
  previousTyped?: string | null | undefined;
  /** Admin: the メーカーの宛先 page is theirs to open. */
  showMakersLink?: boolean | undefined;
  width?: number | undefined;
}) {
  const typedRadio = useRef<HTMLInputElement>(null);
  const feedback = useFieldFeedback(RECIPIENT_CHOICE_NAME, false);
  const previousHint = previousTyped ? `${TYPED_HINT}前回の直接入力: ${previousTyped}` : TYPED_HINT;

  if (choices.kind !== 'list') {
    return (
      <div className="p2-recipient">
        {choices.kind === 'no_maker' ? (
          <p className="p1-note">この案件にはメーカーが設定されていません。宛先は直接入力してください。メーカーの設定は管理者の手順（初期データ登録）で行います。</p>
        ) : choices.kind === 'no_addresses' ? (
          <p className="p1-note">
            メーカー「{choices.makerName}」に使える宛先が登録されていません。直接入力するか、代表者が「メーカーの宛先」画面で追加してください。
            {showMakersLink ? <> <a href="/makers">メーカーの宛先を開く</a></> : null}
          </p>
        ) : choices.kind === 'unreadable' ? (
          <p className="p1-banner p1-banner--error" role="alert">
            宛先の一覧を読み込めませんでした（{choices.error}）。直接入力すれば作成できます。一覧を使うときは、少し待ってから再読み込みしてください。
          </p>
        ) : null}
        <input type="hidden" readOnly name="recipientChoice" value={TYPED_RECIPIENT_VALUE} />
        <TextField
          name="recipientAddress"
          label="メーカーの送信先メールアドレス"
          type="email"
          required
          width={width}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          placeholder="order@maker.example"
          hint={previousTyped ? `前回の直接入力: ${previousTyped}` : undefined}
        />
      </div>
    );
  }

  return (
    <fieldset className="p1-fieldset p2-recipient" aria-describedby={feedback.describedBy}>
      <legend className="p1-legend">送信先（メーカーへ送るメールの宛先）</legend>
      <div className="p2-recipient-options" role="radiogroup" aria-label={`送信先（メーカー「${choices.makerName}」の宛先）`}>
        {choices.addresses.map((address, index) => (
          <label key={address.id} className="p1-radio p2-recipient-option">
            <input
              type="radio"
              name="recipientChoice"
              value={address.id}
              defaultChecked={index === 0}
              aria-invalid={feedback.invalid}
              data-feedback-label="送信先"
            />
            <span className="p2-recipient-text">
              <b>{addressLabel(address)}</b> <span translate="no" className="p2-recipient-email">{address.email}</span>
              {address.isDefault ? <> <span className="p2-maker-tag">既定</span></> : null}
            </span>
          </label>
        ))}
        <label className="p1-radio p2-recipient-option">
          <input
            ref={typedRadio}
            type="radio"
            name="recipientChoice"
            value={TYPED_RECIPIENT_VALUE}
            aria-invalid={feedback.invalid}
            data-feedback-label="送信先"
          />
          <span className="p2-recipient-text">直接入力する</span>
        </label>
      </div>
      <FieldError id={feedback.errorId} message={feedback.error} />
      <div
        className="p2-recipient-typed"
        onInput={() => {
          if (typedRadio.current) typedRadio.current.checked = true;
        }}
      >
        <TextField
          name="recipientAddress"
          label="直接入力するメールアドレス"
          type="email"
          width={width}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          placeholder="order@maker.example"
          hint={previousHint}
        />
      </div>
    </fieldset>
  );
}
