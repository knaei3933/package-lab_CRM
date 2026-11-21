import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { COMMISSION_READINESS_STATE_LABELS } from '@kanei/core';

/**
 * UI batch C part 1 (form infrastructure): field-level errors, server-message
 * mapping, locale-free date entry and the confirm dialog. Pure helpers are
 * checked case by case (normal / failure / boundary); the components are
 * server-rendered and their markup contract is pinned — what reaches the
 * server (field names, value formats) must not change.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined, refresh: () => undefined }) }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: async () => ({ ok: false, status: 500 }),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => ({ kind: 'anonymous' })
}));

const { validationMessage, formErrorSummary, plainLabel, createSubmitGate } = await import(
  '../apps/web/src/lib/form-validation.js'
);
const {
  ACTION_MESSAGE_FIELDS,
  displayActionMessage,
  fieldForActionMessage,
  FILE_FIELD,
  lineField,
  PAYMENT_TERMS_DISPLAY,
  READINESS_STATE_DISPLAY
} = await import('../apps/web/src/lib/form-messages.js');
const {
  composeDatetimeLocal,
  dateTextForDisplay,
  dateTimeIssue,
  formatJstWithWeekday,
  parseDateText,
  parseTimeText,
  splitDatetimeLocal
} = await import('../apps/web/src/lib/date-input.js');
const { datetimeLocalToIso } = await import('../apps/web/src/lib/datetime.js');
const { PAYMENT_TERMS_LABELS } = await import('../apps/web/src/lib/maker-po-data.js');
const { DISPLAY_TIME_ZONE } = await import('../apps/web/src/lib/vocabulary.js');
const { CheckboxField, DateTextField, SelectField, TextareaField, TextField } = await import(
  '../apps/web/src/components/fields.js'
);
const { FormFeedbackContext, FormResult } = await import('../apps/web/src/components/form-feedback.js');
const { ActionForm } = await import('../apps/web/src/components/ActionForm.js');
const { ConfirmDialog } = await import('../apps/web/src/components/ConfirmDialog.js');
const { OffsetDateTimeField } = await import('../apps/web/src/components/OffsetDateTimeField.js');
const { MakerPoSendEvidenceForm } = await import('../apps/web/src/components/MakerPoSendEvidenceForm.js');
const { ApprovalDecisionForm } = await import('../apps/web/src/components/ApprovalDecisionForm.js');
const { OrderCreateForm } = await import('../apps/web/src/components/OrderCreateForm.js');
const { DocumentUploadForm } = await import('../apps/web/src/components/DocumentUploadForm.js');
const { DeliveryRecordForm } = await import('../apps/web/src/components/DeliveryRecordForm.js');
const { LoginForm } = await import('../apps/web/src/components/LoginForm.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webSrc = path.join(repoRoot, 'apps/web/src');
const read = (relative: string): string => readFileSync(path.join(webSrc, relative), 'utf8');
const action = async () => ({ ok: true, message: '記録しました。' });
const render = (node: ReactNode): string => renderToString(node).replaceAll('<!-- -->', '');

/** Every `message: '…'` / `message: \`…\`` literal of a server action file. */
function actionMessages(relative: string): string[] {
  const source = read(relative);
  const literals = [...source.matchAll(/message:\s*(['`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((match) => match[2] ?? '');
  // P0 R01/R10: some refusals are shared constants of lib/form-messages (`message: NAME_MESSAGE`).
  const constants = read('lib/form-messages.ts');
  const named = [...source.matchAll(/message:\s*([A-Z][A-Z0-9_]*_MESSAGE)\b/g)].map((match) => {
    const definition = new RegExp(`export const ${match[1]} =\\s*(['\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`).exec(constants);
    return definition?.[2] ?? `(unresolved ${match[1]})`;
  });
  return [...literals, ...named];
}

/** The id attribute values the markup references with aria-describedby="…". */
function describedIds(html: string): string[] {
  return [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((match) => (match[1] ?? '').split(' '));
}

// ---------------------------------------------------------------------------
// 1-① validationMessage
// ---------------------------------------------------------------------------

describe('validationMessage (1-①)', () => {
  it('names the missing value per control kind', () => {
    expect(validationMessage({ valueMissing: true }, '発注番号')).toBe('発注番号を入力してください。');
    expect(validationMessage({ valueMissing: true }, '明細', { kind: 'select' })).toBe('明細を選択してください。');
    expect(validationMessage({ valueMissing: true }, 'ファイル', { kind: 'file' })).toBe('ファイル：ファイルを選んでください。');
    expect(validationMessage({ valueMissing: true }, '同意する', { kind: 'checkbox' })).toBe('「同意する」にチェックを入れてください。');
    expect(validationMessage({ valueMissing: true }, '結果', { kind: 'radio' })).toBe('結果を選択してください。');
  });

  it('uses the field-supplied format hint for a pattern mismatch, and a generic text without one', () => {
    expect(validationMessage({ patternMismatch: true }, '本登録日', { formatHint: '2026/11/18 の形' })).toBe(
      '本登録日は2026/11/18 の形で入力してください。'
    );
    expect(validationMessage({ patternMismatch: true }, '納品数量')).toBe('納品数量の形式が正しくありません。');
  });

  it('covers length, range, type and custom errors', () => {
    expect(validationMessage({ tooShort: true }, '承認証跡識別子', { minLength: 8 })).toBe('承認証跡識別子は8文字以上で入力してください。');
    expect(validationMessage({ tooLong: true }, '備考', { maxLength: 200 })).toBe('備考は200文字以内で入力してください。');
    expect(validationMessage({ rangeUnderflow: true }, '数量', { min: '1' })).toBe('数量は1以上で入力してください。');
    expect(validationMessage({ rangeOverflow: true }, '数量', { max: '99' })).toBe('数量は99以下で入力してください。');
    expect(validationMessage({ typeMismatch: true }, '送信元', { kind: 'email' })).toContain('メールアドレスの形');
    expect(validationMessage({ badInput: true }, '数量', { kind: 'number' })).toBe('数量は数値で入力してください。');
    expect(validationMessage({ customError: true }, '検証日時', { customMessage: '時刻も入力してください。' })).toBe('時刻も入力してください。');
    expect(validationMessage({ customError: true }, '検証日時', { customMessage: '  ' })).toBe('検証日時の入力内容を確認してください。');
  });

  it('valueMissing wins over every other flag', () => {
    expect(validationMessage({ valueMissing: true, patternMismatch: true, customError: true }, '日付')).toBe('日付を入力してください。');
  });

  it('returns null for a valid control (no flags, or valid: true)', () => {
    expect(validationMessage({}, '発注番号')).toBeNull();
    expect(validationMessage({ valid: true }, '発注番号')).toBeNull();
  });

  it('summary line and label cleanup', () => {
    expect(formErrorSummary(3)).toBe('入力内容を確認してください（3件）。');
    expect(formErrorSummary(0)).toBe('');
    expect(plainLabel('承認証跡の書類バージョン（必須・両組織で同じ版を引用します）')).toBe('承認証跡の書類バージョン');
    expect(plainLabel('発注コード（必須）')).toBe('発注コード');
  });
});

// ---------------------------------------------------------------------------
// 1-③ submit gate: check → confirm → submit exactly once
// ---------------------------------------------------------------------------

describe('submit gate (1-③)', () => {
  it('invalid input is stopped and never reaches the confirm step', () => {
    const gate = createSubmitGate();
    expect(gate.submit({ invalid: true, needsConfirm: true })).toBe('invalid');
    expect(gate.state).toBe('idle');
    expect(gate.confirm()).toBe(false);
  });

  it('a valid submit with a dialog is held; confirm lets exactly one submit through', () => {
    const gate = createSubmitGate();
    expect(gate.submit({ invalid: false, needsConfirm: true })).toBe('confirm');
    expect(gate.state).toBe('confirming');
    expect(gate.confirm()).toBe(true);
    expect(gate.confirm()).toBe(false); // a double click does not confirm twice
    // Review H1/L3: the shell dispatches the confirmed submit itself (no
    // requestSubmit round trip), so the gate is idle at once and the next
    // submit asks again.
    expect(gate.state).toBe('idle');
    expect(gate.submit({ invalid: false, needsConfirm: true })).toBe('confirm');
  });

  it('cancel drops the held submit', () => {
    const gate = createSubmitGate();
    gate.submit({ invalid: false, needsConfirm: true });
    gate.cancel();
    expect(gate.state).toBe('idle');
    expect(gate.confirm()).toBe(false);
  });

  it('without a dialog a valid submit passes straight through', () => {
    expect(createSubmitGate().submit({ invalid: false, needsConfirm: false })).toBe('submit');
  });

  it('source guard: the shell prevents every native submit and dispatches with the submitter (review H1)', () => {
    const source = read('components/form-feedback.tsx');
    // Review H1: prevented before any decision, so React never runs (and resets after) the action itself.
    const onSubmitBody = source.slice(source.indexOf('{', source.indexOf('function onSubmit(')) + 1);
    const firstStatement = onSubmitBody.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().split(';')[0]!.replace(/\s+/g, '');
    expect(firstStatement).toBe('event.preventDefault()');
    expect(source).toMatch(/if \(decision === 'confirm' && dialog\) \{\s*submitterRef\.current = submitter;\s*setHeld\(dialog\);\s*return;\s*\}\s*dispatch\(form, submitter\);/);
    expect(source).toMatch(/if \(!form \|\| !gate\.confirm\(\)\) return;\s*setHeld\(null\);\s*dispatch\(form, submitterRef\.current\);/);
    expect(source).not.toContain('requestSubmit(');
    // Native validation stays on until hydration (no-JS submits behave as before).
    expect(source).toContain('noValidate={mounted}');
  });

  it('React 19 skips a form action when onSubmit prevented the default (the contract the gate relies on)', () => {
    const require = createRequire(path.join(repoRoot, 'apps/web/package.json'));
    const reactDomDir = path.dirname(require.resolve('react-dom/package.json'));
    const reactDom = readFileSync(path.join(reactDomDir, 'cjs/react-dom-client.development.js'), 'utf8');
    expect(reactDom).toMatch(/if \(nativeEvent\.defaultPrevented\) \{/);
  });
});

// ---------------------------------------------------------------------------
// 1-① server message → field, display wording
// ---------------------------------------------------------------------------

describe('fieldForActionMessage (1-①)', () => {
  const sources = {
    actions: actionMessages('app/actions.ts'),
    'maker-po-actions': actionMessages('app/maker-po/actions.ts')
  } as const;

  it('extracts the real messages from both action files', () => {
    expect(sources.actions.length).toBeGreaterThan(30);
    expect(sources['maker-po-actions'].length).toBeGreaterThan(15);
  });

  it.each(ACTION_MESSAGE_FIELDS.map((entry) => [entry.message, entry]))('table entry exists verbatim in the source: %s', (_text, entry) => {
    const messages = sources[entry.source];
    const found = messages.some((message) =>
      entry.match === 'exact'
        ? message === entry.message
        : entry.match === 'prefix'
          ? message.startsWith(entry.message)
          : message.endsWith(entry.message)
    );
    expect(found, `${entry.source}: ${entry.message}`).toBe(true);
  });

  it('every mapped field is a control the forms actually render', () => {
    const forms = [
      'components/fields.tsx',
      'components/OrderCreateForm.tsx',
      'components/DocumentUploadForm.tsx',
      'components/MakerPoSendEvidenceForm.tsx',
      'components/ApprovalDecisionForm.tsx',
      // UI batch F: the change request fields of the revision form.
      'components/ChangeRequestFields.tsx',
      'components/DeliveryRecordForm.tsx',
      'components/ProjectPicker.tsx',
      'screens/OrdersScreen.tsx',
      'screens/DocumentsScreen.tsx',
      'screens/ApprovalsScreen.tsx',
      'screens/MakerPoScreen.tsx',
      'screens/DeliveriesScreen.tsx'
    ].map(read).join('\n');
    const pseudo = new Set([FILE_FIELD, lineField(0, 'description'), lineField(0, 'quantity'), lineField(0, 'unit')]);
    for (const { field } of ACTION_MESSAGE_FIELDS) {
      if (pseudo.has(field)) continue;
      expect(forms, field).toMatch(new RegExp(`name(="|: ')${field}['"]`));
    }
    expect(forms).toContain('data-feedback-name={FILE_FIELD}');
    expect(forms).toContain("data-feedback-name={lineField(index, 'quantity')}");
  });

  it('maps exact, template and long messages to their field', () => {
    expect(fieldForActionMessage('発注番号を入力してください。')).toBe('poNumber');
    expect(fieldForActionMessage('本登録日を入力してください。')).toBe('officialRegisteredAt');
    // P0 R11: the verifier and the time are recorded by the API — the forms no longer ask for them.
    expect(fieldForActionMessage('検証者名を入力してください。')).toBeNull();
    expect(fieldForActionMessage('検証者名（verifierName）を入力してください。')).toBeNull();
    expect(fieldForActionMessage('根拠を入力してください（原本証跡のどこで識別子を確認したか）。')).toBe('reasonNote');
    expect(fieldForActionMessage('納品数量は正の数で入力してください。')).toBe('deliveredQuantity');
    expect(fieldForActionMessage('フィルム発注の明細の数量は正の数で入力してください。')).toBe('lines.0.quantity');
    expect(fieldForActionMessage('充填発注の明細の説明が入力されていません。')).toBe('lines.0.description');
    expect(fieldForActionMessage('ファイルを選択してください。')).toBe(FILE_FIELD);
    expect(fieldForActionMessage(sources['maker-po-actions'].find((m) => m.startsWith('送信証跡がありません。')) ?? '')).toBe(FILE_FIELD);
    expect(fieldForActionMessage('  送信日時を入力してください。 ')).toBe('sentAt');
  });

  it('returns null for hidden-id, whole-form and API messages', () => {
    expect(fieldForActionMessage('メーカー発注書が選択されていません。')).toBeNull();
    expect(fieldForActionMessage('フィルム発注が選択されていません。')).toBeNull();
    expect(fieldForActionMessage('記録しました。')).toBeNull();
    expect(fieldForActionMessage('この操作を行う権限がありません。')).toBeNull();
    expect(fieldForActionMessage('フィルム発注の明細データを読み取れませんでした。もう一度入力してください。')).toBeNull();
    expect(fieldForActionMessage('')).toBeNull();
  });
});

describe('displayActionMessage (1-①)', () => {
  it('points the no-project message at the header 「案件」 selector', () => {
    expect(read('app/actions.ts')).toContain('上部の「案件の選択」で案件IDを入力してください。');
    expect(displayActionMessage('案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。')).toBe(
      '案件が選択されていません。画面上部の「案件」から案件を選んでください。'
    );
  });

  it('shows payment terms in Japanese', () => {
    // P0 R01 / P-10: the old 支払条件 wording is read back with the glossary word 支払条件.
    expect(displayActionMessage('支払条件を記録しました（prepaid）。記録は入金確認ではありません。')).toBe(
      '支払条件を記録しました（前払い）。記録は入金確認ではありません。'
    );
    expect(displayActionMessage('支払条件を記録しました（on_delivery）。記録は入金確認ではありません。')).toContain('（納品後払い）');
    expect(displayActionMessage('支払条件を記録しました（undetermined）。記録は入金確認ではありません。')).toContain('（未定）');
    expect(displayActionMessage('支払条件（prepaid／on_delivery／undetermined）を選択してください。')).toBe(
      '支払条件（前払い／納品後払い／未定）を選択してください。'
    );
    // An unknown code is left as it is.
    expect(displayActionMessage('支払条件を記録しました（barter）。')).toBe('支払条件を記録しました（barter）。');
  });

  it('drops internal field codes and fixes the send-confirmation wording', () => {
    expect(displayActionMessage('確認結果（confirmed／rejected）を選択してください。')).toBe('確認結果（確認／却下）を選択してください。');
    expect(displayActionMessage('検証者名（verifierName）を入力してください。')).toBe('検証者名を入力してください。');
    expect(displayActionMessage('検証日時（verifiedAt）を入力してください。')).toBe('検証日時を入力してください。');
    expect(displayActionMessage('根拠（reasonNote）を入力してください。何を確認して納品を断定したかを記録してください。')).toBe(
      '根拠を入力してください。何を確認して送信を確定したかを記録してください。'
    );
    expect(displayActionMessage('取消理由（note）は必須です。訂正・再発注の理由を記録してください。')).toBe(
      '取消理由は必須です。訂正・再発注の理由を記録してください。'
    );
    expect(displayActionMessage('受領証跡（acceptance_evidence）の書類バージョンを選択してください。')).toBe(
      '受領証跡の書類バージョンを選択してください。'
    );
    expect(displayActionMessage('準備状態：MISSING_DATA（未達の要件があります）。')).toBe('準備状態：データ不足（未達の要件があります）。');
  });

  it('every code-bearing message of the action files reads without an English code once displayed', () => {
    for (const message of [...actionMessages('app/actions.ts'), ...actionMessages('app/maker-po/actions.ts')]) {
      const shown = displayActionMessage(message.replaceAll('${paymentTerms}', 'prepaid'));
      expect(shown, message).not.toMatch(/（[a-z_]+(／[a-z_]+)*）/);
      expect(shown, message).not.toMatch(/（[a-zA-Z]+[A-Z][a-zA-Z]*）/);
    }
  });

  it('leaves every other message unchanged', () => {
    expect(displayActionMessage('記録しました。')).toBe('記録しました。');
    expect(displayActionMessage('発注番号を入力してください。')).toBe('発注番号を入力してください。');
    expect(displayActionMessage('APIがステータス 500 を返しました。')).toBe('APIがステータス 500 を返しました。');
  });

  it('the mirrored label maps equal their sources', () => {
    expect(PAYMENT_TERMS_DISPLAY).toEqual(PAYMENT_TERMS_LABELS);
    expect(READINESS_STATE_DISPLAY).toEqual(COMMISSION_READINESS_STATE_LABELS);
  });
});

// ---------------------------------------------------------------------------
// 1-② date / time text
// ---------------------------------------------------------------------------

describe('date and time text parsers (1-②)', () => {
  it('accepts each allowed date spelling', () => {
    expect(parseDateText('2026/11/18')).toBe('2026-11-18');
    expect(parseDateText('2026-11-18')).toBe('2026-11-18');
    expect(parseDateText('20261118')).toBe('2026-11-18');
    expect(parseDateText('2026/1/5')).toBe('2026-01-05');
    expect(parseDateText('  2026/11/18 ')).toBe('2026-11-18');
    expect(parseDateText('２０２６／１１／１８')).toBe('2026-11-18');
  });

  it('knows leap years and refuses dates the calendar does not have', () => {
    expect(parseDateText('2024/02/29')).toBe('2024-02-29');
    expect(parseDateText('2025/02/29')).toBeNull();
    expect(parseDateText('2026/02/30')).toBeNull();
    expect(parseDateText('2026/13/01')).toBeNull();
    expect(parseDateText('2026/00/10')).toBeNull();
    expect(parseDateText('2026/04/31')).toBeNull();
    expect(parseDateText('11/18/2026')).toBeNull();
    expect(parseDateText('2026111')).toBeNull();
    expect(parseDateText('')).toBeNull();
  });

  it('accepts 24-hour times and refuses out-of-range ones', () => {
    expect(parseTimeText('14:30')).toBe('14:30');
    expect(parseTimeText('1430')).toBe('14:30');
    expect(parseTimeText('9:05')).toBe('09:05');
    expect(parseTimeText('905')).toBe('09:05');
    expect(parseTimeText(' 00:00 ')).toBe('00:00');
    expect(parseTimeText('23:59')).toBe('23:59');
    expect(parseTimeText('１４：３０')).toBe('14:30');
    expect(parseTimeText('24:00')).toBeNull();
    expect(parseTimeText('25:61')).toBeNull();
    expect(parseTimeText('12:60')).toBeNull();
    expect(parseTimeText('2:5')).toBeNull();
    expect(parseTimeText('午後2時')).toBeNull();
    expect(parseTimeText('')).toBeNull();
  });

  it('compose and split round-trip the datetime-local value', () => {
    expect(composeDatetimeLocal('2026/11/18', '14:30')).toBe('2026-11-18T14:30');
    expect(composeDatetimeLocal('2026/11/18', '')).toBeNull();
    expect(composeDatetimeLocal('', '14:30')).toBeNull();
    expect(composeDatetimeLocal('2026/02/30', '14:30')).toBeNull();
    expect(splitDatetimeLocal('2026-11-18T14:30')).toEqual({ date: '2026-11-18', time: '14:30' });
    expect(splitDatetimeLocal('2026-11-18T14:30:15.123')).toEqual({ date: '2026-11-18', time: '14:30' });
    expect(splitDatetimeLocal('broken')).toEqual({ date: '', time: '' });
    const value = '2026-11-18T09:05';
    const { date, time } = splitDatetimeLocal(value);
    expect(composeDatetimeLocal(dateTextForDisplay(date), time)).toBe(value);
    expect(dateTextForDisplay('2026-11-18')).toBe('2026/11/18');
  });

  it('the composed value converts exactly as the old datetime-local input did', () => {
    expect(datetimeLocalToIso(composeDatetimeLocal('2026/11/18', '14:30')!)).toBe(datetimeLocalToIso('2026-11-18T14:30'));
    expect(datetimeLocalToIso(composeDatetimeLocal('20240229', '0000')!)).toBe(datetimeLocalToIso('2024-02-29T00:00'));
  });

  it('spells the recorded moment in Japan time with the weekday, independent of the host TZ', () => {
    expect(DISPLAY_TIME_ZONE).toBe('Asia/Tokyo');
    expect(formatJstWithWeekday('2026-11-18T05:30:00.000Z')).toBe('2026/11/18（水）14:30');
    expect(formatJstWithWeekday('2026-11-18T14:30:00+09:00')).toBe('2026/11/18（水）14:30');
    // 23:30 UTC on the 17th is already the 18th in Japan.
    expect(formatJstWithWeekday('2026-11-17T23:30:00Z')).toBe('2026/11/18（水）08:30');
    expect(formatJstWithWeekday('not-a-time')).toBeNull();
    expect(formatJstWithWeekday('')).toBeNull();
  });

  it('dateTimeIssue says which part to fix', () => {
    expect(dateTimeIssue('', '', true, '検証日時')).toEqual({ part: 'date', message: '検証日時を入力してください。' });
    expect(dateTimeIssue('', '', false, '納品日')).toBeNull();
    expect(dateTimeIssue('2026/11/18', '', false, '納品日')?.part).toBe('time');
    expect(dateTimeIssue('', '14:30', false, '納品日')?.part).toBe('date');
    expect(dateTimeIssue('2026/02/30', '14:30', true, '検証日時')?.message).toContain('実在する日付');
    expect(dateTimeIssue('2026/11/18', '24:00', true, '検証日時')?.message).toContain('24時間表記');
    expect(dateTimeIssue('2026/11/18', '14:30', true, '検証日時')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rendering contracts
// ---------------------------------------------------------------------------

describe('fields render hint / error links (1-①, 1-④)', () => {
  it('outside a form shell: the hint is linked, no error, width is a maximum', () => {
    const html = render(<TextField name="poNumber" label="発注番号" required hint="セブン化学の発注書番号" width={300} />);
    const ids = describedIds(html);
    expect(ids).toHaveLength(1);
    expect(html).toContain(`id="${ids[0]}"`);
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('field-error');
    expect(html).toContain('（必須）');
    expect(html).toMatch(/width:100%;max-width:300px/);
    expect(html).toContain('min-width:min(220px, 100%)');
    // Review L5: the label wraps the caption and its control only; the hint follows outside it.
    expect(html).toMatch(/^<div class="field"[^>]*><label class="field-label"><span[^>]*>発注番号/);
    expect(html).toMatch(/<input[^>]*name="poNumber"[^>]*\/><\/label><span id="[^"]+"[^>]*>セブン化学の発注書番号<\/span><\/div>$/);
  });

  it('with an error from the shell: aria-invalid, the error text and both ids', () => {
    const html = render(
      <FormFeedbackContext.Provider value={{ errors: { poNumber: '発注番号を入力してください。' }, summaryCount: 1 }}>
        <TextField name="poNumber" label="発注番号" required hint="例 PO-1" />
        <TextField name="other" label="その他" />
      </FormFeedbackContext.Provider>
    );
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
    const ids = describedIds(html);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<span id="[^"]+" class="field-error"><span class="field-error-mark" aria-hidden="true">✕<\/span><span><span class="form-sr-only">入力エラー：<\/span>発注番号を入力してください。<\/span><\/span>/);
  });

  it('select, textarea and checkbox take the same links', () => {
    const errors = { to: '遷移先の状態を選択してください。', reasonNote: '根拠を入力してください。', agree: '「同意」にチェックを入れてください。' };
    const html = render(
      <FormFeedbackContext.Provider value={{ errors, summaryCount: 3 }}>
        <SelectField name="to" label="遷移先" choices={[{ value: 'A', label: 'A' }]} />
        <TextareaField name="reasonNote" label="根拠" />
        <CheckboxField name="agree" label="同意" required />
      </FormFeedbackContext.Provider>
    );
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(3);
    expect(html.match(/class="field-error"/g)).toHaveLength(3);
    const checkbox = /<input type="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
    expect(checkbox).toContain('name="agree"');
    expect(checkbox).toContain('required=""');
  });

  it('DateTextField keeps the name, submits YYYY-MM-DD and shows the example hint', () => {
    const html = render(<DateTextField name="officialRegisteredAt" label="本登録日" required />);
    expect(html).toContain('name="officialRegisteredAt"');
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="date"');
    expect(html).toContain('pattern="\\d{4}-\\d{2}-\\d{2}"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('例 2026/11/18（日本時間の日付）');
    expect(html).toContain('data-date-text=""');
    const ids = describedIds(html);
    expect(ids).toHaveLength(1);
    expect(html).toContain(`id="${ids[0]}"`);
  });
});

describe('ActionForm shell (1-①, 1-③)', () => {
  it('always renders the alert / status live regions and the summary region', () => {
    const html = render(
      <ActionForm action={action} submitLabel="記録する">
        <TextField name="note" label="メモ" />
      </ActionForm>
    );
    expect(html).toMatch(/<span role="alert" class="form-result form-result--error"><\/span>/);
    expect(html).toMatch(/<span role="status" class="form-result form-result--ok"><\/span>/);
    expect(html).toMatch(/<p role="alert" class="form-summary"><\/p>/);
    expect(html).toContain('class="form-shell"');
    // Before hydration the browser still validates natively.
    expect(html).not.toContain('novalidate');
    expect(html).not.toContain('<dialog');
  });

  it('with confirm: a closed native dialog titled by its h2, キャンセル and the confirm button', () => {
    const html = render(
      <ActionForm
        action={action}
        submitLabel="代表承認を記録する"
        tone="danger"
        confirm={{ title: '代表承認を記録しますか？', body: '承認は取り消せません。', tone: 'danger', summaryFields: ['poId'] }}
      >
        <input type="hidden" name="poId" value="po-1" readOnly />
      </ActionForm>
    );
    const dialog = /<dialog class="confirm-dialog confirm-dialog--danger" aria-labelledby="([^"]+)" aria-describedby="([^"]+)">/.exec(html);
    expect(dialog).not.toBeNull();
    expect(html).not.toMatch(/<dialog[^>]* open/);
    expect(html).toContain(`<h2 id="${dialog![1]}">代表承認を記録しますか？</h2>`);
    expect(html).toContain(`id="${dialog![2]}" class="confirm-dialog-text">承認は取り消せません。</p>`);
    expect(html).toMatch(/<button type="button"[^>]*>キャンセル<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*background:var\(--danger\)[^>]*>代表承認を記録する<\/button>/);
    // tone: the submit button is danger too.
    expect(html).toMatch(/<button type="submit"[^>]*background:var\(--danger\)[^>]*>代表承認を記録する<\/button>/);
  });

  it('result line: refusal in the alert region (display wording), success + hint in the status region', () => {
    const refused = render(<FormResult state={{ ok: false, message: '検証者名（verifierName）を入力してください。' }} />);
    expect(refused).toMatch(/<span role="alert"[^>]*><span class="form-result-mark" aria-hidden="true">✕<\/span><span>検証者名を入力してください。<\/span><\/span>/);
    expect(refused).toMatch(/<span role="status"[^>]*><\/span>/);
    const ok = render(<FormResult state={{ ok: true, message: '記録しました。' }} successHint="次の手順: 代表承認" />);
    expect(ok).toMatch(/<span role="status"[^>]*>.*記録しました。.*次の手順: 代表承認.*<\/span>/);
    expect(ok).toMatch(/<span role="alert"[^>]*><\/span>/);
  });
});

describe('ConfirmDialog markup (1-③)', () => {
  it('lists the summary as a definition list and labels itself', () => {
    const html = render(
      <ConfirmDialog
        open={false}
        title="手動送信を記録しますか？"
        body="記録は履歴に残ります。"
        summary={[{ label: '送信元', value: 'kanei@example.jp' }, { label: '送信日時', value: '日本時間 2026/11/18（水）14:30' }]}
        confirmLabel="手動送信を記録する"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(html).toMatch(/^<dialog class="confirm-dialog" aria-labelledby="[^"]+"/);
    expect(html).toContain('<dl class="confirm-dialog-summary"><div><dt>送信元</dt><dd>kanei@example.jp</dd></div>');
    expect(html).toContain('<dt>送信日時</dt><dd>日本時間 2026/11/18（水）14:30</dd>');
    // キャンセル comes first; both are plain buttons that never submit the form themselves.
    expect(html.indexOf('キャンセル')).toBeLessThan(html.indexOf('>手動送信を記録する<'));
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
  });
});

describe('locale-free datetime fields keep the submitted fields (1-②)', () => {
  it('OffsetDateTimeField: hidden name (empty until mounted) + hidden Local, two text inputs, no datetime-local', () => {
    const html = render(
      <OffsetDateTimeField name="verifiedAt" label="検証日時" required defaultValue="2026-11-17T18:54" hint="代表者が確認した時刻" />
    );
    expect(html).toContain('<input readOnly="" type="hidden" name="verifiedAt" value=""/>');
    expect(html).toContain('<input readOnly="" type="hidden" name="verifiedAtLocal" value="2026-11-17T18:54"/>');
    expect(html).not.toContain('datetime-local');
    expect(html).toMatch(/<fieldset class="datetime-field"><legend>検証日時<span[^>]*>（必須）<\/span><\/legend>/);
    const visible = [...html.matchAll(/<input type="text" inputMode="numeric"[^>]*>/g)].map((match) => match[0]);
    expect(visible).toHaveLength(2);
    expect(visible[0]).toContain('value="2026/11/17"');
    expect(visible[0]).toContain('placeholder="2026/11/18"');
    expect(visible[1]).toContain('value="18:54"');
    expect(visible[1]).toContain('placeholder="14:30"');
    // No name on the visible parts: nothing ambiguous reaches the server.
    for (const input of visible) {
      expect(input).not.toMatch(/ name=/);
      expect(input).toContain('data-feedback-name="verifiedAt"');
      // Read-only until hydrated (a value typed earlier could not reach the hidden fields).
      expect(input).toContain('readOnly=""');
    }
    expect(html).toContain('日付（年/月/日）');
    expect(html).toContain('時刻（24時間表記）');
    // The JST read-back is a polite live region (filled after mount).
    expect(html).toContain('<p class="datetime-confirm" aria-live="polite"></p>');
    expect(describedIds(html).every((id) => html.includes(`id="${id}"`))).toBe(true);
  });

  it('MakerPoSendEvidenceForm keeps sentAt / sentAtLocal hidden and confirms the manual send', () => {
    const html = render(
      <MakerPoSendEvidenceForm
        action={action}
        poId="po-1"
        sendEvidenceChoices={[{ value: 'v1', label: 'sent.eml（版1）' }]}
        recipientAddress="maker@example.test"
        ceoApprovedAt="2026-11-17T09:00:00+09:00"
        orderCode="FSO-1"
      />
    );
    expect(html).toContain('<input readOnly="" type="hidden" name="sentAtLocal" value=""/>');
    expect(html).toContain('<input readOnly="" type="hidden" name="sentAt" value=""/>');
    expect(html).not.toContain('datetime-local');
    expect(html).toContain('name="contentBase64"');
    expect(html).toContain('name="senderAddress"');
    expect(html).toContain('name="recipients"');
    expect(html).toContain('data-feedback-name="sentAt"');
    expect(html).toContain('data-feedback-name="file"');
    expect(html).toMatch(/<dialog class="confirm-dialog"[^>]*>[\s\S]*<h2 id="[^"]+">手動送信を記録しますか？<\/h2>/);
    expect(html).toMatch(/<span role="alert" class="form-result form-result--error"><\/span>/);
    expect(html).toMatch(/<span role="status" class="form-result form-result--ok"><\/span>/);
  });

  it('ApprovalDecisionForm: confirm dialog, eventTime fields, the shared G6 help still on exactly two controls', () => {
    const html = render(
      <ApprovalDecisionForm
        action={action}
        revisionId="revision-1"
        designKey="label-front"
        evidenceChoices={[{ value: 'version-1', label: 'approval.eml（版2）', autoEvidenceIdentifier: '<approval@example.test>' }]}
        evidenceSourceChoices={[{ value: 'email', label: 'メール' }]}
        defaultEventTime="2026-11-17T18:00"
      />
    );
    expect(html).toContain('name="eventTime"');
    expect(html).toContain('name="eventTimeLocal" value="2026-11-17T18:00"');
    expect(html).not.toContain('datetime-local');
    // Controls only: the dialog's own aria-describedby (its body text) is not a field link.
    expect(html.match(/<(?:select|input|textarea)\b[^>]*aria-describedby=/g)).toHaveLength(2);
    expect(html).toContain('<dialog class="confirm-dialog"');
    // Both organization buttons still post `organization` (requestSubmit passes the pressed one).
    const buttons = [...html.matchAll(/<button type="submit"[^>]*>/g)].map((match) => match[0]);
    expect(buttons.filter((button) => button.includes('name="organization"')).map((button) => /value="([^"]+)"/.exec(button)?.[1])).toEqual([
      'customer',
      'seven'
    ]);
  });
});

describe('custom forms share the shell (1-①)', () => {
  it('OrderCreateForm marks line cells for the server messages and keeps the posted fields', () => {
    const html = render(
      <OrderCreateForm
        action={action}
        orderKind="film"
        unitChoices={[{ value: 'm', label: 'm' }]}
        paymentTermsChoices={[{ value: 'undetermined', label: '未確定' }]}
      />
    );
    expect(html).toContain('name="lines"');
    expect(html).toContain('name="code"');
    expect(html).toContain('name="paymentTerms"');
    expect(html).toContain('data-feedback-name="lines.0.description"');
    expect(html).toContain('data-feedback-name="lines.0.quantity"');
    expect(html).toContain('data-feedback-name="lines.0.unit"');
    expect(html).toContain('class="form-shell"');
    expect(html).toMatch(/<span role="alert" class="form-result form-result--error"><\/span>/);
  });

  it('DocumentUploadForm: the file picker is required (explained, not a disabled button) and posts no file bytes itself', () => {
    const html = render(
      <DocumentUploadForm
        action={action}
        documentTypeChoices={[{ value: 'proof', label: '校正ゲラ' }]}
        issuerEntityChoices={[{ value: 'kanei', label: 'カネイ' }]}
        contentTypeChoices={[{ value: 'application/pdf', label: 'PDF' }]}
        sevenPurchaseOrderChoices={[]}
        filmSupplyOrderChoices={[]}
      />
    );
    const file = /<input type="file"[^>]*>/.exec(html)?.[0] ?? '';
    expect(file).toContain('required=""');
    expect(file).not.toMatch(/ name=/);
    expect(file).toContain('data-feedback-name="file"');
    expect(html).not.toMatch(/<button type="submit"[^>]*disabled/);
    expect(html).toContain('name="contentBase64"');
  });

  it('DeliveryRecordForm: quantity carries a format hint, live regions present', () => {
    const html = render(
      <DeliveryRecordForm
        action={action}
        kind="film"
        orders={[{ id: 'o1', code: 'FSO-1', lines: [{ value: 'l1', label: '明細1' }] }]}
        unitChoices={[{ value: 'm', label: 'm' }]}
      />
    );
    expect(html).toContain('name="deliveredQuantity"');
    expect(html).toContain('data-feedback-format="正の数（例 1000、12.5）"');
    expect(html).toContain('name="deliveredAt"');
    expect(html).toContain('name="deliveredAtLocal"');
    expect(html).toMatch(/<span role="status" class="form-result form-result--ok"><\/span>/);
  });

  it('LoginForm keeps an always-present alert line for the refusal', () => {
    const html = render(<LoginForm />);
    expect(html).toMatch(/<span id="[^"]+" role="alert"[^>]*><\/span>/);
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain('aria-invalid');
  });

  it('ProjectPicker moves focus to #main without scrolling (1-⑦)', () => {
    expect(read('components/ProjectPicker.tsx')).toContain('?.focus({ preventScroll: true })');
  });
});

describe('390px: no fixed control widths left in the part-1 forms (1-④)', () => {
  it.each([
    'components/fields.tsx',
    'components/OrderCreateForm.tsx',
    'components/ApprovalDecisionForm.tsx',
    'components/DocumentUploadForm.tsx',
    'components/DeliveryRecordForm.tsx',
    'components/MakerPoSendEvidenceForm.tsx',
    'components/OffsetDateTimeField.tsx'
  ])('%s sets no fixed px width on a control or a minWidth above 220', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/width: \d+ ?\}/);
    expect(source).not.toMatch(/width: width( \?\? \d+)? ?\}/);
    expect(source).not.toMatch(/minWidth: \d{3}/);
  });

  it('forms.css lets buttons wrap at a 36px touch height and caps controls at the column', () => {
    const css = read('app/forms.css');
    expect(css).toMatch(/\.form-shell button \{\s*min-height: 36px;\s*white-space: normal;/);
    expect(css).toMatch(/max-width: 100%;/);
    const tokens = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
    const globals = read('app/globals.css');
    for (const token of tokens) expect(globals, token).toContain(`${token}:`);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
