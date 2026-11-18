import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * UI batch C review fix 1 (M4 and the follow-up findings): the decisions the
 * form shell used to make inline on the DOM now live in pure functions —
 * which controls stop a submit and where focus goes, which field a server
 * refusal marks, the confirm dialog's rows, what the JST line announces, the
 * reset value, quantity normalization, the file-read hold, the pending gate.
 * They are checked here by behaviour on plain objects (normal / failure /
 * boundary). Source checks remain only for wiring a server render cannot
 * reach (event listeners, aria-disabled while pending).
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined, refresh: () => undefined }) }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: async () => ({ ok: false, status: 500 }),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null
}));

const {
  createSubmitGate,
  FILE_READ_FAILED_MESSAGE,
  FILE_READING_MESSAGE,
  fileReadIssue,
  focusableIndexFor,
  normalizeQuantityText,
  planInvalidSubmit
} = await import('../apps/web/src/lib/form-validation.js');
type ControlDescriptor = import('../apps/web/src/lib/form-validation.js').ControlDescriptor;
const { resolveActionFieldError } = await import('../apps/web/src/lib/form-messages.js');
const { approvalConfirmSpec, EMPTY_SUMMARY_VALUE, makerPoSendConfirmSpec, summaryValueText } = await import(
  '../apps/web/src/lib/confirm-summary.js'
);
const { datetimeTextsFor, isCompleteDateText, isCompleteTimeText, previewLocalValue, formatJstWithWeekday } = await import(
  '../apps/web/src/lib/date-input.js'
);
const { datetimeLocalToIso } = await import('../apps/web/src/lib/datetime.js');
const { CheckboxField, DateTextField, SelectField, TextareaField, TextField } = await import(
  '../apps/web/src/components/fields.js'
);
const { FieldFeedback, FormFeedbackContext } = await import('../apps/web/src/components/form-feedback.js');
const { ApprovalDecisionForm } = await import('../apps/web/src/components/ApprovalDecisionForm.js');
const { DocumentUploadForm } = await import('../apps/web/src/components/DocumentUploadForm.js');
const { MakerPoSendEvidenceForm } = await import('../apps/web/src/components/MakerPoSendEvidenceForm.js');
const { OrderCreateForm } = await import('../apps/web/src/components/OrderCreateForm.js');
const { DeliveryRecordForm } = await import('../apps/web/src/components/DeliveryRecordForm.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');
const render = (node: ReactNode): string => renderToString(node).replaceAll('<!-- -->', '');
const noop = async () => ({ ok: true, message: '' });

/** A control descriptor with sensible defaults (a valid, visible text input). */
function control(patch: Partial<ControlDescriptor> = {}): ControlDescriptor {
  return {
    key: 'field',
    hidden: false,
    disabled: false,
    willValidate: true,
    validity: { valid: true },
    label: '項目',
    info: {},
    ...patch
  };
}

const missing = { valid: false, valueMissing: true };

// ---------------------------------------------------------------------------
// Which controls stop a submit, and where focus goes (review M4)
// ---------------------------------------------------------------------------

describe('planInvalidSubmit: the refusal plan from validity-like descriptors', () => {
  it('nothing invalid: no errors, no focus target', () => {
    expect(planInvalidSubmit([control(), control({ key: 'other' })])).toEqual({ errors: {}, count: 0, focusIndex: null });
    expect(planInvalidSubmit([])).toEqual({ errors: {}, count: 0, focusIndex: null });
  });

  it('collects one message per invalid field and focuses the first invalid control in form order', () => {
    const plan = planInvalidSubmit([
      control({ key: 'ok' }),
      control({ key: 'poNumber', label: '発注番号', validity: missing }),
      control({ key: 'paymentTerms', label: '決済条件', validity: missing, info: { kind: 'select' } })
    ]);
    expect(plan.errors).toEqual({ poNumber: '発注番号を入力してください。', paymentTerms: '決済条件を選択してください。' });
    expect(plan.count).toBe(2);
    expect(plan.focusIndex).toBe(1);
  });

  it('skips hidden, disabled and non-validating controls — the focus goes to the first one the operator can fix', () => {
    const plan = planInvalidSubmit([
      control({ key: 'sentAt', hidden: true, validity: missing }),
      control({ key: 'locked', disabled: true, validity: missing }),
      control({ key: 'readonlyish', willValidate: false, validity: missing }),
      control({ key: 'verifierName', label: '検証者名', validity: missing })
    ]);
    expect(Object.keys(plan.errors)).toEqual(['verifierName']);
    expect(plan.focusIndex).toBe(3);
  });

  it('two inputs of one field (date + time) count once; the first of them takes focus and gives the message', () => {
    const plan = planInvalidSubmit([
      control({ key: 'verifiedAt', label: '検証日時', validity: { valid: false, customError: true }, info: { customMessage: '日付も入力してください（時刻だけでは記録できません）。' } }),
      control({ key: 'verifiedAt', label: '検証日時', validity: { valid: false, customError: true }, info: { customMessage: '別の文' } })
    ]);
    expect(plan).toEqual({ errors: { verifiedAt: '日付も入力してください（時刻だけでは記録できません）。' }, count: 1, focusIndex: 0 });
  });

  it('a control without a name or feedback key is still reported under its own slot', () => {
    const plan = planInvalidSubmit([control({ key: '' }), control({ key: '', label: '数量', validity: missing })]);
    expect(plan.errors).toEqual({ __control1: '数量を入力してください。' });
    expect(plan.focusIndex).toBe(1);
  });

  it('a validity with no recognised flag produces no message and no focus (never an empty error)', () => {
    expect(planInvalidSubmit([control({ validity: { valid: false } })])).toEqual({ errors: {}, count: 0, focusIndex: null });
  });
});

describe('focusableIndexFor: the control a field error focuses', () => {
  const controls = [
    control({ key: 'sentAt', hidden: true }), // hidden UTC value
    control({ key: 'sentAtLocal', hidden: true }),
    control({ key: 'sentAt' }), // visible date text
    control({ key: 'sentAt' }) // visible time text
  ];

  it('picks the first visible, enabled control of the key', () => {
    expect(focusableIndexFor(controls, 'sentAt')).toBe(2);
  });

  it('a field rendered only as hidden or disabled inputs has nothing to focus', () => {
    expect(focusableIndexFor(controls, 'sentAtLocal')).toBeNull();
    expect(focusableIndexFor([control({ key: 'x', disabled: true })], 'x')).toBeNull();
    expect(focusableIndexFor(controls, 'absent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server refusal → field (review M4)
// ---------------------------------------------------------------------------

describe('resolveActionFieldError: a new action result against the fields the form shows', () => {
  const present = new Set(['verifierName', 'poNumber', 'file']);
  const has = (field: string) => present.has(field);

  it('no result yet leaves the errors alone; a success clears them', () => {
    expect(resolveActionFieldError(null, has)).toEqual({ kind: 'none' });
    expect(resolveActionFieldError({ ok: true, message: '記録しました。' }, has)).toEqual({ kind: 'clear' });
  });

  it('a refusal about a present field marks it with the display wording', () => {
    expect(resolveActionFieldError({ ok: false, message: '検証者名（verifierName）を入力してください。' }, has)).toEqual({
      kind: 'field',
      field: 'verifierName',
      message: '検証者名を入力してください。'
    });
    expect(resolveActionFieldError({ ok: false, message: 'ファイルを選択してください。' }, has)).toMatchObject({ field: 'file' });
  });

  it('a mapped field this form does not render, or an unmapped refusal, marks nothing (the result line still shows it)', () => {
    expect(resolveActionFieldError({ ok: false, message: '公式登録日を入力してください。' }, has)).toEqual({ kind: 'none' });
    expect(resolveActionFieldError({ ok: false, message: 'APIが受け付けませんでした。' }, has)).toEqual({ kind: 'none' });
    expect(resolveActionFieldError({ ok: false, message: '' }, has)).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// The pending gate (review M3)
// ---------------------------------------------------------------------------

describe('submit gate while the action runs (review M3)', () => {
  it('every submit while pending is ignored, whatever the fields say', () => {
    const gate = createSubmitGate();
    expect(gate.submit({ invalid: false, needsConfirm: false, pending: true })).toBe('ignore');
    expect(gate.submit({ invalid: true, needsConfirm: true, pending: true })).toBe('ignore');
    expect(gate.state).toBe('idle');
  });

  it('a confirmed pass that arrives while pending is dropped and does not stay armed for a later submit', () => {
    const gate = createSubmitGate();
    gate.submit({ invalid: false, needsConfirm: true });
    expect(gate.confirm()).toBe(true);
    expect(gate.submit({ invalid: false, needsConfirm: false, pending: true })).toBe('ignore');
    // Not armed any more: the next submit asks again.
    expect(gate.submit({ invalid: false, needsConfirm: true })).toBe('confirm');
  });

  it('once the action has finished the gate behaves as before (pending false / omitted)', () => {
    const gate = createSubmitGate();
    expect(gate.submit({ invalid: false, needsConfirm: false, pending: false })).toBe('submit');
    expect(gate.submit({ invalid: true, needsConfirm: false })).toBe('invalid');
  });

  it('wiring (not reachable in a server render): no form disables its focused submit button while pending', () => {
    const files = [
      'apps/web/src/components/ActionForm.tsx',
      'apps/web/src/components/ApprovalDecisionForm.tsx',
      'apps/web/src/components/DeliveryRecordForm.tsx',
      'apps/web/src/components/DocumentUploadForm.tsx',
      'apps/web/src/components/MakerPoSendEvidenceForm.tsx',
      'apps/web/src/components/OrderCreateForm.tsx'
    ];
    for (const file of files) {
      const text = source(file);
      expect(text, file).not.toMatch(/disabled=\{pending\}/);
      expect(text, file).toMatch(/aria-disabled=\{pending \|\| undefined\}/);
      expect(text, file).toMatch(/<FeedbackForm[\s\S]*?pending=\{pending\}/);
    }
    // The shell drops the submit while pending (every submit is prevented; review H1: nothing is dispatched).
    expect(source('apps/web/src/components/form-feedback.tsx')).toMatch(
      /const decision = gate\.submit\(\{ invalid: check\.count > 0, needsConfirm: dialog !== null, pending \}\);[\s\S]*?if \(decision === 'ignore'\) return;/
    );
    // The non-shell submitters follow the same rule.
    expect(source('apps/web/src/components/LoginForm.tsx')).toMatch(/if \(pending\) return;[\s\S]*aria-disabled=\{pending \|\| undefined\}/);
    expect(source('apps/web/src/components/ProjectPicker.tsx')).toMatch(/aria-disabled=\{pending \|\| undefined\}/);
    expect(source('apps/web/src/components/ProjectPicker.tsx')).not.toMatch(/disabled=\{pending\}/);
  });
});

// ---------------------------------------------------------------------------
// The confirm dialog's rows (review M4, Q1)
// ---------------------------------------------------------------------------

describe('summaryValueText: one dialog row from a plain control model', () => {
  it('select → option text; nothing chosen (empty value or empty text) → （未入力）', () => {
    expect(summaryValueText({ kind: 'select', value: 'confirmed', selectedText: ' 確認済み ' })).toBe('確認済み');
    expect(summaryValueText({ kind: 'select', value: '', selectedText: '（選択なし）' })).toBe(EMPTY_SUMMARY_VALUE);
    expect(summaryValueText({ kind: 'select', value: 'x', selectedText: '  ' })).toBe(EMPTY_SUMMARY_VALUE);
  });

  it('checkbox → はい／いいえ; radio group → the checked label, else its value; nothing checked → （未入力）', () => {
    expect(summaryValueText({ kind: 'checkbox', checked: true })).toBe('はい');
    expect(summaryValueText({ kind: 'checkbox', checked: false })).toBe('いいえ');
    expect(summaryValueText({ kind: 'group', checked: { type: 'radio', value: 'rejected', labelText: ' 却下 ' } })).toBe('却下');
    expect(summaryValueText({ kind: 'group', checked: { type: 'radio', value: 'rejected', labelText: null } })).toBe('rejected');
    expect(summaryValueText({ kind: 'group', checked: null })).toBe(EMPTY_SUMMARY_VALUE);
    expect(summaryValueText({ kind: 'missing' })).toBe(EMPTY_SUMMARY_VALUE);
  });

  it('text as typed (trimmed); an explicit-offset instant reads as Japan time; blank → （未入力）', () => {
    expect(summaryValueText({ kind: 'text', value: '  PO-1 ' })).toBe('PO-1');
    expect(summaryValueText({ kind: 'text', value: '2026-11-18T05:30:00.000Z' })).toBe('日本時間 2026/11/18（水）14:30');
    expect(summaryValueText({ kind: 'text', value: '2026-11-18T14:30' })).toBe('2026-11-18T14:30'); // no offset: not an instant
    expect(summaryValueText({ kind: 'text', value: '   ' })).toBe(EMPTY_SUMMARY_VALUE);
  });
});

describe('approvalConfirmSpec / makerPoSendConfirmSpec', () => {
  it('the approval dialog names the organization of the pressed button', () => {
    const spec = approvalConfirmSpec('seven', 'approval.eml（版2）', '日本時間 2026/11/18（水）09:00');
    expect(spec.options.title).toBe('セブン化学の承認を記録しますか？');
    expect(spec.confirmLabel).toBe('セブン化学として承認する');
    expect(spec.summary).toEqual([
      { label: '承認組織', value: 'セブン化学' },
      { label: '承認証跡', value: 'approval.eml（版2）' },
      { label: '承認日時', value: '日本時間 2026/11/18（水）09:00' }
    ]);
    const unknown = approvalConfirmSpec('', undefined, undefined);
    expect(unknown.summary).toEqual([
      { label: '承認組織', value: '（不明）' },
      { label: '承認証跡', value: '（未選択）' },
      { label: '承認日時', value: EMPTY_SUMMARY_VALUE }
    ]);
  });

  const base = {
    senderAddress: ' kanei@example.test ',
    recipients: 'maker@example.test',
    sentAtLocal: '2026-11-18T14:30',
    emlFilename: 'sent.eml',
    hasEmlContent: true,
    versionText: ''
  };

  it('the send dialog reads back sender, recipients, the JST send time and the EML held for the submit', () => {
    const spec = makerPoSendConfirmSpec(base);
    expect(spec.options.title).toBe('手動送信を記録しますか？');
    expect(spec.confirmLabel).toBe('手動送信を記録する');
    expect(spec.summary).toEqual([
      { label: '送信元', value: 'kanei@example.test' },
      { label: '宛先', value: 'maker@example.test' },
      { label: '送信日時', value: `日本時間 ${formatJstWithWeekday(datetimeLocalToIso(base.sentAtLocal)!)}` },
      { label: '送信証跡', value: 'EMLファイル sent.eml' }
    ]);
  });

  it('review Q1: a file name without held bytes (after a recorded send) is never shown as the evidence', () => {
    const stale = makerPoSendConfirmSpec({ ...base, hasEmlContent: false });
    expect(stale.summary[3]).toEqual({ label: '送信証跡', value: '（未選択）' });
    const cited = makerPoSendConfirmSpec({ ...base, hasEmlContent: false, versionText: 'sent.eml（版1）' });
    expect(cited.summary[3]).toEqual({ label: '送信証跡', value: '書類 sent.eml（版1）' });
  });

  it('empty fields read （未入力）, an incomplete send time too', () => {
    const spec = makerPoSendConfirmSpec({ ...base, senderAddress: ' ', recipients: '', sentAtLocal: '' });
    expect(spec.summary.slice(0, 3).map((row) => row.value)).toEqual([EMPTY_SUMMARY_VALUE, EMPTY_SUMMARY_VALUE, EMPTY_SUMMARY_VALUE]);
  });

  it('wiring: the held EML is forgotten after a recorded send and on the form reset (review Q1)', () => {
    const text = source('apps/web/src/components/MakerPoSendEvidenceForm.tsx');
    expect(text).toMatch(/function forgetEml\(\): void \{[\s\S]*?setContentBase64\(''\);[\s\S]*?setEmlFilename\(''\);[\s\S]*?setSelectedSubject\(null\);/);
    expect(text).toMatch(/if \(state\?\.ok\) forgetEml\(\);/);
    expect(text).toMatch(/onReset=\{onFormReset\}/);
    // A read that finishes after the reset cannot refill the form.
    expect(text.match(/if \(token !== readToken\.current\) return;/g) ?? []).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Date + time: reset value and the announced JST line (coordinator finding, review L3)
// ---------------------------------------------------------------------------

describe('date and time texts: reset to the default and what the live line may announce', () => {
  it('datetimeTextsFor gives the texts a field returns to on reset (its default, or empty)', () => {
    expect(datetimeTextsFor('2026-11-17T18:00')).toEqual({ date: '2026/11/17', time: '18:00' });
    expect(datetimeTextsFor('')).toEqual({ date: '', time: '' });
    expect(datetimeTextsFor('garbage')).toEqual({ date: '', time: '' });
  });

  it('complete spellings while typing: full dates and times only', () => {
    for (const text of ['2026/11/18', '2026-11-18', '20261118', '２０２６／１１／１８', ' 2026/11/18 ']) {
      expect(isCompleteDateText(text), text).toBe(true);
    }
    for (const text of ['2026/11/1', '2026/1/18', '2026111', '2026/02/30', '']) expect(isCompleteDateText(text), text).toBe(false);
    for (const text of ['14:30', '9:05', '1430', '０９：０５']) expect(isCompleteTimeText(text), text).toBe(true);
    for (const text of ['143', '14:3', '1', '2400', '25:61', '']) expect(isCompleteTimeText(text), text).toBe(false);
  });

  it('typing 1430 never announces 01:43 on the way (review L3)', () => {
    const date = '2026/11/18';
    const steps = ['1', '14', '143', '1430'].map((time) => previewLocalValue({ date, time }, 'input'));
    expect(steps).toEqual([null, null, null, '2026-11-18T14:30']);
  });

  it('leaving the input (commit) accepts every valid spelling, including the short ones', () => {
    expect(previewLocalValue({ date: '2026/1/5', time: '905' }, 'commit')).toBe('2026-01-05T09:05');
    expect(previewLocalValue({ date: '2026/1/5', time: '905' }, 'input')).toBeNull();
    expect(previewLocalValue({ date: '2026/02/30', time: '14:30' }, 'commit')).toBeNull();
    expect(previewLocalValue({ date: '2026/11/18', time: '' }, 'commit')).toBeNull();
  });

  it('wiring: both date components listen for the form reset (React 19 resets after the action)', () => {
    const inputs = source('apps/web/src/components/DateTimeInputs.tsx');
    expect(inputs).toMatch(/form\.addEventListener\('reset', reset\)/);
    expect(inputs).toMatch(/const initial = initialValue\.current;[\s\S]*?setTexts\(datetimeTextsFor\(initial\)\);[\s\S]*?resetHandler\.current\(initial\);/);
    const fields = source('apps/web/src/components/fields.tsx');
    expect(fields).toMatch(/form\.addEventListener\('reset', onReset\)/);
    // MakerPo: the send time returns to empty as "not edited", so a later EML may fill it again.
    expect(source('apps/web/src/components/MakerPoSendEvidenceForm.tsx')).toMatch(
      /onReset=\{\(sentAt\) => \{[\s\S]*?edited: \{ \.\.\.current\.edited, sentAt: false \}/
    );
  });
});

// ---------------------------------------------------------------------------
// Quantity normalization (review L7) and the file-read hold (review M5)
// ---------------------------------------------------------------------------

describe('normalizeQuantityText (review L7)', () => {
  const SERVER_PATTERN = /^\d+(\.\d+)?$/;

  it('drops surrounding spaces (ASCII and full-width) and turns full-width digits / point into ASCII', () => {
    expect(normalizeQuantityText(' 1000 ')).toBe('1000');
    expect(normalizeQuantityText('１０００')).toBe('1000');
    expect(normalizeQuantityText('　１２．５　')).toBe('12.5');
    for (const text of [' 1000 ', '１０００', '　１２．５　']) expect(normalizeQuantityText(text)).toMatch(SERVER_PATTERN);
  });

  it('leaves what is not a plain quantity for the pattern check to explain', () => {
    expect(normalizeQuantityText('1,000')).toBe('1,000');
    expect(normalizeQuantityText('1 000')).toBe('1 000');
    expect(normalizeQuantityText('abc')).toBe('abc');
    expect(normalizeQuantityText('')).toBe('');
    expect(normalizeQuantityText('1,000')).not.toMatch(SERVER_PATTERN);
  });

  it('both quantity inputs are normalized and keep the server pattern', () => {
    for (const file of ['apps/web/src/components/OrderCreateForm.tsx', 'apps/web/src/components/DeliveryRecordForm.tsx']) {
      const text = source(file);
      expect(text, file).toContain('pattern="\\d+(\\.\\d+)?"');
      expect(text, file).toContain('data-quantity-text=""');
    }
    // The posted line JSON carries the normalized quantity even for an Enter submit without a blur.
    expect(source('apps/web/src/components/OrderCreateForm.tsx')).toContain('orderedQuantity: normalizeQuantityText(line.quantity)');
  });
});

describe('fileReadIssue (review M5)', () => {
  it('holds the submit while reading and refuses after a failed read; nothing otherwise', () => {
    expect(fileReadIssue('reading')).toBe(FILE_READING_MESSAGE);
    expect(FILE_READING_MESSAGE).toBe('ファイルを読み込み中です…');
    expect(fileReadIssue('failed')).toBe(FILE_READ_FAILED_MESSAGE);
    expect(fileReadIssue('read')).toBeNull();
    expect(fileReadIssue('idle')).toBeNull();
  });

  it('DocumentUploadForm: the read state is the file input custom validity; no separate red line next to the button', () => {
    const text = source('apps/web/src/components/DocumentUploadForm.tsx');
    expect(text).toMatch(/fileInput\.current\?\.setCustomValidity\(fileReadIssue\(next\) \?\? ''\)/);
    for (const state of ['reading', 'read', 'failed', 'idle']) expect(text).toContain(`markRead('${state}')`);
    const html = render(
      <DocumentUploadForm
        action={noop}
        documentTypeChoices={[{ value: 'other', label: 'その他' }]}
        issuerEntityChoices={[{ value: 'kanei', label: '兼井' }]}
        contentTypeChoices={[{ value: 'application/pdf', label: 'PDF' }]}
        sevenPurchaseOrderChoices={[]}
        filmSupplyOrderChoices={[]}
      />
    );
    // The read note is an always-present polite region, empty until a file is being read.
    expect(html).toMatch(/<span id="[^"]+" aria-live="polite" class="form-live"[^>]*><\/span>/);
    expect(html).not.toContain('ファイルを読み取れませんでした');
  });
});

// ---------------------------------------------------------------------------
// Labels hold only the caption + control (review L5); field wrappers (height fix)
// ---------------------------------------------------------------------------

/** Every <label>…</label> (labels never nest). */
const labelsOf = (html: string) => [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map((match) => match[0]);

describe('labels wrap only the caption and the control (review L5)', () => {
  const errors = {
    poNumber: '発注番号を入力してください。',
    paymentTerms: '決済条件を選択してください。',
    reasonNote: '根拠を入力してください。',
    acknowledge: 'チェックを入れてください。',
    officialRegisteredAt: '日付は 2026/11/18 の形で、実在する日付を入力してください。'
  };
  const html = render(
    <FormFeedbackContext.Provider value={{ errors, summaryCount: 5 }}>
      <TextField name="poNumber" label="発注番号" required hint="紙の発注書の番号" />
      <SelectField name="paymentTerms" label="決済条件" choices={[{ value: 'prepaid', label: '前払い' }]} hint="下書きの間だけ" />
      <TextareaField name="reasonNote" label="根拠" hint="何を確認したか" />
      <CheckboxField name="acknowledge" label="確認した" hint="必ず確認" />
      <DateTextField name="officialRegisteredAt" label="公式登録日" />
    </FormFeedbackContext.Provider>
  );

  it('no error and no hint text is inside any label (so neither joins the accessible name)', () => {
    const labels = labelsOf(html);
    expect(labels).toHaveLength(5);
    for (const label of labels) {
      expect(label).not.toContain('field-error');
      expect(label).not.toMatch(/紙の発注書の番号|下書きの間だけ|何を確認したか|必ず確認|例 2026\/11\/18/);
    }
  });

  it('every control still points at its hint and error through aria-describedby, and the ids exist', () => {
    const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*aria-describedby="([^"]+)"[^>]*>/g)];
    expect(controls).toHaveLength(5);
    for (const [, ids] of controls) {
      const list = ids!.split(' ');
      expect(list).toHaveLength(2); // hint + error
      for (const id of list) expect(html).toContain(`id="${id}"`);
    }
    expect(html.match(/class="field-error"/g) ?? []).toHaveLength(5);
  });

  it('every field wrapper is a .field (align-content: start keeps controls at their natural height in a stretched row)', () => {
    expect(html.match(/<div class="field[ "]/g) ?? []).toHaveLength(5);
    const css = source('apps/web/src/app/forms.css');
    expect(css).toMatch(/\.field \{\s*align-content: start;\s*\}/);
    expect(css).toMatch(/\.field-label \{\s*display: grid;\s*gap: inherit;/);
  });

  it('the custom forms follow the same rule: errors and help text sit outside their labels', () => {
    const forms = [
      render(
        <ApprovalDecisionForm
          action={noop}
          revisionId="rev-1"
          designKey="d"
          evidenceChoices={[{ value: 'v1', label: 'approval.eml（版2）', autoEvidenceIdentifier: '<approval-id@example.test>' }]}
          evidenceSourceChoices={[{ value: 'email', label: 'メール' }]}
          defaultEventTime="2026-11-17T18:00"
        />
      ),
      render(
        <OrderCreateForm
          action={noop}
          unitChoices={[{ value: 'rolls', label: '巻' }]}
          orderKind="film"
          paymentTermsChoices={[{ value: 'undetermined', label: '未確定' }]}
        />
      ),
      render(
        <DeliveryRecordForm
          action={noop}
          kind="film"
          orders={[{ id: 'o1', code: 'FSO-1', lines: [{ value: 'l1', label: '明細1' }] }]}
          unitChoices={[{ value: 'rolls', label: '巻' }]}
        />
      ),
      render(<MakerPoSendEvidenceForm action={noop} poId="po-1" sendEvidenceChoices={[]} />)
    ];
    for (const form of forms) {
      for (const label of labelsOf(form)) {
        expect(label).not.toContain('field-error');
        expect(label).not.toContain('保存済みEMLのMessage-ID'); // ApprovalDecisionForm help
        expect(label).not.toContain('発注が下書きの間だけ変更できます'); // OrderCreateForm hint
      }
    }
    // The shared G6 help is still linked from the two evidence controls.
    expect(forms[0]!.match(/<(?:select|input)\b[^>]*aria-describedby=/g) ?? []).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Empty live regions take no space (review L6); notices are not errors (review L11)
// ---------------------------------------------------------------------------

describe('live regions and notices', () => {
  it('empty summary / result / live regions are taken out of the flex flow but stay in the DOM (not display:none)', () => {
    const css = source('apps/web/src/app/forms.css');
    const rule = /\.form-summary:empty,\s*\.form-result:empty,\s*\.form-live:empty \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain('position: absolute;');
    expect(rule![1]).not.toMatch(/display:\s*(none|contents)/);
  });

  it('MakerPo: the file notice line uses the note colour unless the notice is an error (review L11)', () => {
    const html = render(<MakerPoSendEvidenceForm action={noop} poId="po-1" sendEvidenceChoices={[]} />);
    expect(html).toMatch(/<span aria-live="polite" class="form-result form-result--note"><\/span>/);
    expect(html).not.toMatch(/aria-live="polite" class="form-result form-result--error"/);
    const text = source('apps/web/src/components/MakerPoSendEvidenceForm.tsx');
    // Auto-fill and header notices are notes; a wrong or unreadable file is an error.
    expect(text).toMatch(/setMessage\(\{ text: notices\.join\(' '\), tone: 'note' \}\)/);
    expect(text.match(/tone: 'error'/g) ?? []).toHaveLength(2);
    expect(source('apps/web/src/app/forms.css')).toMatch(/\.form-result--note \{\s*color: var\(--ink-sub\);/);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 finding N1: the custom forms' own controls read the shell's errors
// ---------------------------------------------------------------------------

describe('FieldFeedback: a custom form control inside the shell gets its error (fix 1, N1)', () => {
  it('inside the provider: the error, aria-invalid and the error id reach the render prop', () => {
    const html = render(
      <FormFeedbackContext.Provider value={{ errors: { file: 'ファイル：ファイルを選んでください。' }, summaryCount: 1 }}>
        <FieldFeedback name="file">
          {(feedback) => (
            <input type="file" aria-invalid={feedback.invalid} aria-describedby={feedback.describedBy} data-error={feedback.error} />
          )}
        </FieldFeedback>
      </FormFeedbackContext.Provider>
    );
    expect(html).toMatch(/<input type="file" aria-invalid="true" aria-describedby="[^"]+error" data-error="ファイル：ファイルを選んでください。"\/>/);
  });

  it("another field's error, or no provider, leaves the control clean", () => {
    const other = render(
      <FormFeedbackContext.Provider value={{ errors: { filename: 'x' }, summaryCount: 1 }}>
        <FieldFeedback name="file">{(feedback) => <input type="file" aria-invalid={feedback.invalid} />}</FieldFeedback>
      </FormFeedbackContext.Provider>
    );
    expect(other).toBe('<input type="file"/>');
    expect(render(<FieldFeedback name="file">{(feedback) => <input type="file" aria-invalid={feedback.invalid} />}</FieldFeedback>))
      .toBe('<input type="file"/>');
  });

  it('wiring: no custom form reads field feedback in its own body (above the provider it renders)', () => {
    for (const file of [
      'apps/web/src/components/ApprovalDecisionForm.tsx',
      'apps/web/src/components/DeliveryRecordForm.tsx',
      'apps/web/src/components/DocumentUploadForm.tsx',
      'apps/web/src/components/MakerPoSendEvidenceForm.tsx',
      'apps/web/src/components/OrderCreateForm.tsx'
    ]) {
      expect(source(file), file).not.toContain('useFieldFeedback(');
      expect(source(file), file).toContain('<FieldFeedback name=');
    }
  });

  it('wiring: the shell listens for the form reset natively (React dispatches no synthetic event during its commit)', () => {
    const shell = source('apps/web/src/components/form-feedback.tsx');
    expect(shell).toMatch(/form\.addEventListener\('reset', reset\)/);
    expect(shell).not.toMatch(/onReset=\{onReset\}/);
  });
});
