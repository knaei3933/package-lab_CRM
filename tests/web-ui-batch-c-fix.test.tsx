import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { japaneseStatusSurface } from '@kanei/core';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';
import { projectScreen } from './helpers/project-screen.js';

/**
 * UI batch C review fixes (H1, M1–M4, L6, L8): what this file pins, by
 * behaviour where a server render or a pure function reaches it —
 *
 * - H1/M2: the shell resets a form only after a successful result (pure
 *   decision), the submit gate asks again after every confirm, the shell
 *   prevents every native submit and dispatches itself (source contract; the
 *   dispatch itself is exercised in web-ui-batch-c-fix-shell.test.tsx), and
 *   the React build the app runs still behaves as that contract assumes.
 * - M1: before hydration (= the server markup) a form with a confirm dialog
 *   has disabled submit buttons; one without keeps a native POST.
 * - M3: the five records that had no confirmation carry a dialog, and the
 *   delivery dialog names 「現在日時」 for an empty date.
 * - M4: the /maker-po stages for a failed list read and for a list that
 *   disagrees with the order status mark no stage.
 * - L6/L8: address inputs, dialog overscroll, dialog button order.
 */
const callApi = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined, refresh: () => undefined }) }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://127.0.0.1:1',
  callApi: (...args: unknown[]) => callApi(...args),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => PROJECT_ID,
  loadSessionUser: async () => ({ id: USER_ID, role: 'admin', displayName: '合成' }),
  loadSession: async () => ({ kind: 'user', user: ({ id: USER_ID, role: 'admin', displayName: '合成' }) })
}));

const { createSubmitGate, shouldResetAfterResult } = await import('../apps/web/src/lib/form-validation.js');
const {
  DELIVERED_AT_NOW_VALUE,
  DELIVERY_RECORD_CONFIRM_TITLE,
  deliveryRecordConfirmSpec,
  EMPTY_SUMMARY_VALUE
} = await import('../apps/web/src/lib/confirm-summary.js');
const { makerPoStages, paymentGateDecides, stageHeadline, upcomingStagesLine } = await import(
  '../apps/web/src/lib/maker-po-stage.js'
);
const { ActionForm } = await import('../apps/web/src/components/ActionForm.js');
const { ApprovalDecisionForm } = await import('../apps/web/src/components/ApprovalDecisionForm.js');
const { ConfirmDialog } = await import('../apps/web/src/components/ConfirmDialog.js');
const { DeliveryRecordForm } = await import('../apps/web/src/components/DeliveryRecordForm.js');
const { DocumentUploadForm } = await import('../apps/web/src/components/DocumentUploadForm.js');
const { MakerPoSendEvidenceForm } = await import('../apps/web/src/components/MakerPoSendEvidenceForm.js');
const { OrderCreateForm } = await import('../apps/web/src/components/OrderCreateForm.js');
const OrdersPage = projectScreen((await import('../apps/web/src/screens/OrdersScreen.js')).OrdersScreen);
const MakerPoPage = projectScreen((await import('../apps/web/src/screens/MakerPoScreen.js')).MakerPoScreen);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');
const render = (node: ReactNode): string => renderToString(node).replaceAll('<!-- -->', '');
const action = async () => ({ ok: true, message: '記録しました。' });

/** Every <button type="submit" …> opening tag of the markup. */
const submitButtons = (html: string): string[] => [...html.matchAll(/<button type="submit"[^>]*>/g)].map((match) => match[0]);
const isDisabled = (tag: string): boolean => / disabled=""/.test(tag);

// ---------------------------------------------------------------------------
// H1 / M2: reset only after a success; the gate after a confirm
// ---------------------------------------------------------------------------

describe('H1: the form is reset only after a successful result', () => {
  it('a refusal (ok: false) never resets — dates, selects, the file and 送信元 stay for the retry', () => {
    expect(shouldResetAfterResult({ ok: false }, null)).toBe(false);
  });

  it('a success (ok: true) resets', () => {
    expect(shouldResetAfterResult({ ok: true }, null)).toBe(true);
  });

  it('no result yet (null, the first render) does not reset', () => {
    expect(shouldResetAfterResult(null, null)).toBe(false);
  });

  it('the same success object again resets nothing more; a new success object resets again', () => {
    const first = { ok: true };
    expect(shouldResetAfterResult(first, first)).toBe(false);
    expect(shouldResetAfterResult({ ok: true }, first)).toBe(true);
  });

  it('a refusal after a success (the previous reset recorded) still does not reset', () => {
    expect(shouldResetAfterResult({ ok: false }, { ok: true })).toBe(false);
  });
});

describe('H1 / L3: the submit gate after a confirm', () => {
  it('confirm() lets exactly one dispatch through and returns to idle; the next submit asks again', () => {
    const gate = createSubmitGate();
    expect(gate.submit({ invalid: false, needsConfirm: true })).toBe('confirm');
    expect(gate.confirm()).toBe(true);
    expect(gate.state).toBe('idle');
    expect(gate.confirm()).toBe(false); // double click on the confirm button
    expect(gate.submit({ invalid: false, needsConfirm: true })).toBe('confirm');
  });

  it('nothing can leave the gate armed: there is no "confirmed" state any more', () => {
    const gate = createSubmitGate();
    gate.submit({ invalid: false, needsConfirm: true });
    gate.confirm();
    // Before the fix a confirmed gate let the next submit skip validation and the dialog.
    expect(gate.submit({ invalid: true, needsConfirm: true })).toBe('invalid');
    expect(gate.submit({ invalid: false, needsConfirm: true })).toBe('confirm');
  });

  it('cancel, then confirm: nothing is dispatched', () => {
    const gate = createSubmitGate();
    gate.submit({ invalid: false, needsConfirm: true });
    gate.cancel();
    expect(gate.confirm()).toBe(false);
  });

  it('while pending every submit is ignored and an open dialog stays open', () => {
    const gate = createSubmitGate();
    gate.submit({ invalid: false, needsConfirm: true });
    expect(gate.submit({ invalid: false, needsConfirm: false, pending: true })).toBe('ignore');
    expect(gate.state).toBe('confirming');
  });
});

/** The first statement of onSubmit with comments and whitespace ignored. */
const firstStatementOfOnSubmit = (text: string): string => {
  const start = text.indexOf('function onSubmit(');
  const body = start < 0 ? '' : text.slice(text.indexOf('{', start) + 1);
  return body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().split(';')[0]!.replace(/\s+/g, '');
};

describe('H1: the shell dispatches every submit itself (source contract; behaviour in the -shell test)', () => {
  const shell = source('apps/web/src/components/form-feedback.tsx');

  it('onSubmit prevents the native submit before any decision', () => {
    expect(firstStatementOfOnSubmit(shell)).toBe('event.preventDefault()');
  });

  it('the action runs through startTransition with formDataFor(form, submitter), never requestSubmit', () => {
    expect(shell).toMatch(/const formData = formDataFor\(form, submitter\);\s*startTransition\(\(\) => action\(formData\)\);/);
    expect(shell).not.toContain('requestSubmit(');
  });

  it('the only form reset is the one guarded by shouldResetAfterResult (behaviour: the -shell reset tests)', () => {
    const code = shell.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    expect(code.match(/\.reset\(\)/g)).toHaveLength(1);
    expect(code).toMatch(/shouldResetAfterResult\(state\b[\s\S]{0,200}?\.reset\(\)/);
  });

  it('the <form> keeps its action for the pre-hydration POST', () => {
    expect(shell).toMatch(/<form\s+ref=\{formRef\}\s+action=\{action\}/);
  });
});

describe('H1: the React build the app runs (Next compiled react-dom) behaves as the shell assumes', () => {
  const builds = ['react-dom-client.development.js', 'react-dom-client.production.js'].map((file) =>
    source(`node_modules/next/dist/compiled/react-dom/cjs/${file}`)
  );

  it.each([0, 1])('build %i: a function action resets the form, a prevented submit records only a no-op status', (index) => {
    const reactDom = builds[index]!;
    // startHostTransition: a null action is a noop; only a real action asks for the reset.
    expect(reactDom).toMatch(/null === action\s*\?\s*noop\s*:\s*function \(\) \{\s*requestFormReset\$1\(formFiber\);\s*return action\(formData\);/);
    // FormActionEventPlugin: when defaultPrevented it passes null as the action.
    expect(reactDom).toMatch(
      /if \(nativeEvent\.defaultPrevented\) \{\s*if \(0 !== currentEventTransitionLane\) \{[\s\S]{0,900}?startHostTransition\([\s\S]{0,300}?null,\s*formData\s*\);\s*\}\s*\} else/
    );
  });

  it.each([0, 1])('build %i: React builds the FormData with a temporary submitter input — the order formDataFor copies', (index) => {
    expect(builds[index]!).toMatch(
      /function createFormDataWithSubmitter\(form, submitter\) \{\s*var temp = submitter\.ownerDocument\.createElement\("input"\);\s*temp\.name = submitter\.name;\s*temp\.value = submitter\.value;\s*form\.id && temp\.setAttribute\("form", form\.id\);\s*submitter\.parentNode\.insertBefore\(temp, submitter\);\s*form = new FormData\(form\);\s*temp\.parentNode\.removeChild\(temp\);\s*return form;\s*\}/
    );
  });
});

describe('H1 / M2: comments and reset wiring describe the new behaviour', () => {
  it('no component still claims React resets the form after every action', () => {
    for (const file of [
      'apps/web/src/components/form-feedback.tsx',
      'apps/web/src/components/DateTimeInputs.tsx',
      'apps/web/src/components/OffsetDateTimeField.tsx',
      'apps/web/src/components/MakerPoSendEvidenceForm.tsx'
    ]) {
      expect(source(file), file).not.toMatch(/React 19 resets? (?:a|the) form after its action/);
      expect(source(file), file).not.toMatch(/\(React 19, after the action\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// M1: before hydration, a confirm-guarded form cannot be submitted
// ---------------------------------------------------------------------------

const approvalProps = {
  action,
  revisionId: 'rev-1',
  designKey: 'label-front',
  evidenceChoices: [{ value: 'v1', label: 'approval.eml（版1）' }],
  evidenceSourceChoices: [{ value: 'email', label: 'メール' }],
  defaultEventTime: '2026-11-17T18:00'
};
const uploadProps = {
  action,
  documentTypeChoices: [{ value: 'proof', label: '校正ゲラ' }],
  issuerEntityChoices: [{ value: 'kanei', label: 'カネイ' }],
  contentTypeChoices: [{ value: 'application/pdf', label: 'PDF' }],
  sevenPurchaseOrderChoices: [],
  filmSupplyOrderChoices: []
};
const confirmSpec = { title: '記録しますか？', body: '記録します。' };

describe('M1: submit buttons in the server markup (= before hydration)', () => {
  it('ActionForm with a confirm (代表承認-like: hidden field + button only): the button is disabled', () => {
    const html = render(
      <ActionForm action={action} submitLabel="代表承認を記録する" confirm={{ ...confirmSpec, tone: 'primary' }}>
        <input type="hidden" readOnly name="poId" value="po-1" />
      </ActionForm>
    );
    const buttons = submitButtons(html);
    expect(buttons).toHaveLength(1);
    expect(isDisabled(buttons[0]!)).toBe(true);
    expect(html).toContain('<dialog class="confirm-dialog"');
  });

  it('ActionForm without a confirm keeps the native POST: the button is enabled', () => {
    const html = render(
      <ActionForm action={action} submitLabel="記録する">
        <input name="note" />
      </ActionForm>
    );
    expect(submitButtons(html).map(isDisabled)).toEqual([false]);
    expect(html).not.toContain('<dialog');
  });

  it('ApprovalDecisionForm: both organization buttons are disabled and keep name/value', () => {
    const buttons = submitButtons(render(<ApprovalDecisionForm {...approvalProps} />));
    expect(buttons).toHaveLength(2);
    expect(buttons.every(isDisabled)).toBe(true);
    expect(buttons.map((button) => /value="([^"]+)"/.exec(button)?.[1])).toEqual(['customer', 'seven']);
    expect(buttons.every((button) => button.includes('name="organization"'))).toBe(true);
  });

  it('MakerPoSendEvidenceForm (built-in confirm): the button is disabled', () => {
    const html = render(<MakerPoSendEvidenceForm action={action} poId="po-1" sendEvidenceChoices={[]} />);
    expect(submitButtons(html).map(isDisabled)).toEqual([true]);
  });

  it('DeliveryRecordForm (confirm added, review M3): the button is disabled', () => {
    const html = render(
      <DeliveryRecordForm
        action={action}
        kind="film"
        orders={[{ id: 'o1', code: 'FSO-1', lines: [{ value: 'l1', label: '明細1' }] }]}
        unitChoices={[{ value: 'rolls', label: 'ロール' }]}
      />
    );
    expect(submitButtons(html).map(isDisabled)).toEqual([true]);
  });

  it('DocumentUploadForm and OrderCreateForm: disabled only when a confirm is passed', () => {
    expect(submitButtons(render(<DocumentUploadForm {...uploadProps} />)).map(isDisabled)).toEqual([false]);
    expect(submitButtons(render(<DocumentUploadForm {...uploadProps} confirm={confirmSpec} />)).map(isDisabled)).toEqual([true]);
    const order = {
      action,
      orderKind: 'film' as const,
      unitChoices: [{ value: 'm', label: 'm' }],
      paymentTermsChoices: [{ value: 'undetermined', label: '未確定' }]
    };
    expect(submitButtons(render(<OrderCreateForm {...order} />)).map(isDisabled)).toEqual([false]);
    expect(submitButtons(render(<OrderCreateForm {...order} confirm={confirmSpec} />)).map(isDisabled)).toEqual([true]);
  });

  it('pending stays aria-disabled (not disabled) in every form: the lock is a separate flag', () => {
    for (const file of [
      'ActionForm.tsx',
      'ApprovalDecisionForm.tsx',
      'DeliveryRecordForm.tsx',
      'DocumentUploadForm.tsx',
      'MakerPoSendEvidenceForm.tsx',
      'OrderCreateForm.tsx'
    ]) {
      const text = source(`apps/web/src/components/${file}`);
      expect(text, file).toContain('<SubmitLock>');
      expect(text, file).toMatch(/disabled=\{locked \|\| undefined\}/);
      expect(text, file).not.toMatch(/(?<!aria-)disabled=\{pending/);
    }
    // The lock is "has a confirm and not mounted" — not pending.
    expect(source('apps/web/src/components/form-feedback.tsx')).toContain('const submitLocked = Boolean(confirm) && !mounted;');
  });
});

// ---------------------------------------------------------------------------
// M3: confirmations on the manual records
// ---------------------------------------------------------------------------

describe('M3: the delivery confirmation names 「現在日時」 for an empty 納品日', () => {
  const rows = [
    { label: '発注', value: 'FSO-1' },
    { label: '明細', value: '明細1' },
    { label: '納品数量', value: '1000' },
    { label: '単位', value: 'ロール' }
  ];

  it('empty (the shell reads （未入力）) → the recording time is named', () => {
    const spec = deliveryRecordConfirmSpec(rows, EMPTY_SUMMARY_VALUE);
    expect(spec.summary.at(-1)).toEqual({ label: '納品日', value: DELIVERED_AT_NOW_VALUE });
    expect(DELIVERED_AT_NOW_VALUE).toContain('現在日時');
    expect(spec.options.body).toContain('現在日時');
  });

  it('blank text is treated the same as （未入力）', () => {
    expect(deliveryRecordConfirmSpec(rows, '  ').summary.at(-1)?.value).toBe(DELIVERED_AT_NOW_VALUE);
  });

  it('an entered date is shown as read (日本時間 …), and the other rows keep their order', () => {
    const spec = deliveryRecordConfirmSpec(rows, '日本時間 2026/11/18（水）14:30');
    expect(spec.summary).toEqual([...rows, { label: '納品日', value: '日本時間 2026/11/18（水）14:30' }]);
    expect(spec.options.title).toBe(DELIVERY_RECORD_CONFIRM_TITLE);
    expect(spec.confirmLabel).toBe('納品を記録する');
  });

  it('the form wires it: the dialog title is in the markup and the resolver reads 納品日 first', () => {
    const html = render(
      <DeliveryRecordForm action={action} kind="film" orders={[{ id: 'o1', code: 'FSO-1', lines: [] }]} unitChoices={[]} />
    );
    expect(html).toMatch(/<dialog class="confirm-dialog"[^>]*>[\s\S]*?<h2 [^>]*>納品を記録しますか？<\/h2>/);
    expect(source('apps/web/src/components/DeliveryRecordForm.tsx')).toMatch(
      /const \[deliveredAt, \.\.\.rows\] = summaryFromFields\(form, \['deliveredAt', 'orderId', 'lineId', 'deliveredQuantity', 'unit'\]\);\s*return deliveryRecordConfirmSpec\(rows, deliveredAt\?\.value \?\? ''\);/
    );
  });
});

// Page fixtures: one unregistered seven PO, a DRAFT order (G6 terms), and maker-PO orders.
const PROJECT_ID = '01a1ec52-a795-7bdb-bc42-fd346d93d444';
const USER_ID = '01a1ec52-a730-7596-aff1-4072d76c1c99';
const SEVEN_PO = '01a1ec70-0000-7000-8000-00000000aa01';
const ORDER_DRAFT = '01a1ec70-0000-7000-8000-00000000bb01';
const ORDER_SENT = '01a1ec70-0000-7000-8000-00000000bb02';
const ORDER_READY = '01a1ec70-0000-7000-8000-00000000bb03';
const ORDER_APPROVED = '01a1ec70-0000-7000-8000-00000000bb04';
const MAKER_PO_SENT = '01a1ec70-0000-7000-8000-00000000cc01';

let sequence = 0;
function auditRow(
  entityType: string,
  auditAction: string,
  entityId: string,
  afterState: Record<string, unknown>,
  beforeState: Record<string, unknown> | null = null
): AuditHistoryRow {
  sequence += 1;
  return {
    id: `01a1ec71-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    action: auditAction,
    entityType,
    entityId,
    beforeState,
    afterState,
    occurredAt: new Date(Date.UTC(2026, 10, 18, 3, 0, sequence)),
    requestMetadata: { operation: auditAction.toLowerCase() },
    actor: { id: USER_ID, displayName: '合成代表者', role: 'admin' }
  };
}

function filmOrder(id: string, code: string, statuses: string[]): AuditHistoryRow[] {
  const rows = [auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', id, {
    id, code, status: 'DRAFT', lineCount: 1, projectId: PROJECT_ID, paymentTerms: 'prepaid',
    sevenPurchaseOrderId: SEVEN_PO, createdByUserId: USER_ID
  })];
  let from = 'DRAFT';
  for (const to of statuses) {
    rows.push(auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_TRANSITIONED', id, { status: to }, { status: from }));
    from = to;
  }
  return rows;
}

const TO_READY = ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY'];
const SEVEN_PO_ROWS = [
  auditRow('seven_purchase_order', 'SEVEN_PO_CREATED', SEVEN_PO, {
    id: SEVEN_PO, projectId: PROJECT_ID, poNumber: 'SC-FIX-1', officialRegisteredAt: null, verificationStatus: 'unverified'
  })
];
const MAKER_PO_SENT_ROW = {
  id: MAKER_PO_SENT, filmSupplyOrderId: ORDER_SENT, status: 'MAKER_PO_SENT_MANUALLY', orderCode: 'FSO-SENT',
  recipientAddress: 'maker@example.test', ceoApprovedAt: '2026-11-18T01:00:00.000Z',
  createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T02:00:00.000Z'
};
const VERIFIED_SEND = {
  id: 'ev-send', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'VERIFIED',
  sentAt: '2026-11-18T02:00:00.000Z', recordedAt: '2026-11-18T02:05:00.000Z'
};

type ListMode = 'ok' | 'error' | 'empty';

/** Serves the audit rows and the maker-PO reads; `list` decides the maker PO list of ORDER_APPROVED. */
function serve(rows: AuditHistoryRow[], list: ListMode = 'ok') {
  callApi.mockImplementation(async (apiPath: string) => {
    const ok = (data: unknown) => ({ ok: true, status: 200, error: null, data });
    if (apiPath === `/api/projects/${PROJECT_ID}`) return ok({ id: PROJECT_ID, code: 'CMP-FIX', name: '合成FIX', route: 'F1', status: 'ACTIVE' });
    if (apiPath === '/api/status-labels') return ok(japaneseStatusSurface());
    if (apiPath.includes('/audit-history')) {
      const entityType = new URL(apiPath, 'http://x').searchParams.get('entityType');
      return ok({ events: JSON.parse(JSON.stringify(buildAuditViewForRole('admin', rows.filter((row) => row.entityType === entityType)))) });
    }
    if (apiPath.endsWith('/payment-gate')) {
      return ok({ orderId: 'x', orderStatus: 'x', paymentTerms: 'prepaid', gate: { satisfied: true, code: null, reason: null }, paymentConfirmedAt: null });
    }
    if (apiPath === `/api/film-supply-orders/${ORDER_SENT}/maker-purchase-orders`) return ok({ makerPurchaseOrders: [MAKER_PO_SENT_ROW] });
    if (apiPath === `/api/film-supply-orders/${ORDER_APPROVED}/maker-purchase-orders`) {
      return list === 'error'
        ? { ok: false, status: 500, error: 'メーカー発注書の一覧を取得できませんでした（合成）', data: null }
        : ok({ makerPurchaseOrders: [] });
    }
    if (apiPath.endsWith('/maker-purchase-orders')) return ok({ makerPurchaseOrders: [] });
    if (apiPath === `/api/maker-purchase-orders/${MAKER_PO_SENT}`) return ok({ purchaseOrder: MAKER_PO_SENT_ROW, events: [VERIFIED_SEND] });
    return { ok: false, status: 404, error: 'not served in this test', data: null };
  });
}

async function renderPage(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

/** The markup of the first <form> whose submit button reads `label`. */
function formWithButton(html: string, label: string): string {
  const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((match) => match[0]);
  return forms.find((form) => new RegExp(`<button type="submit"[^>]*>${label}</button>`).test(form)) ?? '';
}

beforeEach(() => {
  callApi.mockReset();
});

const { SevenPoChecklistForm, SevenPoRegisterForm } = await import('../apps/web/src/components/SevenPoForms.js');
const { PaymentTermsChange } = await import('../apps/web/src/components/OrderTermsSection.js');

describe('M3: 本登録, 発注書の照合チェック, 支払条件 ask first (primary tone, disabled before hydration) — on the order screen since P4 §0', () => {
  // P4 web2a §0: these forms moved from the 発注の一覧 table to the order screen (steps 1–2, 「発注の条件」).
  const draft = { id: ORDER_DRAFT, code: 'FSO-DRAFT', status: 'DRAFT', paymentTerms: 'undetermined', paymentTermsEditable: true } as never;
  it.each([
    ['本登録する', '本登録日を記録しますか？', ['本登録日'], () => <SevenPoRegisterForm poId="po-1" poNumber="PO-1" role="admin" />],
    ['照合チェックを記録する', '発注書の照合チェックを記録しますか？', ['相違あり・確認中', '履歴に残ります'], () => <SevenPoChecklistForm poId="po-1" poNumber="PO-1" role="staff" />],
    ['支払条件を変更する', '発注 FSO-DRAFT の支払条件を変更しますか？', ['入金確認ではありません', '代表承認の前なら記録し直せます'], () => <PaymentTermsChange order={draft} role="staff" cancelled={false} />]
  ] as const)('%s → dialog 「%s」', (button, title, bodyParts, node) => {
    const html = render(node());
    const form = formWithButton(html, `${button}(?:<span class="visually-hidden">[^<]*</span>)?`);
    expect(form, button).not.toBe('');
    expect(form).toMatch(new RegExp(`<dialog class="confirm-dialog"[^>]*>[\\s\\S]*?<h2 [^>]*>${title}</h2>`));
    for (const part of bodyParts) expect(form).toContain(part);
    expect(form).not.toContain('confirm-dialog--danger');
    expect(submitButtons(form).map(isDisabled)).toEqual([true]);
  });

  it('the summary fields name real controls of each form (the dialog rows are read from them)', () => {
    const forms = source('apps/web/src/components/SevenPoForms.tsx');
    expect(forms).toContain("summaryFields: ['officialRegisteredAt']");
    expect(forms).toMatch(/summaryFields: \[\s*'quoteMatchesPo',\s*'quoteCompared',\s*'uncertain',\s*'confirmationReplyRecorded',\s*'documentNumber',\s*'issueDate'\s*\]/);
    for (const name of ['officialRegisteredAt', 'quoteMatchesPo', 'quoteCompared', 'uncertain', 'confirmationReplyRecorded', 'documentNumber', 'issueDate']) {
      expect(forms).toContain(`name="${name}"`);
    }
    expect(source('apps/web/src/components/OrderTermsSection.tsx')).toContain("summaryFields: ['paymentTerms', 'reason']");
  });

  it('the 発注の一覧 table carries none of them any more (it only reads)', async () => {
    serve([...SEVEN_PO_ROWS, ...filmOrder(ORDER_DRAFT, 'FSO-DRAFT', [])]);
    const html = await renderPage(OrdersPage);
    for (const button of ['本登録する', 'チェックリストを記録する', '支払条件を変更する']) expect(formWithButton(html, button), button).toBe('');
  });
});

describe('M3: /maker-po — 受入記録（仮） is recorded at step 10 of the order screen (P4 §0)', () => {
  it('the maker list draws no acceptance form; it links the order screen at step 10', async () => {
    serve([...SEVEN_PO_ROWS, ...filmOrder(ORDER_SENT, 'FSO-SENT', [...TO_READY, 'APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY'])]);
    const html = await renderPage(MakerPoPage);
    expect(formWithButton(html, '受入記録（仮）を記録する')).toBe('');
    expect(html.match(/<form\b/g) ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M4: /maker-po stages when the list failed or disagrees with the order
// ---------------------------------------------------------------------------

const stateOf = (view: ReturnType<typeof makerPoStages>) =>
  Object.fromEntries(view.stages.map((stage) => [stage.key, stage.state]));

describe('M4: maker-po stages — normal / list error / mismatch', () => {
  it('normal: MAKER_PO_READY, empty list, no error → ① is current (unchanged)', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [], listFailed: false });
    expect(view.current?.key).toBe('create');
    expect(view).toMatchObject({ condition: 'normal', unknown: null });
    expect(stageHeadline(view)).toBe('手順1: 発注書の作成');
    expect(upcomingStagesLine(view)).toBe('このあと: 手順2: 代表承認 → 手順3: 送信の記録 → 手順4: 受入 → 完了');
    expect(paymentGateDecides(view)).toBe(true);
  });

  it('list error: no current stage, nothing done, attention, the reload headline and no 「このあと」', () => {
    const view = makerPoStages({ orderStatus: 'APPROVED_FOR_MANUAL_SEND', papers: [], listFailed: true });
    expect(view.current).toBeNull();
    expect(Object.values(stateOf(view)).every((state) => state === 'upcoming')).toBe(true);
    expect(view).toMatchObject({ condition: 'attention', unknown: 'list-error', primaryPoId: null });
    expect(stageHeadline(view)).toBe('メーカー発注書を取得できませんでした（再読み込みしてください）');
    expect(upcomingStagesLine(view)).toBeNull();
    // The gate box stays large (its state is shown in full while the stage is unknown).
    expect(paymentGateDecides(view)).toBe(true);
  });

  it('list error at MAKER_PO_READY too: an unread list is never "no paper yet"', () => {
    const view = makerPoStages({ orderStatus: 'MAKER_PO_READY', papers: [], listFailed: true });
    expect(view.current).toBeNull();
    expect(view.unknown).toBe('list-error');
  });

  it.each(['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED'])(
    'mismatch: %s with an empty list (no error) → no current stage, attention',
    (orderStatus) => {
      const view = makerPoStages({ orderStatus, papers: [] });
      expect(view.current).toBeNull();
      expect(view).toMatchObject({ condition: 'attention', unknown: 'missing-paper' });
      expect(stageHeadline(view)).toBe('メーカー発注書を確認できません（発注の状態と一致しません）');
      expect(stageHeadline(view)).not.toContain('作成');
      expect(upcomingStagesLine(view)).toBeNull();
    }
  );

  it('boundaries: an order status the role may not read (null) keeps ① current; a closed order stays complete even with a list error', () => {
    expect(makerPoStages({ orderStatus: null, papers: [] }).current?.key).toBe('create');
    const closed = makerPoStages({ orderStatus: 'FILM_SHIPPED', papers: [], listFailed: true });
    expect(closed).toMatchObject({ condition: 'complete', unknown: null, current: null });
    expect(paymentGateDecides(closed)).toBe(false);
  });

  it('a readable paper is unaffected by the mismatch rule (APPROVED_FOR_MANUAL_SEND + its paper → ③)', () => {
    const view = makerPoStages({
      orderStatus: 'APPROVED_FOR_MANUAL_SEND',
      papers: [{
        po: { id: 'p1', status: 'APPROVED_FOR_MANUAL_SEND', ceoApprovedAt: '2026-11-18T01:00:00.000Z', createdAt: '2026-11-18T00:00:00.000Z' },
        events: [],
        pendingVerification: false,
        confirmedVerification: null
      }]
    });
    expect(view.current?.key).toBe('send');
    expect(view.unknown).toBeNull();
  });
});

/** The /maker-po stage list (the page header has its own progress stepper). */
const makerStages = (html: string): string =>
  /<ol class="stepper" aria-label="メーカー発注の段階">[\s\S]*?<\/ol>/.exec(html)?.[0] ?? 'missing stage list';

describe('M4: the /maker-po card on screen', () => {
  const approvedRows = () => [...SEVEN_PO_ROWS, ...filmOrder(ORDER_APPROVED, 'FSO-APPR', [...TO_READY, 'APPROVED_FOR_MANUAL_SEND'])];

  it('list error: the reload headline, an error fallback, no current step, no 「作成してください」', async () => {
    serve(approvedRows(), 'error');
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('<span class="stage-now">いまの段階</span><strong>メーカー発注書を取得できませんでした（再読み込みしてください）</strong>');
    expect(html).toContain('メーカー発注書の一覧を取得できなかったため、いまの段階を表示できません。画面を再読み込みしてください。');
    expect(html).toContain('stage-current--attention');
    expect(makerStages(html)).not.toContain('aria-current="step"');
    expect(html).not.toContain('作成してください');
    expect(html).not.toContain('class="stage-next"');
  });

  it('mismatch (APPROVED_FOR_MANUAL_SEND, empty list): no current step, the mismatch fallback', async () => {
    serve(approvedRows(), 'empty');
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('<strong>メーカー発注書を確認できません（発注の状態と一致しません）</strong>');
    expect(html).toContain('メーカー発注書が見つかりません。画面を再読み込みし');
    expect(makerStages(html)).not.toContain('aria-current="step"');
    expect(html).not.toContain('作成してください');
  });

  it('normal (MAKER_PO_READY, empty list): ① stays current with the create fallback', async () => {
    serve([...SEVEN_PO_ROWS, ...filmOrder(ORDER_READY, 'FSO-READY', TO_READY)]);
    const html = await renderPage(MakerPoPage);
    expect(html).toContain('<strong>手順1: 発注書の作成</strong>');
    expect(makerStages(html).match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('上の「手順1: 発注書の作成」で作成してください。');
  });
});

// ---------------------------------------------------------------------------
// L6 / L8
// ---------------------------------------------------------------------------

describe('L6: address inputs and the dialog scroll', () => {
  it('送信元・宛先: no autocomplete, spell check or capitalization, and still type="text" (client validation unchanged)', () => {
    const html = render(<MakerPoSendEvidenceForm action={action} poId="po-1" sendEvidenceChoices={[]} recipientAddress="maker@example.test" />);
    for (const name of ['senderAddress', 'recipients']) {
      const input = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(input, name).toContain('type="text"');
      expect(input, name).toContain('autoComplete="off"');
      expect(input, name).toContain('spellCheck="false"');
      expect(input, name).toContain('autoCapitalize="off"');
      expect(input, name).not.toContain('type="email"');
    }
  });

  it('other TextFields render no new attributes (the props are opt-in)', async () => {
    const { TextField } = await import('../apps/web/src/components/fields.js');
    const input = /<input[^>]*>/.exec(render(<TextField name="code" label="コード" />))?.[0] ?? '';
    expect(input).not.toMatch(/autoComplete|spellCheck|autoCapitalize/);
  });

  it('the dialog contains its own overscroll', () => {
    const css = source('apps/web/src/app/forms.css');
    const rule = /\.confirm-dialog \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('overscroll-behavior: contain;');
  });
});

describe('L8: the dialog buttons (markup; the click wiring is exercised in the -shell test)', () => {
  it('キャンセル comes first (initial focus), the confirm label second; both are type="button"', () => {
    const html = render(
      <ConfirmDialog open={false} title="記録しますか？" body="本文" summary={[]} confirmLabel="記録する" onConfirm={() => undefined} onCancel={() => undefined} />
    );
    const buttons = [...html.matchAll(/<button type="button"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(buttons).toEqual(['キャンセル', '記録する']);
  });
});
