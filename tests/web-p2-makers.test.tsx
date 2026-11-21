import { renderToStaticMarkup } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { japaneseStatusSurface } from '@kanei/core';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';
import type { AuditHistoryRow } from '../apps/api/src/audit-view.js';
import { projectScreen } from './helpers/project-screen.js';

/**
 * P2 web lane X2 (contract v1.2 §2/§4/§6, DESIGN §4/§5/§6/§9): the maker PO
 * 送信先 chooser (master address or typed, never both), the representative's
 * メーカーの宛先 page, MPO numbers on the board and in the step panel, and the
 * 4 デザイン入稿 chain (artwork_submission bound to the order → デザイン受領).
 * The web's API client is mocked; nothing reaches a server or a database.
 */
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ role: 'admin' as string }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  callApi: (...args: unknown[]) => callApi(...args),
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => PROJECT_ID,
  loadSessionUser: async () => ({ id: USER_ID, role: session.role, displayName: '合成' }),
  loadSession: async () => ({ kind: 'user', user: { id: USER_ID, role: session.role, displayName: '合成' } })
}));
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: () => undefined, usePathname: () => '/makers', useRouter: () => ({ refresh: () => undefined }) }));

const PROJECT_ID = '01a1ec52-a795-7bdb-bc42-fd346d93d999';
const USER_ID = '01a1ec52-a730-7596-aff1-4072d76c1c99';
const MAKER_ID = '01a1ec70-0000-7000-8000-0000000000a1';
const ADDRESS_DEFAULT = '01a1ec70-0000-7000-8000-0000000000b1';
const ADDRESS_OTHER = '01a1ec70-0000-7000-8000-0000000000b2';
const ADDRESS_OFF = '01a1ec70-0000-7000-8000-0000000000b3';

const masterModule = await import('../apps/web/src/lib/maker-master.js');
const { recipientChoicesFrom, recipientChoiceOf, TYPED_RECIPIENT, RECIPIENT_CHOICE_FIELD, RECIPIENT_CHOICE_INVALID_MESSAGE } = masterModule;
const { RecipientChooser, TYPED_RECIPIENT_VALUE, RECIPIENT_CHOICE_NAME } = await import('../apps/web/src/components/RecipientChooser.js');
const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');
const makersActions = await import('../apps/web/src/app/makers/actions.js');
const MakersPage = (await import('../apps/web/src/app/makers/page.js')).default;
const { MAKERS_ONLY_NOTICE } = await import('../apps/web/src/components/MakerMaster.js');
const { StepPanelView } = await import('../apps/web/src/components/StepPanel.js');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { buildOrderFlow } = await import('../apps/web/src/lib/order-flow.js');
const { RENDERED_PROJECT_FIELD, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');
const { RECIPIENT_EMAIL_INVALID_MESSAGE } = await import('../apps/web/src/lib/form-messages.js');
const { webErrorText } = await import('../apps/web/src/lib/error-dictionary.js');
const MakerPoPage = projectScreen((await import('../apps/web/src/screens/MakerPoScreen.js')).MakerPoScreen);

const KEY = 'p2-makers-key-0001';
const RENDERED = 'proj-RENDERED';
const form = (entries: Record<string, string> = {}, { project = RENDERED as string | null, key = KEY as string | null } = {}) => {
  const data = new FormData();
  if (project !== null) data.set(RENDERED_PROJECT_FIELD, project);
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) data.append(name, value);
  return data;
};
const ok = (data: unknown = { id: 'r-1' }, status = 201) => ({ ok: true, status, data, error: null, code: null, failure: null });
const refuse = (status: number, code: string) => ({
  ok: false, status, data: { code }, error: webErrorText(code).message, errorKo: webErrorText(code).messageKo, code, failure: null
});
/** The value of the checked radio of the 送信先 group (null when none is checked). */
const checkedChoice = (html: string): string | null => {
  const radio = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => match[0])
    .find((tag) => tag.includes('name="recipientChoice"') && /\schecked(=""|\s|\/|>)/.test(tag));
  return radio ? /value="([^"]*)"/.exec(radio)![1]! : null;
};
const calls = () => callApi.mock.calls.map((call) => ({ path: call[0] as string, ...(call[1] as Record<string, unknown> | undefined) }));

const address = (id: string, email: string, extra: Record<string, unknown> = {}) => ({
  id, email, label: null, isDefault: false, isActive: true, updatedAt: '2026-11-21T00:00:00.000Z', ...extra
});
const MAKER = {
  id: MAKER_ID, name: '合成フィルム工業', externalCode: 'KF-01', isActive: true,
  recipientAddresses: [
    address(ADDRESS_OTHER, 'order@maker.example', { label: '発注窓口' }),
    address(ADDRESS_DEFAULT, 'sales@maker.example', { label: '営業部', isDefault: true })
  ]
};

beforeEach(() => {
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
  revalidatePath.mockReset();
  session.role = 'admin';
});

// ---------------------------------------------------------------------------
// A. the recipient choices and the chooser
// ---------------------------------------------------------------------------

describe('recipientChoicesFrom (GET /api/projects/:id/maker-recipient-addresses)', () => {
  it('lists the active addresses with the default first', () => {
    const choices = recipientChoicesFrom({ projectId: PROJECT_ID, maker: { ...MAKER, recipientAddresses: [...MAKER.recipientAddresses, address(ADDRESS_OFF, 'old@maker.example', { isActive: false })] } });
    expect(choices.kind).toBe('list');
    if (choices.kind !== 'list') return;
    expect(choices.makerName).toBe('合成フィルム工業');
    expect(choices.addresses.map((entry) => entry.id)).toEqual([ADDRESS_DEFAULT, ADDRESS_OTHER]);
  });

  it('says no maker, no usable address and an unreadable answer apart', () => {
    expect(recipientChoicesFrom({ projectId: PROJECT_ID, maker: null })).toEqual({ kind: 'no_maker' });
    expect(recipientChoicesFrom({ projectId: PROJECT_ID, maker: { ...MAKER, recipientAddresses: [address(ADDRESS_OFF, 'old@maker.example', { isActive: false })] } }))
      .toEqual({ kind: 'no_addresses', makerName: '合成フィルム工業' });
    expect(recipientChoicesFrom(null).kind).toBe('unreadable');
    expect(recipientChoicesFrom({ maker: { id: 'not-a-uuid', name: 'x' } }).kind).toBe('unreadable');
  });

  it('the client copies of the field names equal the server ones', () => {
    expect(TYPED_RECIPIENT_VALUE).toBe(TYPED_RECIPIENT);
    expect(RECIPIENT_CHOICE_NAME).toBe(RECIPIENT_CHOICE_FIELD);
  });

  it('loadMakerRecipients: a refusal (403 for viewer/auditor) is the typed address only, with the reason', async () => {
    callApi.mockResolvedValue(refuse(403, 'FORBIDDEN'));
    const choices = await masterModule.loadMakerRecipients(PROJECT_ID);
    expect(callApi.mock.calls[0]![0]).toBe(`/api/projects/${PROJECT_ID}/maker-recipient-addresses`);
    expect(choices).toEqual({ kind: 'unreadable', error: webErrorText('FORBIDDEN').message });
  });
});

describe('recipientChoiceOf (the posted choice)', () => {
  it('an address id is the id; 直接入力 or no radio is the typed address', () => {
    expect(recipientChoiceOf(form({ recipientChoice: ADDRESS_DEFAULT, recipientAddress: 'x@y.example' }))).toEqual({ kind: 'id', recipientAddressId: ADDRESS_DEFAULT });
    expect(recipientChoiceOf(form({ recipientChoice: '__typed', recipientAddress: ' a@b.example ' }))).toEqual({ kind: 'typed', recipientAddress: 'a@b.example' });
    expect(recipientChoiceOf(form({ recipientAddress: 'a@b.example' }))).toEqual({ kind: 'typed', recipientAddress: 'a@b.example' });
    expect(recipientChoiceOf(form({ recipientChoice: '../../api/x' }))).toEqual({ kind: 'bad_id' });
  });
});

describe('RecipientChooser (DESIGN §4, no JS needed)', () => {
  const render = (props: Parameters<typeof RecipientChooser>[0]) => renderToStaticMarkup(<RecipientChooser {...props} />);

  it('list: one radio per address (default first and preselected) + 直接入力する + an always-present input', () => {
    const html = render({ choices: recipientChoicesFrom({ maker: MAKER }) });
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios).toHaveLength(3);
    expect(radios[0]).toContain(`value="${ADDRESS_DEFAULT}"`);
    expect(checkedChoice(html)).toBe(ADDRESS_DEFAULT);
    expect(radios.slice(1).some((radio) => radio.includes('checked'))).toBe(false);
    expect(radios[2]).toContain('value="__typed"');
    expect(html).toContain('<legend class="p1-legend">送信先（メーカーへ送るメールの宛先）</legend>');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('<b>営業部</b>');
    expect(html).toContain('<span translate="no" class="p2-recipient-email">sales@maker.example</span>');
    expect(html).toContain('既定');
    const input = /<input[^>]*name="recipientAddress"[^>]*>/.exec(html)![0];
    expect(input).toContain('type="email"');
    // The typed input is not required while a master address is chosen (the server checks it for 直接入力).
    expect(input).not.toContain('required');
    expect(html).toContain('「直接入力する」を選んだときだけ使います。');
  });

  it('a previous typed address is a hint only, never filled in', () => {
    const html = render({ choices: recipientChoicesFrom({ maker: MAKER }), previousTyped: 'prev@else.example' });
    expect(html).toContain('前回の直接入力: prev@else.example');
    expect(html).not.toContain('value="prev@else.example"');
  });

  it('no maker: the typed input only (required), with the one-line reason', () => {
    const html = render({ choices: { kind: 'no_maker' } });
    expect(html).toContain('この案件にはメーカーが設定されていません。宛先は直接入力してください。');
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('name="recipientChoice" value="__typed"');
    expect(/<input[^>]*name="recipientAddress"[^>]*>/.exec(html)![0]).toContain('required');
  });

  it('a maker without addresses: the reason, and the /makers link for the representative only', () => {
    const staff = render({ choices: { kind: 'no_addresses', makerName: '合成フィルム工業' } });
    expect(staff).toContain('メーカー「合成フィルム工業」に使える宛先が登録されていません。');
    expect(staff).not.toContain('href="/makers"');
    expect(render({ choices: { kind: 'no_addresses', makerName: 'M' }, showMakersLink: true })).toContain('<a href="/makers">メーカーの宛先を開く</a>');
  });

  it('an unreadable list: an alert banner and the typed input only', () => {
    const html = render({ choices: { kind: 'unreadable', error: '応答がありません' } });
    expect(html).toContain('role="alert"');
    expect(html).toContain('宛先の一覧を読み込めませんでした（応答がありません）。直接入力すれば作成できます。');
    expect(html).not.toContain('type="radio"');
  });

  it('not loaded: the typed input only, no reason line', () => {
    const html = render({ choices: { kind: 'not_loaded' } });
    expect(html).not.toContain('p1-note');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('name="recipientAddress"');
  });
});

describe('createMakerPoAction (/maker-po form): id or typed, never both', () => {
  const base = { orderId: 'ord-1' };
  const body = () => (callApi.mock.calls[0]![1] as { body: Record<string, unknown> }).body;

  it('a master address sends recipientAddressId only (the typed value is ignored)', async () => {
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientChoice: ADDRESS_DEFAULT, recipientAddress: 'typed@else.example', totalAmount: '480000' }));
    expect(result.ok).toBe(true);
    expect(callApi.mock.calls[0]![0]).toBe('/api/film-supply-orders/ord-1/maker-purchase-orders');
    expect(body()).toEqual({ recipientAddressId: ADDRESS_DEFAULT, amounts: { currency: 'JPY', totalAmount: '480000' } });
    expect(callApi.mock.calls[0]![1]).toMatchObject({ method: 'POST', idempotencyKey: KEY, expectedProjectId: RENDERED });
  });

  it('直接入力 sends recipientAddress only', async () => {
    await makerActions.createMakerPoAction(null, form({ ...base, recipientChoice: '__typed', recipientAddress: ' order@maker.example ' }));
    expect(body()).toEqual({ recipientAddress: 'order@maker.example' });
    expect(body()).not.toHaveProperty('recipientAddressId');
  });

  it('a typed address that is not an e-mail is refused before the API (P0 R10 message)', async () => {
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientChoice: '__typed', recipientAddress: '東京都港区1-2-3' }));
    expect(result).toEqual({ ok: false, message: RECIPIENT_EMAIL_INVALID_MESSAGE });
    const empty = await makerActions.createMakerPoAction(null, form({ ...base, recipientChoice: '__typed', recipientAddress: '' }));
    expect(empty.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('an id that is not UUID-shaped is refused before the API', async () => {
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientChoice: 'abc/../x' }));
    expect(result).toEqual({ ok: false, message: RECIPIENT_CHOICE_INVALID_MESSAGE });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('a form without its rendered project writes nothing (P0 R03 guard unchanged)', async () => {
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientChoice: ADDRESS_DEFAULT }, { project: null }));
    expect(result.code).toBe('PROJECT_CONTEXT_MISMATCH');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('422 MAKER_RECIPIENT_ADDRESS_UNAVAILABLE: the screen wording (メーカー, P1 R28), the code, and the list is read again', async () => {
    callApi.mockResolvedValue(refuse(422, 'MAKER_RECIPIENT_ADDRESS_UNAVAILABLE'));
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientChoice: ADDRESS_DEFAULT }));
    expect(result).toMatchObject({
      ok: false,
      code: 'MAKER_RECIPIENT_ADDRESS_UNAVAILABLE',
      message: '選んだ送信先は使用できません。この案件のメーカーの宛先から選び直してください。',
      messageKo: webErrorText('MAKER_RECIPIENT_ADDRESS_UNAVAILABLE').messageKo,
      settled: true
    });
    expect(revalidatePath).toHaveBeenCalled();
  });
});

describe('createMakerPoStepAction (step 7 form): id or typed, never both', () => {
  const step = (entries: Record<string, string>) => form({ orderId: 'ord-1', needsReadyTransition: 'false', ...entries });
  const paperBody = () => (callApi.mock.calls.at(-1)![1] as { body: Record<string, unknown> }).body;

  it('a master address: recipientAddressId only', async () => {
    const result = await stepActions.createMakerPoStepAction(null, step({ recipientChoice: ADDRESS_OTHER, recipientAddress: 'typed@else.example' }));
    expect(result.ok).toBe(true);
    expect(calls().map((call) => call.path)).toEqual(['/api/film-supply-orders/ord-1/maker-purchase-orders']);
    expect(paperBody()).toEqual({ recipientAddressId: ADDRESS_OTHER });
  });

  it('直接入力 (or the typed-only form): recipientAddress only, with the amount', async () => {
    await stepActions.createMakerPoStepAction(null, step({ recipientChoice: '__typed', recipientAddress: 'order@maker.example', totalAmount: '1000' }));
    expect(paperBody()).toEqual({ recipientAddress: 'order@maker.example', amounts: { currency: 'JPY', totalAmount: '1000' } });
  });

  it('refuses a bad typed address and a non-UUID id without any API call', async () => {
    expect(await stepActions.createMakerPoStepAction(null, step({ recipientChoice: '__typed', recipientAddress: 'nope' }))).toEqual({ ok: false, message: RECIPIENT_EMAIL_INVALID_MESSAGE });
    expect(await stepActions.createMakerPoStepAction(null, step({ recipientChoice: '1234' }))).toEqual({ ok: false, message: RECIPIENT_CHOICE_INVALID_MESSAGE });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('MAKER_RECIPIENT_ADDRESS_UNAVAILABLE: the dictionary text and a refresh', async () => {
    callApi.mockResolvedValue(refuse(422, 'MAKER_RECIPIENT_ADDRESS_UNAVAILABLE'));
    const result = await stepActions.createMakerPoStepAction(null, step({ recipientChoice: ADDRESS_OTHER }));
    expect(result).toMatchObject({ ok: false, code: 'MAKER_RECIPIENT_ADDRESS_UNAVAILABLE', message: webErrorText('MAKER_RECIPIENT_ADDRESS_UNAVAILABLE').message });
    expect(revalidatePath).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B. /makers (admin only)
// ---------------------------------------------------------------------------

describe('maker master actions (no project, the API decides; Idempotency-Key forwarded)', () => {
  it('メーカーを追加: POST /api/maker-accounts {name, externalCode?} without a project header', async () => {
    const result = await makersActions.createMakerAccountAction(null, form({ name: ' 合成フィルム工業 ', externalCode: 'KF-01' }, { project: '' }));
    expect(result.ok).toBe(true);
    expect(calls()).toEqual([{ path: '/api/maker-accounts', method: 'POST', body: { name: '合成フィルム工業', externalCode: 'KF-01' }, idempotencyKey: KEY }]);
    await makersActions.createMakerAccountAction(null, form({ name: 'B' }));
    expect(calls()[1]!.body).toEqual({ name: 'B' });
    expect(revalidatePath).toHaveBeenCalledWith('/makers');
  });

  it('refuses an empty or too long name and a too long code before the API', async () => {
    expect((await makersActions.createMakerAccountAction(null, form({ name: '' }))).ok).toBe(false);
    expect((await makersActions.createMakerAccountAction(null, form({ name: 'x'.repeat(201) }))).ok).toBe(false);
    expect((await makersActions.createMakerAccountAction(null, form({ name: 'x', externalCode: 'c'.repeat(65) }))).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('宛先を追加: POST …/recipient-addresses {email, label?, isDefault}', async () => {
    await makersActions.addRecipientAddressAction(null, form({ accountId: MAKER_ID, email: 'sales@maker.example', label: '営業部', isDefault: 'on' }));
    await makersActions.addRecipientAddressAction(null, form({ accountId: MAKER_ID, email: 'order@maker.example' }));
    expect(calls()).toEqual([
      { path: `/api/maker-accounts/${MAKER_ID}/recipient-addresses`, method: 'POST', body: { email: 'sales@maker.example', label: '営業部', isDefault: true }, idempotencyKey: KEY },
      { path: `/api/maker-accounts/${MAKER_ID}/recipient-addresses`, method: 'POST', body: { email: 'order@maker.example', isDefault: false }, idempotencyKey: KEY }
    ]);
  });

  it('refuses a bad e-mail, a long label and a non-UUID maker id before the API', async () => {
    expect(await makersActions.addRecipientAddressAction(null, form({ accountId: MAKER_ID, email: '東京都' }))).toEqual({ ok: false, message: RECIPIENT_EMAIL_INVALID_MESSAGE });
    expect((await makersActions.addRecipientAddressAction(null, form({ accountId: MAKER_ID, email: 'a@b.example', label: 'l'.repeat(101) }))).ok).toBe(false);
    expect((await makersActions.addRecipientAddressAction(null, form({ accountId: '../maker-accounts', email: 'a@b.example' }))).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('既定にする / 使用を止める / 使用を再開: PATCH /api/maker-recipient-addresses/:id', async () => {
    for (const change of ['default', 'deactivate', 'reactivate']) {
      await makersActions.updateRecipientAddressAction(null, form({ addressId: ADDRESS_OTHER, change }));
    }
    expect(calls()).toEqual([
      { path: `/api/maker-recipient-addresses/${ADDRESS_OTHER}`, method: 'PATCH', body: { isDefault: true }, idempotencyKey: KEY },
      { path: `/api/maker-recipient-addresses/${ADDRESS_OTHER}`, method: 'PATCH', body: { isActive: false }, idempotencyKey: KEY },
      { path: `/api/maker-recipient-addresses/${ADDRESS_OTHER}`, method: 'PATCH', body: { isActive: true }, idempotencyKey: KEY }
    ]);
    expect((await makersActions.updateRecipientAddressAction(null, form({ addressId: ADDRESS_OTHER, change: 'delete' }))).ok).toBe(false);
    expect((await makersActions.updateRecipientAddressAction(null, form({ addressId: 'x', change: 'default' }))).ok).toBe(false);
    expect(callApi).toHaveBeenCalledTimes(3);
  });

  it.each(['DUPLICATE', 'MAKER_ACCOUNT_INVALID', 'MAKER_RECIPIENT_ADDRESS_INVALID', 'RECIPIENT_ADDRESS_INVALID', 'MAKER_ACCOUNT_NOT_FOUND', 'MAKER_RECIPIENT_ADDRESS_NOT_FOUND', 'CEO_ONLY'])(
    'a %s refusal shows the dictionary text and its code', async (code) => {
      callApi.mockResolvedValue(refuse(code === 'CEO_ONLY' ? 403 : code.endsWith('NOT_FOUND') ? 404 : code === 'DUPLICATE' ? 409 : 422, code));
      const result = await makersActions.addRecipientAddressAction(null, form({ accountId: MAKER_ID, email: 'a@b.example' }));
      expect(result).toMatchObject({ ok: false, code, message: webErrorText(code).message, settled: true });
    }
  );
});

describe('/makers page', () => {
  const page = async () => renderToStaticMarkup((await MakersPage())!);

  it.each(['staff', 'viewer', 'auditor'])('%s: the notice only — the list is never asked for', async (role) => {
    session.role = role;
    const html = await page();
    expect(html).toContain(MAKERS_ONLY_NOTICE);
    expect(html).not.toContain('<form');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('admin with a 403 CEO_ONLY answer: the same notice, no data', async () => {
    callApi.mockResolvedValue(refuse(403, 'CEO_ONLY'));
    const html = await page();
    expect(html).toContain(MAKERS_ONLY_NOTICE);
    expect(html).not.toContain('<form');
  });

  it('admin: each maker with its addresses, tags and the right buttons; the add forms', async () => {
    callApi.mockResolvedValue(ok({
      makers: [{ ...MAKER, recipientAddresses: [...MAKER.recipientAddresses, address(ADDRESS_OFF, 'old@maker.example', { label: '旧窓口', isActive: false })] }]
    }, 200));
    const html = await page();
    expect(callApi.mock.calls[0]![0]).toBe('/api/maker-accounts');
    expect(html).toContain('<h1 id="makers-title" class="p1-title">メーカーの宛先');
    expect(html).toContain('合成フィルム工業');
    expect(html).toContain('取引先コード <span translate="no">KF-01</span>');
    expect(html).toContain('sales@maker.example');
    const rows = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[0]);
    expect(rows).toHaveLength(3);
    const [other, defaultRow, off] = rows;
    expect(other).toContain('既定にする');
    expect(other).toContain('使用を止める');
    expect(defaultRow).toContain('既定');
    expect(defaultRow).not.toContain('既定にする');
    expect(defaultRow).toContain('使用を止める');
    expect(off).toContain('class="is-inactive"');
    expect(off).toContain('使用停止');
    expect(off).toContain('使用を再開');
    expect(off).not.toContain('使用を止める');
    expect(html).toContain('宛先を追加する');
    expect(html).toContain('メーカーを追加する');
    expect(html).toContain(`name="accountId" value="${MAKER_ID}"`);
    expect(html).not.toContain('削除する');
  });

  it('admin: no makers and an unreadable list say so in words', async () => {
    callApi.mockResolvedValue(ok({ makers: [] }, 200));
    expect(await page()).toContain('メーカーがまだありません。');
    callApi.mockResolvedValue({ ok: false, status: 500, data: null, error: 'サーバーエラー', code: 'INTERNAL', failure: null });
    const html = await page();
    expect(html).toContain('メーカーの一覧を読み込めませんでした（サーバーエラー）。');
    expect(html).toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// C / D. the step panel: MPO numbers, the chooser, 4 デザイン入稿
// ---------------------------------------------------------------------------

const PO = { id: 'po-1', poNumber: 'N', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };
function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'ord-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '300.000', unit: 'meters' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: null, paymentTerms: 'prepaid', createdAt: '', updatedAt: '', ...extra
  };
}
function panel(status: string, role: string, extra: { order?: Record<string, unknown>; maker?: unknown; recipients?: unknown; flow?: unknown } = {}) {
  const o = order(status, extra.order ?? {});
  const flow = extra.flow ?? buildOrderFlow({
    order: o as never, role, po: PO as never, documents: [], revisions: [], gate: null,
    makerPos: [] as never, makerEvents: [] as never, settledSendEventIds: new Set(), paymentGate: null, deliveries: []
  });
  return renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: RENDERED, showKorean: false }}>
      <StepPanelView
        flow={flow as never} order={o as never} projectCode="PRJ-1" role={role} po={PO as never} gate={null}
        maker={(extra.maker ?? null) as never} makerEvents={[]} documents={[]} stateLabel={(key) => key}
        recipients={extra.recipients as never}
      />
    </RenderedContextProvider>
  );
}
const sendFlow = { panel: { action: { kind: 'send', poId: 'mpo-1' }, canAct: true, actor: null, blocked: null } };

describe('StepPanel', () => {
  it('maker_po_create: the chooser when the list is given, the typed input otherwise', () => {
    const listed = panel('DUAL_APPROVED', 'admin', { recipients: recipientChoicesFrom({ maker: MAKER }) });
    expect(checkedChoice(listed)).toBe(ADDRESS_DEFAULT);
    expect(listed).toContain('name="totalAmount"');
    const staff = panel('DUAL_APPROVED', 'staff', { recipients: { kind: 'no_addresses', makerName: 'M' } });
    expect(staff).not.toContain('name="totalAmount"');
    expect(staff).not.toContain('href="/makers"');
    expect(panel('DUAL_APPROVED', 'admin')).toContain('name="recipientAddress"');
  });

  it('R32: the send step names the paper by its MPO number', () => {
    const html = panel('MAKER_PO_READY', 'staff', { flow: sendFlow, maker: { id: 'mpo-1', status: 'APPROVED_FOR_MANUAL_SEND', displayNumber: 'MPO-2026-0012' } });
    expect(html).toContain('メーカー発注書 <span translate="no" class="p1-figure p2-mpo-number">MPO-2026-0012</span>');
  });

  it('R32: without a number (an older answer) it falls back to the order-code name', () => {
    const html = panel('MAKER_PO_READY', 'staff', { flow: sendFlow, maker: { id: 'mpo-1', status: 'APPROVED_FOR_MANUAL_SEND', displayNumber: 'not-a-number' } });
    expect(html).toContain('FSO-1 のメーカー発注書');
    expect(html).not.toContain('not-a-number');
  });

  it('4 デザイン入稿: the file form with design name, memo and the 「ファイルがなく、受領だけを記録する」 way', () => {
    const html = panel('SEVEN_PO_VERIFIED', 'staff');
    expect(html).toContain('デザイン入稿データを登録して、受領済みにする');
    expect(html).toContain('デザイン入稿データ');
    expect(html).toContain('name="designKey"');
    expect(html).toContain('name="evidenceNote"');
    expect(html).toContain('name="noFile"');
    expect(html).toContain('ファイルがなく、受領だけを記録する');
    expect(html).toContain('name="orderId" value="ord-1"');
    expect(html).toContain(`name="${RENDERED_PROJECT_FIELD}" value="${RENDERED}"`);
  });

  it('4 デザイン入稿: an order without its セブン化学発注書 keeps the memo form; a viewer and an auditor see no form', () => {
    const memo = panel('SEVEN_PO_VERIFIED', 'staff', { order: { sevenPurchaseOrderId: null } });
    expect(memo).toContain('name="to" value="ARTWORK_RECEIVED"');
    expect(memo).not.toContain('name="noFile"');
    for (const role of ['viewer', 'auditor']) expect(panel('SEVEN_PO_VERIFIED', role)).not.toContain('<form');
  });
});

describe('submitArtworkStepAction (one submit: artwork_submission → デザイン受領)', () => {
  const file = { contentBase64: 'JVBERi0xLjQK', filename: 'design.pdf', contentType: 'application/pdf' };
  const step = (entries: Record<string, string>) => form({ orderId: 'ord-1', orderCode: 'FSO-1', projectCode: 'PRJ-1', ...entries });

  it('uploads the file bound to the order (no セブン化学発注書 id), then moves the order, keys .1 and .2', async () => {
    callApi.mockImplementation(async (path: string) => path.endsWith('/documents') ? ok({ document: { id: 'doc-1' }, version: { id: 'ver-1' } }) : ok({ id: 'ord-1' }));
    const result = await stepActions.submitArtworkStepAction(null, step({ ...file, designKey: '表面A', evidenceNote: '11/20 メールで受領' }));
    expect(result.ok).toBe(true);
    expect(calls()).toEqual([
      {
        path: `/api/projects/${RENDERED}/documents`, method: 'POST', idempotencyKey: `${KEY}.1`, expectedProjectId: RENDERED,
        body: { documentType: 'artwork_submission', issuerEntity: 'customer_generated', filmSupplyOrderId: 'ord-1', designKey: '表面A', ...file }
      },
      {
        path: '/api/film-supply-orders/ord-1/transitions', method: 'POST', idempotencyKey: `${KEY}.2`, expectedProjectId: RENDERED,
        body: { to: 'ARTWORK_RECEIVED', evidenceNote: '11/20 メールで受領' }
      }
    ]);
    expect(calls()[0]!.body).not.toHaveProperty('sevenPurchaseOrderId');
  });

  it('without a design name the upload carries none; without a memo the move carries none', async () => {
    await stepActions.submitArtworkStepAction(null, step(file));
    expect(calls()[0]!.body).not.toHaveProperty('designKey');
    expect(calls()[1]!.body).toEqual({ to: 'ARTWORK_RECEIVED' });
  });

  it('the memo-only way (ファイルがなく、受領だけを記録する) still moves the order with the memo', async () => {
    const result = await stepActions.submitArtworkStepAction(null, step({ noFile: 'on', evidenceNote: '紙で受領（ファイルなし）' }));
    expect(result.ok).toBe(true);
    expect(calls()).toEqual([{
      path: '/api/film-supply-orders/ord-1/transitions', method: 'POST', idempotencyKey: `${KEY}.2`, expectedProjectId: RENDERED,
      body: { to: 'ARTWORK_RECEIVED', evidenceNote: '紙で受領（ファイルなし）' }
    }]);
  });

  it('asks for the file, or for the memo when there is no file — nothing is sent', async () => {
    expect(await stepActions.submitArtworkStepAction(null, step({ evidenceNote: 'メモだけ' }))).toEqual({ ok: false, message: 'ファイルを選択してください。' });
    expect((await stepActions.submitArtworkStepAction(null, step({ noFile: 'on' }))).ok).toBe(false);
    expect((await stepActions.submitArtworkStepAction(null, step({ ...file, contentType: 'application/zip' }))).ok).toBe(false);
    expect((await stepActions.submitArtworkStepAction(null, step(file))).ok).toBe(true);
    callApi.mockReset();
    expect((await stepActions.submitArtworkStepAction(null, form({ ...file, orderId: 'ord-1' }, { project: null }))).code).toBe('PROJECT_CONTEXT_MISMATCH');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('422 ARTWORK_SUBMISSION_ORDER_REQUIRED: the dictionary text, and the order is not moved', async () => {
    callApi.mockResolvedValue(refuse(422, 'ARTWORK_SUBMISSION_ORDER_REQUIRED'));
    const result = await stepActions.submitArtworkStepAction(null, step(file));
    expect(result).toMatchObject({ ok: false, code: 'ARTWORK_SUBMISSION_ORDER_REQUIRED', message: webErrorText('ARTWORK_SUBMISSION_ORDER_REQUIRED').message });
    expect(callApi).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A / C on /maker-po: the create form's chooser, MPO numbers, auditor/viewer
// ---------------------------------------------------------------------------

const PO_ID = '01a1ec60-0000-7000-8000-0000000a0a01';
const ORDER_READY = '01a1ec60-0000-7000-8000-0000000a0b01';
const ORDER_SEND = '01a1ec60-0000-7000-8000-0000000a0b02';
const MAKER_PO_SEND = '01a1ec60-0000-7000-8000-0000000a0c01';
let sequence = 0;
function auditRow(entityType: string, action: string, entityId: string, afterState: Record<string, unknown>, beforeState: Record<string, unknown> | null = null): AuditHistoryRow {
  sequence += 1;
  return {
    id: `01a1ec61-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    action, entityType, entityId, beforeState, afterState,
    occurredAt: new Date(Date.UTC(2026, 10, 21, 3, 0, sequence)),
    requestMetadata: { operation: action.toLowerCase() },
    actor: { id: USER_ID, displayName: '合成代表者', role: 'admin' }
  };
}
function filmOrder(id: string, code: string, path: string[]): AuditHistoryRow[] {
  const rows = [auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', id, {
    id, code, status: 'DRAFT', lineCount: 1, projectId: PROJECT_ID, paymentTerms: 'prepaid', sevenPurchaseOrderId: PO_ID, createdByUserId: USER_ID
  })];
  let from = 'DRAFT';
  for (const to of path) {
    rows.push(auditRow('film_supply_order', 'FILM_SUPPLY_ORDER_TRANSITIONED', id, { status: to }, { status: from }));
    from = to;
  }
  return rows;
}
const TO_READY = ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY'];
const ROWS: AuditHistoryRow[] = [
  auditRow('seven_purchase_order', 'SEVEN_PO_CREATED', PO_ID, { id: PO_ID, projectId: PROJECT_ID, poNumber: 'SC-X2-1', officialRegisteredAt: '2026-11-16T00:00:00.000Z', verificationStatus: 'unverified' }),
  auditRow('seven_purchase_order', 'SEVEN_PO_VERIFICATION_RECORDED', PO_ID, { id: PO_ID, verificationStatus: 'verified', reviewPending: false }),
  ...filmOrder(ORDER_READY, 'FSO-READY', TO_READY),
  ...filmOrder(ORDER_SEND, 'FSO-SEND', [...TO_READY, 'APPROVED_FOR_MANUAL_SEND']),
  auditRow('maker_purchase_order', 'MAKER_PO_CREATED', MAKER_PO_SEND, { id: MAKER_PO_SEND, filmSupplyOrderId: ORDER_SEND, status: 'DRAFT' })
];
const MAKER_PO_ROW = {
  id: MAKER_PO_SEND, filmSupplyOrderId: ORDER_SEND, status: 'APPROVED_FOR_MANUAL_SEND', orderCode: 'FSO-SEND',
  recipientAddress: 'sales@maker.example', ceoApprovedAt: '2026-11-21T01:00:00.000Z',
  createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T01:00:00.000Z',
  snapshot: { amounts: { currency: 'JPY', totalAmount: '480000' }, recipient: { address: 'sales@maker.example' } }
};

function serveBoard(role: string, { numbered = true, recipients = { projectId: PROJECT_ID, maker: MAKER } as unknown } = {}) {
  session.role = role;
  callApi.mockImplementation(async (apiPath: string) => {
    const answer = (data: unknown) => ({ ok: true, status: 200, error: null, data });
    if (apiPath === `/api/projects/${PROJECT_ID}`) return answer({ id: PROJECT_ID, code: 'CMP-X2', name: '合成X2', route: 'F1', status: 'ACTIVE' });
    if (apiPath === '/api/status-labels') return answer(japaneseStatusSurface());
    if (apiPath.includes('/audit-history')) {
      const entityType = new URL(apiPath, 'http://x').searchParams.get('entityType');
      const viewRole = role === 'auditor' ? 'auditor' : role;
      return answer({ events: JSON.parse(JSON.stringify(buildAuditViewForRole(viewRole as never, ROWS.filter((row) => row.entityType === entityType)))) });
    }
    if (apiPath === `/api/projects/${PROJECT_ID}/maker-recipient-addresses`) {
      return role === 'admin' || role === 'staff' ? answer(recipients) : refuse(403, 'FORBIDDEN');
    }
    if (apiPath.endsWith('/payment-gate')) return answer({ orderId: 'x', orderStatus: 'x', paymentTerms: 'prepaid', gate: { satisfied: true, code: null, reason: null }, paymentConfirmedAt: null });
    const row = role === 'admin' ? MAKER_PO_ROW : { ...MAKER_PO_ROW, snapshot: undefined };
    if (apiPath === `/api/film-supply-orders/${ORDER_SEND}/maker-purchase-orders`) {
      return answer({ makerPurchaseOrders: [row], ...(numbered ? { displayNumbers: { [MAKER_PO_SEND]: 'MPO-2026-0007' } } : {}) });
    }
    if (apiPath.endsWith('/maker-purchase-orders')) return answer({ makerPurchaseOrders: [] });
    if (apiPath === `/api/maker-purchase-orders/${MAKER_PO_SEND}`) return answer({ purchaseOrder: row, events: [] });
    return { ok: false, status: 404, error: 'not served in this test', data: null };
  });
}

async function renderBoard(): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await MakerPoPage()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}
const recipientReads = () => callApi.mock.calls.filter((call) => String(call[0]).endsWith('/maker-recipient-addresses')).length;

describe('/maker-po: the create form, MPO numbers, roles', () => {
  it('admin: the chooser with the default preselected, the amount fields, and the paper by its number', async () => {
    serveBoard('admin');
    const html = await renderBoard();
    expect(recipientReads()).toBe(1);
    expect(checkedChoice(html)).toBe(ADDRESS_DEFAULT);
    expect(html).toContain('value="__typed"');
    expect(html).toContain('name="totalAmount"');
    expect(html).toContain('<strong translate="no" class="p1-figure p2-mpo-number">MPO-2026-0007</strong>');
    expect(html).toContain('メーカー発注書 <span translate="no" class="p1-figure p2-mpo-number">MPO-2026-0007</span>');
    // P2 R33: the last paper's address is no longer filled in for the operator.
    expect(/<input[^>]*name="recipientAddress"[^>]*>/.exec(html)![0]).not.toContain('value=');
  });

  it('a previous typed address outside the master is a hint only', async () => {
    serveBoard('admin', { recipients: { projectId: PROJECT_ID, maker: { ...MAKER, recipientAddresses: [address(ADDRESS_OTHER, 'order@maker.example')] } } });
    const html = await renderBoard();
    expect(html).toContain('前回の直接入力: sales@maker.example');
  });

  it('without numbers (an older answer) the card falls back to the order-code name', async () => {
    serveBoard('admin', { numbered: false });
    const html = await renderBoard();
    expect(html).not.toContain('MPO-');
    expect(html).toContain('FSO-SEND のメーカー発注書');
  });

  it('staff: the chooser without any amount field', async () => {
    serveBoard('staff');
    const html = await renderBoard();
    expect(checkedChoice(html)).toBe(ADDRESS_DEFAULT);
    expect(html).not.toContain('name="totalAmount"');
    expect(html).not.toContain('480,000');
    expect(html).toContain('MPO-2026-0007');
  });

  it.each(['viewer', 'auditor'])('%s: no write form, no amount, the recipient list never asked for, quiet notices', async (role) => {
    serveBoard(role);
    const html = await renderBoard();
    expect(recipientReads()).toBe(0);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('name="recipientChoice"');
    expect(html).not.toContain('totalAmount');
    expect(html).not.toContain('480,000');
    // No amount label, column or explanation of this screen (the shared page notice is lib/permissions').
    expect(html).not.toContain('>金額<');
    expect(html).not.toContain('金額は代表者');
    expect(html).not.toContain('明細・金額');
    expect(html).not.toContain('金額やスナップショット');
    expect(html).toContain('role-notice');
  });
});
