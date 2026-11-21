import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasApprovalHistoryForDesign, type ApprovalEventView, type ArtworkRevisionView } from '@kanei/core';

/**
 * UI batch F (demo-eml/ui-batch-f/REPORT.md): the web side of the server R1/R2
 * review fixes (cedde58) — unit level. The real-API checks are in
 * tests/web-ui-batch-f-parity.test.tsx and tests/web-ui-batch-f-login-parity.test.ts.
 *
 * (1) login relay: trusted client address → API X-Forwarded-For, same-origin
 *     guard (review M3), fixed refusals and the lockout wait (H2).
 * (2) the controlled change request of the revision form (R1-9 / F2).
 * (3) web bind (M15) and the document download relay (R1-4).
 * (4) M5: see the parity file (audit rows are counted against the real API).
 */

const captured = vi.hoisted(() => ({
  bodies: [] as Array<{ path: string; body: unknown }>,
  answer: null as null | { ok: boolean; status: number; data: unknown; error: string | null },
  token: 'tok-f' as string | null
}));

vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => captured.token,
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => ({ kind: 'anonymous' }),
  callApi: async (apiPath: string, options: { body?: unknown } = {}) => {
    captured.bodies.push({ path: apiPath, body: options.body });
    return captured.answer ?? { ok: true, status: 201, data: {}, error: null };
  }
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const relay = await import('../apps/web/src/lib/login-relay.js');
const messages = await import('../apps/web/src/lib/login-messages.js');
const { registerArtworkRevisionAction } = await import('../apps/web/src/app/actions.js');
const { fieldForActionMessage } = await import('../apps/web/src/lib/form-messages.js');
const changeRequest = await import('../apps/web/src/lib/change-request.js');
const download = await import('../apps/web/src/lib/document-download.js');

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.KANEI_WEB_BEHIND_TRUSTED_PROXY;
  delete process.env.WEB_ALLOWED_ORIGINS;
});

// ---------------------------------------------------------------------------
// (1) login relay helpers
// ---------------------------------------------------------------------------

describe('trustedClientAddress (H2: only the proxy-written address, only when declared)', () => {
  const on = { KANEI_WEB_BEHIND_TRUSTED_PROXY: '1' };
  const headers = (xff?: string) => new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff });

  it('adds nothing unless the web is declared to sit behind the trusted proxy', () => {
    expect(relay.trustedClientAddress(headers('203.0.113.7'), {})).toBeNull();
    expect(relay.trustedClientAddress(headers('203.0.113.7'), { KANEI_WEB_BEHIND_TRUSTED_PROXY: 'true' })).toBeNull();
    expect(relay.trustedClientAddress(headers('203.0.113.7'), { KANEI_WEB_BEHIND_TRUSTED_PROXY: '0' })).toBeNull();
  });

  it('takes the right-most hop (the one the proxy wrote), never a browser-written left entry', () => {
    expect(relay.trustedClientAddress(headers('203.0.113.7'), on)).toBe('203.0.113.7');
    expect(relay.trustedClientAddress(headers('9.9.9.9, 198.51.100.4'), on)).toBe('198.51.100.4');
    expect(relay.trustedClientAddress(headers('9.9.9.9,198.51.100.4 , '), on)).toBe('198.51.100.4');
  });

  it('forwards only a valid IP literal, canonicalised', () => {
    expect(relay.trustedClientAddress(headers('evil, not-an-ip'), on)).toBeNull();
    expect(relay.trustedClientAddress(headers('203.0.113.7:4444'), on)).toBeNull();
    // (CR/LF never reaches the relay: the Headers class refuses it.)
    expect(relay.trustedClientAddress(headers('1.2.3.4 x-injected: 1'), on)).toBeNull();
    expect(relay.trustedClientAddress(headers('[2001:DB8::1]'), on)).toBe('2001:db8::1');
    expect(relay.trustedClientAddress(headers('fe80::1%eth0'), on)).toBe('fe80::1');
    expect(relay.trustedClientAddress(headers('::ffff:192.0.2.9'), on)).toBe('192.0.2.9');
    expect(relay.trustedClientAddress(headers(), on)).toBeNull();
    expect(relay.trustedClientAddress(headers(''), on)).toBeNull();
  });

  it('the API request carries exactly the one address (or none)', () => {
    expect(relay.loginRelayHeaders('203.0.113.7')).toEqual({ 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' });
    expect(relay.loginRelayHeaders(null)).toEqual({ 'content-type': 'application/json' });
  });
});

describe('isSameOriginPost / isJsonRequest (review M3: login CSRF)', () => {
  const post = (headers: Record<string, string>) => new Request('http://kanei-r1web.localhost:4580/api/auth/login', { method: 'POST', headers });

  it('accepts a post without Origin (server-to-server) and one from this host', () => {
    expect(relay.isSameOriginPost(post({ host: 'kanei-r1web.localhost:4580' }), {})).toBe(true);
    expect(relay.isSameOriginPost(post({ host: 'kanei-r1web.localhost:4580', origin: 'http://kanei-r1web.localhost:4580', 'sec-fetch-site': 'same-origin' }), {})).toBe(true);
    expect(relay.isSameOriginPost(post({ host: 'crm.example.invalid', origin: 'https://crm.example.invalid' }), {})).toBe(true);
  });

  it('refuses another site, a look-alike suffix, an opaque origin and cross-site fetch metadata', () => {
    const host = { host: 'kanei-r1web.localhost:4580' };
    expect(relay.isSameOriginPost(post({ ...host, origin: 'http://evil.example' }), {})).toBe(false);
    expect(relay.isSameOriginPost(post({ ...host, origin: 'http://kanei-r1web.localhost:4580.evil.example' }), {})).toBe(false);
    expect(relay.isSameOriginPost(post({ ...host, origin: 'http://kanei-r1web.localhost:4581' }), {})).toBe(false);
    expect(relay.isSameOriginPost(post({ ...host, origin: 'null' }), {})).toBe(false);
    expect(relay.isSameOriginPost(post({ ...host, origin: 'file://kanei-r1web.localhost:4580' }), {})).toBe(false);
    expect(relay.isSameOriginPost(post({ ...host, 'sec-fetch-site': 'cross-site' }), {})).toBe(false);
    expect(relay.isSameOriginPost(post({ ...host, 'sec-fetch-site': 'same-site' }), {})).toBe(false);
    expect(relay.isSameOriginPost(post({ origin: 'http://kanei-r1web.localhost:4580' }), {})).toBe(false);
  });

  it('WEB_ALLOWED_ORIGINS lists extra exact origins', () => {
    const request = post({ host: 'web:3080', origin: 'https://crm.example.invalid' });
    expect(relay.isSameOriginPost(request, {})).toBe(false);
    expect(relay.isSameOriginPost(request, { WEB_ALLOWED_ORIGINS: 'https://other.invalid, https://crm.example.invalid' })).toBe(true);
  });

  it('the login body must be JSON (a cross-site HTML form cannot send it)', () => {
    expect(relay.isJsonRequest(post({ 'content-type': 'application/json' }))).toBe(true);
    expect(relay.isJsonRequest(post({ 'content-type': 'application/json; charset=utf-8' }))).toBe(true);
    expect(relay.isJsonRequest(post({ 'content-type': 'text/plain' }))).toBe(false);
    expect(relay.isJsonRequest(post({ 'content-type': 'application/x-www-form-urlencoded' }))).toBe(false);
    expect(relay.isJsonRequest(post({ 'content-type': 'application/jsonp' }))).toBe(false);
    expect(relay.isJsonRequest(post({}))).toBe(false);
  });
});

describe('login answers (H2: no account enumeration, lockout wait in Japanese)', () => {
  it('waitText rounds up and reads naturally', () => {
    expect(messages.waitText(0.2)).toBe('1秒');
    expect(messages.waitText(59)).toBe('59秒');
    expect(messages.waitText(60)).toBe('1分');
    expect(messages.waitText(61)).toBe('1分1秒');
    expect(messages.waitText(899)).toBe('14分59秒');
    expect(messages.waitText(3600)).toBe('1時間');
    expect(messages.waitText(3660)).toBe('1時間1分');
  });

  it('every 401 reads the same, whatever the API said about the account', () => {
    const a = messages.loginRefusal(401, { error: '認証情報が正しくありません' });
    const b = messages.loginRefusal(401, { error: 'ユーザーが存在しません' });
    const c = messages.loginRefusal(401, null);
    expect(a).toEqual({ error: 'ユーザー名またはパスワードが正しくありません。' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('a lockout keeps its code and wait (body first, Retry-After second) and names no account', () => {
    const locked = messages.loginRefusal(429, { code: 'LOGIN_TEMPORARILY_LOCKED', retryAfterSeconds: 120, error: 'x' });
    expect(locked).toEqual({
      error: 'ログインの失敗が続いたため、一時的にログインを受け付けていません。約2分後にもう一度お試しください。',
      code: 'LOGIN_TEMPORARILY_LOCKED',
      retryAfterSeconds: 120
    });
    expect(locked.error).not.toMatch(/アカウント|ユーザー/);
    expect(messages.loginRefusal(429, null, '75')).toMatchObject({ retryAfterSeconds: 75, error: expect.stringContaining('約1分15秒後に') });
    expect(messages.loginRefusal(429, {})).toEqual({
      error: 'ログインの失敗が続いたため、一時的にログインを受け付けていません。しばらくしてからもう一度お試しください。',
      code: 'LOGIN_TEMPORARILY_LOCKED'
    });
  });

  it('other statuses get one generic sentence (no upstream text, no API address)', () => {
    expect(messages.loginRefusal(400, { error: 'ユーザー名とパスワードが必要です' })).toEqual({ error: 'ユーザー名とパスワードを入力してください。' });
    expect(messages.loginRefusal(500, { error: 'stack trace' })).toEqual({ error: 'ログインできませんでした。時間をおいてもう一度お試しください。' });
    expect(messages.loginRefusal(403, { code: 'CSRF_ORIGIN_REJECTED' })).toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });
  });
});

describe('POST /api/auth/login relay (route handler)', () => {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  beforeEach(() => {
    sent.length = 0;
  });

  async function login(upstream: () => Response, init: { headers?: Record<string, string>; body?: string } = {}) {
    globalThis.fetch = (async (url: string, request: RequestInit) => {
      sent.push({ url: String(url), headers: { ...(request.headers as Record<string, string>) } });
      return upstream();
    }) as typeof fetch;
    const { POST } = await import('../apps/web/src/app/api/auth/login/route.js');
    return POST(new Request('http://kanei-r1web.localhost:4580/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'kanei-r1web.localhost:4580', ...(init.headers ?? {}) },
      body: init.body ?? JSON.stringify({ username: 'staff_composite', password: 'not-a-real-secret' })
    }));
  }

  it('without the proxy declaration a browser-written X-Forwarded-For never reaches the API', async () => {
    await login(() => new Response('{"error":"x"}', { status: 401 }), { headers: { 'x-forwarded-for': '203.0.113.99' } });
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.headers).map((key) => key.toLowerCase())).not.toContain('x-forwarded-for');
  });

  it('behind the declared proxy the API gets the proxy-written address alone', async () => {
    process.env.KANEI_WEB_BEHIND_TRUSTED_PROXY = '1';
    await login(() => new Response('{"error":"x"}', { status: 401 }), { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } });
    expect(sent[0]!.headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('a cross-site or non-JSON post is refused before the API is asked', async () => {
    const crossSite = await login(() => new Response('{}', { status: 201 }), { headers: { origin: 'http://evil.example' } });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({
      error: '別のサイトからの送信は受け付けられません。この画面からもう一度操作してください。',
      code: 'CSRF_ORIGIN_REJECTED'
    });
    const textPlain = await login(() => new Response('{}', { status: 201 }), { headers: { 'content-type': 'text/plain' } });
    expect(textPlain.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(crossSite.headers.getSetCookie()).toEqual([]);
  });

  it('the lockout answers 429 with the Japanese wait, the code and Retry-After, and sets no cookie', async () => {
    const locked = await login(() => new Response(JSON.stringify({
      error: '試行回数が多いため、しばらくしてから再試行してください', code: 'LOGIN_TEMPORARILY_LOCKED', retryAfterSeconds: 61
    }), { status: 429, headers: { 'set-cookie': 'kanei_mvp_session=should-not-pass; Path=/' } }));
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('61');
    expect(locked.headers.get('cache-control')).toBe('no-store');
    expect(locked.headers.getSetCookie()).toEqual([]);
    expect(await locked.json()).toEqual({
      error: 'ログインの失敗が続いたため、一時的にログインを受け付けていません。約1分1秒後にもう一度お試しください。',
      code: 'LOGIN_TEMPORARILY_LOCKED',
      retryAfterSeconds: 61
    });
  });

  it('a refusal never relays the API wording; an API outage hides the API address', async () => {
    const refused = await login(() => new Response('{"error":"内部の詳細"}', { status: 401 }));
    expect(await refused.json()).toEqual({ error: 'ユーザー名またはパスワードが正しくありません。' });
    const broken = await login(() => new Response('{"error":"boom"}', { status: 503 }));
    expect(broken.status).toBe(502);
    globalThis.fetch = (async () => { throw new TypeError('ECONNREFUSED'); }) as typeof fetch;
    const { POST } = await import('../apps/web/src/app/api/auth/login/route.js');
    const unreachable = await POST(new Request('http://web/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    }));
    expect(unreachable.status).toBe(502);
    expect(JSON.stringify(await unreachable.json())).not.toContain('api.test');
  });
});

describe('POST /api/auth/logout relay: cross-site posts are refused (review M3)', () => {
  it('403 without touching the API or the cookies', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('{}', { status: 200 }); }) as typeof fetch;
    const { POST } = await import('../apps/web/src/app/api/auth/logout/route.js');
    const response = await POST(new Request('http://web/api/auth/logout', {
      method: 'POST', headers: { host: 'web', origin: 'http://evil.example', cookie: 'kanei_mvp_session=abc' }
    }));
    expect(response.status).toBe(403);
    expect(called).toBe(false);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('LoginForm wiring (H2 lockout display)', () => {
  const source = read('apps/web/src/components/LoginForm.tsx');
  it('reads the lockout by status/code, counts down in a non-live timer and never claims a wrong field', () => {
    expect(source).toContain("response.status === 429 || payload?.code === LOGIN_LOCKED_CODE");
    expect(source).toMatch(/role="timer"[\s\S]*再試行できるまで あと\{waitText\(secondsLeft\)\}/);
    expect(source).toContain('setInvalid({ username: false, password: false });');
    // The refusal sentence comes from the relay (one per status); the fallback is the same fixed one.
    expect(source).toContain('setError(payload?.error ?? LOGIN_INVALID_MESSAGE);');
    expect(source).not.toContain('node:net');
  });
  it('the client bundle only imports the client-safe message module', () => {
    expect(source).toContain("from '../lib/login-messages'");
    expect(source).not.toContain("from '../lib/login-relay'");
    expect(read('apps/web/src/lib/login-messages.ts')).not.toMatch(/from 'node:/);
  });
});

// ---------------------------------------------------------------------------
// (2) the controlled change request (registerArtworkRevisionAction)
// ---------------------------------------------------------------------------

const ORDER = '01a1ec53-af67-75da-a932-e03a00000001';
const EVIDENCE = '01a1ec53-af67-75da-a932-e03a00000002';
const PROOF = '01a1ec53-af67-75da-a932-e03a00000003';

function revisionForm(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set('_kaneiRenderedProjectId', 'project-test'); // P1 R20: the form was drawn for the URL's project
  const base = { orderId: ORDER, designKey: 'label-front', fileDocumentVersionId: PROOF };
  for (const [key, value] of Object.entries({ ...base, ...entries })) data.set(key, value);
  return data;
}

const COMPLETE = {
  changeRequest: 'on',
  changeRequestedOrganization: 'customer',
  changeReason: '顧客の依頼で成分表示を修正',
  changeEvidenceDocumentVersionId: EVIDENCE,
  impactSchedule: 'なし',
  impactQuantity: '0',
  impactAmount: '0',
  actualCost: '0',
  lotMarking: 'LOT-2026-11-B'
};

describe('registerArtworkRevisionAction: change request facts (R1-9 / F2)', () => {
  beforeEach(() => {
    captured.bodies.length = 0;
    captured.answer = null;
  });

  it('an initial revision posts no changeRequest (as before)', async () => {
    expect(await registerArtworkRevisionAction(null, revisionForm({ lotMarking: 'L1' }))).toEqual({ ok: true, message: '記録しました。', changedId: null });
    expect(captured.bodies[0]!.body).toEqual({ designKey: 'label-front', fileDocumentVersionId: PROOF, lotMarking: 'L1' });
  });

  it('a complete change request posts every fact, zeros explicit', async () => {
    expect(await registerArtworkRevisionAction(null, revisionForm(COMPLETE))).toMatchObject({ ok: true });
    expect(captured.bodies[0]).toEqual({
      path: `/api/film-supply-orders/${ORDER}/artwork-revisions`,
      body: {
        designKey: 'label-front',
        fileDocumentVersionId: PROOF,
        lotMarking: 'LOT-2026-11-B',
        changeRequest: {
          requestedOrganization: 'customer',
          reason: '顧客の依頼で成分表示を修正',
          evidenceDocumentVersionId: EVIDENCE,
          impactSchedule: 'なし',
          impactQuantity: 0,
          impactAmount: 0,
          actualCost: 0
        }
      }
    });
  });

  it('reads full-width digits and separators; a decrease is a negative amount', async () => {
    await registerArtworkRevisionAction(null, revisionForm({
      ...COMPLETE, impactQuantity: '１，２００.５', impactAmount: '-15,000', actualCost: '３５００.５０'
    }));
    expect((captured.bodies[0]!.body as { changeRequest: Record<string, unknown> }).changeRequest).toMatchObject({
      impactQuantity: 1200.5, impactAmount: -15000, actualCost: 3500.5
    });
  });

  it.each([
    [{ changeRequestedOrganization: '' }, '変更を依頼した組織（顧客／セブン化学）を選んでください。', 'changeRequestedOrganization'],
    [{ changeRequestedOrganization: 'maker' }, '変更を依頼した組織（顧客／セブン化学）を選んでください。', 'changeRequestedOrganization'],
    [{ changeReason: '   ' }, '変更理由を入力してください。', 'changeReason'],
    [{ changeEvidenceDocumentVersionId: '' }, '変更依頼の証憑（承認証跡の書類バージョン）を選択してください。', 'changeEvidenceDocumentVersionId'],
    [{ impactSchedule: '' }, '納期への影響を入力してください（影響がなければ「なし」）。', 'impactSchedule'],
    [{ impactQuantity: '' }, '影響数量を入力してください（影響がなければ0）。', 'impactQuantity'],
    [{ impactQuantity: '-1' }, '影響数量は0以上の数で、小数点以下3桁まで入力してください。', 'impactQuantity'],
    [{ impactQuantity: '1.2345' }, '影響数量は0以上の数で、小数点以下3桁まで入力してください。', 'impactQuantity'],
    [{ impactQuantity: '1e3' }, '影響数量は0以上の数で、小数点以下3桁まで入力してください。', 'impactQuantity'],
    [{ impactQuantity: '0.0000001' }, '影響数量は0以上の数で、小数点以下3桁まで入力してください。', 'impactQuantity'],
    [{ actualCost: '0.0000001' }, '実費は0以上の数で、小数点以下2桁まで入力してください。', 'actualCost'],
    [{ impactQuantity: '100000000000' }, '影響数量が上限（99,999,999,999.999）を超えています。', 'impactQuantity'],
    [{ impactAmount: '' }, '影響金額を入力してください（影響がなければ0、減額はマイナス）。', 'impactAmount'],
    [{ impactAmount: '10.001' }, '影響金額は数で、小数点以下2桁まで入力してください（減額はマイナス）。', 'impactAmount'],
    [{ impactAmount: '-1000000000000' }, '影響金額が上限（±999,999,999,999.99）を超えています。', 'impactAmount'],
    [{ actualCost: '' }, '実費を入力してください（実費がなければ0）。', 'actualCost'],
    [{ actualCost: '-0.01' }, '実費は0以上の数で、小数点以下2桁まで入力してください。', 'actualCost'],
    [{ actualCost: '1000000000000' }, '実費が上限（999,999,999,999.99）を超えています。', 'actualCost'],
    [{ lotMarking: '' }, 'ロット表記を入力してください（変更依頼では新しいロット表示が必須です）。', 'lotMarking']
  ])('refuses %j before sending, naming the field', async (override, message, fieldName) => {
    expect(await registerArtworkRevisionAction(null, revisionForm({ ...COMPLETE, ...override }))).toEqual({ ok: false, message });
    expect(captured.bodies).toHaveLength(0);
    expect(fieldForActionMessage(message)).toBe(fieldName);
  });

  it.each([
    ['CHANGE_REQUEST_ORGANIZATION_REQUIRED', '変更依頼組織は customer または seven です', 'changeRequest'],
    ['CHANGE_REQUEST_REASON_REQUIRED', '変更理由は必須です', 'changeReason'],
    ['CHANGE_REQUEST_EVIDENCE_REQUIRED', '変更依頼の証憑文書が必要です', 'changeEvidenceDocumentVersionId'],
    ['CHANGE_REQUEST_EVIDENCE_PROJECT_MISMATCH', '変更依頼の証憑文書がこの案件に見つかりません', 'changeEvidenceDocumentVersionId'],
    ['CHANGE_REQUEST_EVIDENCE_BINDING_INVALID', '変更依頼証憑はこの発注・デザインの承認証跡である必要があります', 'changeEvidenceDocumentVersionId'],
    ['CHANGE_REQUEST_IMPACT_SCHEDULE_REQUIRED', '納期への影響は必須です（ない場合は「なし」と明記してください）', 'impactSchedule'],
    ['CHANGE_REQUEST_NUMERIC_FIELD_REQUIRED', 'actualCost は数値で必須です（ゼロも明示してください）', 'actualCost'],
    ['CHANGE_REQUEST_NUMERIC_FIELD_INVALID', 'impactQuantity は0以上です', 'impactQuantity'],
    ['CHANGE_REQUEST_DECIMAL_SCALE_INVALID', 'impactAmount の小数点以下は2桁までです', 'impactAmount'],
    ['CHANGE_REQUEST_NUMERIC_FIELD_TOO_LARGE', 'impactQuantity が数値範囲を超えています', 'impactQuantity'],
    ['CHANGE_REQUEST_LOT_MARKING_REQUIRED', 'ロット変更では新しいロット表示が必要です', 'lotMarking']
  ])('the API refusal %s is read back in the form words and marks its field', async (code, error, fieldName) => {
    captured.answer = { ok: false, status: 422, data: { error, code }, error };
    const result = await registerArtworkRevisionAction(null, revisionForm(COMPLETE));
    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/[a-z]{6,}/);
    expect(fieldForActionMessage(result.message)).toBe(fieldName);
  });

  it('the print-start gate (403) says only the representative can record it, and that nothing was written', async () => {
    captured.answer = { ok: false, status: 403, data: { error: '印刷開始後の変更は代表者の承認が必要です', code: 'PRINTED_CHANGE_ADMIN_APPROVAL_REQUIRED' }, error: 'x' };
    expect(await registerArtworkRevisionAction(null, revisionForm(COMPLETE))).toMatchObject({
      ok: false,
      message: '印刷開始後の変更は代表者だけが登録できます。代表者に登録を依頼してください（版も状態も記録されていません）。'
    });
  });

  // server-batch-f4 M-6: the API is the authority on whether the facts were stored.
  it('facts sent but the API saw no approval history (invalidatedApprovals false): says the change facts were not recorded', async () => {
    captured.answer = { ok: true, status: 201, data: { id: 'r2', status: 'APPROVAL_PENDING', invalidatedApprovals: false }, error: null };
    expect(await registerArtworkRevisionAction(null, revisionForm(COMPLETE))).toEqual({
      ok: true,
      changedId: 'r2',
      message: '版を記録しました。このデザインには承認の記録（承認・取消）がないため、変更依頼の項目（依頼組織・理由・証憑・影響・実費）は記録されていません（通常の版として登録されました）。'
    });
    expect(captured.bodies[0]!.body).toHaveProperty('changeRequest');
  });

  it('facts sent and the API invalidated approvals (controlled change): the plain recorded message', async () => {
    captured.answer = { ok: true, status: 201, data: { id: 'r2', status: 'CHANGE_REVIEW', invalidatedApprovals: true }, error: null };
    expect(await registerArtworkRevisionAction(null, revisionForm(COMPLETE))).toEqual({ ok: true, message: '記録しました。', changedId: 'r2' });
  });

  it('no facts sent: an ordinary revision keeps the plain message whatever the API says about history', async () => {
    captured.answer = { ok: true, status: 201, data: { id: 'r1', invalidatedApprovals: false }, error: null };
    expect(await registerArtworkRevisionAction(null, revisionForm({ lotMarking: 'L1' }))).toEqual({ ok: true, message: '記録しました。', changedId: 'r1' });
    captured.answer = { ok: true, status: 201, data: null, error: null };
    expect(await registerArtworkRevisionAction(null, revisionForm(COMPLETE))).toEqual({ ok: true, message: '記録しました。', changedId: null });
  });
});

describe('lib/change-request: what the form knows before the API answers', () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    organization: 'customer', valid: false, latestDecision: null, revoked: false,
    invalidatedByNewerRevision: false, pendingEvidenceIdentifier: false, manualVerification: null, ...overrides
  });
  const design = (designKey: string, customer = state(), seven = state()) => ({
    designKey, currentRevisionId: 'r', currentRevisionNo: 1, fileSha256: 'x', customer, seven, dualApproved: false
  });
  const revision = (id: string, orderId: string, designKey: string, invalidatedApprovals = false) => ({
    id, filmSupplyOrderId: orderId, designKey, revisionNo: 1, revisionNoHidden: false, fileDocumentVersionId: 'v',
    note: null, lotMarking: null, invalidatedApprovals, createdAt: '2026-11-19T00:00:00Z'
  });

  it('approval history comes from the gate, any approval record (decision may be withheld) or an earlier invalidation', () => {
    const keys = changeRequest.approvalHistoryKeys(
      [revision('r1', 'o1', 'A'), revision('r2', 'o1', 'B'), revision('r3', 'o2', 'C', true), revision('r4', 'o2', 'D')],
      [{ id: 'e', artworkRevisionId: 'r2', organization: '—', decision: '—', designKey: '—', revisionNo: null,
        evidenceDocumentVersionId: '—', evidenceSource: '—', eventTime: null, recordedAt: 'x', detailsHidden: true }],
      [
        { orderId: 'o1', orderStatus: 'APPROVAL_PENDING', dualApproved: false, missingApprovals: [], pendingManualVerifications: [],
          designs: [design('A', state({ latestDecision: 'APPROVE', valid: true }))] },
        { orderId: 'o2', orderStatus: 'PROOF_READY', dualApproved: false, missingApprovals: [], pendingManualVerifications: [],
          designs: [design('D')] },
        null
      ] as never
    );
    expect(new Set(keys)).toEqual(new Set([
      changeRequest.changeRequestKey('o1', 'A'),
      changeRequest.changeRequestKey('o1', 'B'),
      changeRequest.changeRequestKey('o2', 'C')
    ]));
    expect(changeRequest.changeRequestKey('o1', ' A ')).toBe(changeRequest.changeRequestKey('o1', 'A'));
  });

  // server-batch-f4 M-6 / API_CONTRACT.md: any recorded APPROVE or REVOKE on any
  // revision of the design within the order — the core rule the API applies.
  const record = (id: string, artworkRevisionId: string, decision: string, detailsHidden = false) => ({
    id, artworkRevisionId, organization: detailsHidden ? '—' : 'customer', decision: detailsHidden ? '—' : decision,
    designKey: '—', revisionNo: null, evidenceDocumentVersionId: '—', evidenceSource: '—', eventTime: null, recordedAt: 'x', detailsHidden
  });

  it('a REVOKE-only history is approval history, as the API counts it', () => {
    const keys = changeRequest.approvalHistoryKeys([revision('r1', 'o1', 'A')], [record('e1', 'r1', 'REVOKE')], []);
    expect(keys).toEqual([changeRequest.changeRequestKey('o1', 'A')]);
  });

  it('agrees with the API rule (core hasApprovalHistoryForDesign) for every order and design of a mixed history', () => {
    const revisions = [
      revision('a1', 'o1', 'A'), revision('a2', 'o1', 'A'),
      revision('b1', 'o1', 'B'),
      revision('c1', 'o1', 'C'),
      revision('a9', 'o2', 'A'),
      revision('d1', 'o2', 'D'), revision('d2', 'o2', 'D')
    ];
    const records = [
      record('e1', 'a1', 'APPROVE'), record('e2', 'a1', 'REVOKE'), // o1/A: approve then revoke on an older revision
      record('e3', 'b1', 'REVOKE'), //                                  o1/B: REVOKE only
      record('e4', 'd1', 'APPROVE', true) //                            o2/D: decision value unreadable ('—'): still a record
      //                                                                o1/C and o2/A: no record (o2/A shares A's key name only)
    ];
    const keys = new Set(changeRequest.approvalHistoryKeys(revisions, records, []));
    const coreRevisions = revisions.map((r) => ({ id: r.id, designKey: r.designKey, revisionNo: r.revisionNo, fileSha256: 'x' }));
    const coreEvents = records.map((e) => ({
      id: e.id, artworkRevisionId: e.artworkRevisionId, organization: 'customer', decision: e.decision === 'REVOKE' ? 'REVOKE' : 'APPROVE',
      approvedFileSha256: 'x', eventTime: new Date('2026-11-19T00:00:00Z'), recordedAt: new Date('2026-11-19T00:00:00Z')
    })) as unknown as ApprovalEventView[];
    const pairs = [['o1', 'A'], ['o1', 'B'], ['o1', 'C'], ['o2', 'A'], ['o2', 'D']] as const;
    const expected = pairs.map(([orderId, designKey]) => hasApprovalHistoryForDesign(
      coreRevisions.filter((r) => revisions.find((x) => x.id === r.id)!.filmSupplyOrderId === orderId) as unknown as ArtworkRevisionView[],
      coreEvents,
      designKey
    ));
    expect(expected).toEqual([true, true, false, false, true]);
    expect(pairs.map(([orderId, designKey]) => keys.has(changeRequest.changeRequestKey(orderId, designKey)))).toEqual(expected);
  });

  it('printing has started from FILM_IN_PRODUCTION on; a hold or cancellation review reads the state it left', () => {
    const order = (id: string, status: string, lastNormalStatus: string | null, statusHidden = false) =>
      ({ id, status, lastNormalStatus, statusHidden }) as never;
    expect(changeRequest.printingStartedOrderIds([
      order('a', 'MAKER_PO_ACCEPTED', 'MAKER_PO_ACCEPTED'),
      order('b', 'FILM_IN_PRODUCTION', 'FILM_IN_PRODUCTION'),
      order('c', 'FILM_DELIVERED', 'FILM_DELIVERED'),
      order('d', 'ON_HOLD', 'FILM_SHIPPED'),
      order('e', 'CANCELLATION_REVIEW', 'APPROVAL_PENDING'),
      order('f', 'CHANGE_REVIEW', 'FILM_IN_PRODUCTION'),
      order('g', 'FILM_SHIPPED', null, true)
    ])).toEqual(['b', 'c', 'd']);
  });

  it('change evidence is approval evidence bound to an order; the design binding travels with it', () => {
    const doc = (id: string, documentType: string, filmSupplyOrderId: string | null, designKey: string | null) => ({
      id, documentType, filmSupplyOrderId, designKey, filename: `${id}.eml`,
      versions: [{ id: `${id}-v1`, versionNumber: 1 }]
    }) as never;
    expect(changeRequest.changeEvidenceChoices([
      doc('a', 'approval_evidence', 'o1', 'A'),
      doc('b', 'approval_evidence', 'o1', null),
      doc('c', 'proof', 'o1', 'A'),
      doc('d', 'approval_evidence', null, null)
    ]).map(({ value, orderId, designKey }) => ({ value, orderId, designKey }))).toEqual([
      { value: 'a-v1', orderId: 'o1', designKey: 'A' },
      { value: 'b-v1', orderId: 'o1', designKey: null }
    ]);
  });

  it('the client form imports only the client-safe key module', () => {
    const source = read('apps/web/src/components/ChangeRequestFields.tsx');
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).toContain("from '../lib/change-request-key'");
    expect(source).not.toMatch(/from '\.\.\/lib\/(change-request|project-data|api)'/);
    expect(read('apps/web/src/lib/change-request-key.ts')).not.toMatch(/^import /m);
  });
});

// ---------------------------------------------------------------------------
// (3) bind (M15) and the download relay (R1-4)
// ---------------------------------------------------------------------------

describe('M15: the web binds 127.0.0.1 unless WEB_HOST says otherwise', () => {
  const pkg = JSON.parse(read('apps/web/package.json')) as { scripts: Record<string, string> };

  it('dev and start name the host explicitly', () => {
    expect(pkg.scripts.dev).toBe('next dev -H "${WEB_HOST:-127.0.0.1}" -p "${WEB_PORT:-3080}"');
    expect(pkg.scripts.start).toBe('next start -H "${WEB_HOST:-127.0.0.1}" -p "${WEB_PORT:-3080}"');
  });

  it('the shell npm uses expands the defaults to 127.0.0.1:3080 and honours WEB_HOST/WEB_PORT', () => {
    const expand = (script: string, env: Record<string, string>) =>
      execFileSync('sh', ['-c', `printf '%s' ${script.replace(/^next (dev|start) /, '')}`], {
        env: { PATH: process.env.PATH ?? '', ...env }
      }).toString();
    expect(expand(pkg.scripts.start!, {})).toBe('-H127.0.0.1-p3080');
    expect(expand(pkg.scripts.dev!, {})).toBe('-H127.0.0.1-p3080');
    expect(expand(pkg.scripts.start!, { WEB_HOST: '0.0.0.0', WEB_PORT: '4580' })).toBe('-H0.0.0.0-p4580');
  });

  it('the container image sets WEB_HOST=0.0.0.0 itself and starts through the script', () => {
    const dockerfile = read('apps/web/Dockerfile');
    expect(dockerfile).toContain('ENV WEB_HOST=0.0.0.0');
    expect(dockerfile).toContain('CMD ["npm", "--workspace", "@kanei/web", "run", "start"]');
    expect(dockerfile).not.toContain('--hostname');
  });
});

describe('document download relay', () => {
  const VERSION = '01a1ec53-af67-75da-a932-e03a00000009';

  async function get(versionId: string, upstream: () => Response) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: string, request: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(request.headers as Record<string, string>) } });
      return upstream();
    }) as typeof fetch;
    const { GET } = await import('../apps/web/src/app/api/document-versions/[versionId]/download/route.js');
    const response = await GET(new Request(`http://web/api/document-versions/${versionId}/download`), {
      params: Promise.resolve({ versionId })
    });
    return { response, calls };
  }

  beforeEach(() => {
    captured.token = 'tok-f';
  });

  it('streams the file as a private attachment with only the session cookie sent up', async () => {
    const { response, calls } = await get(VERSION, () => new Response('PDFBYTES', {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-length': '8',
        'content-disposition': "attachment; filename*=UTF-8''%E7%99%BA%E6%B3%A8.pdf",
        'x-internal': 'drop-me'
      }
    }));
    expect(calls).toEqual([{ url: `http://api.test/api/document-versions/${VERSION}/download`, headers: { cookie: 'kanei_mvp_session=tok-f' } }]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('PDFBYTES');
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''%E7%99%BA%E6%B3%A8.pdf");
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-internal')).toBeNull();
  });

  it('never serves inline', async () => {
    const { response } = await get(VERSION, () => new Response(new TextEncoder().encode('<script>'), { status: 200, headers: { 'content-disposition': 'inline' } }));
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  it.each([
    [401, 'login'], [403, 'forbidden'], [404, 'missing'], [409, 'integrity'], [400, 'invalid'], [500, 'unavailable']
  ])('an API %i goes back to the documents screen (?download=%s)', async (status, reason) => {
    const { response } = await get(VERSION, () => new Response('{"error":"x"}', { status }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/documents?download=${reason}`);
    expect(download.downloadRefusalMessage(reason)).toBe(download.DOWNLOAD_REFUSAL_MESSAGES[reason as keyof typeof download.DOWNLOAD_REFUSAL_MESSAGES]);
  });

  it('a refusal whose body stream never settles a cancel still answers (found live on next dev)', async () => {
    const stuck = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"書類バージョンが見つかりません"}'));
        controller.close();
      },
      cancel: () => new Promise<void>(() => undefined)
    }), { status: 404 });
    const answered = await Promise.race([
      get(VERSION, stuck).then(({ response }) => response.headers.get('location')),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 2000))
    ]);
    expect(answered).toBe('/documents?download=missing');
  });

  it('a cross-site navigation is refused before the API records anything (review L2); redirects are not followed (L3)', async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (url: string, request: RequestInit) => {
      calls.push(request.redirect);
      return new Response(null, { status: 302, headers: { location: 'http://elsewhere.invalid/' } });
    }) as typeof fetch;
    const { GET } = await import('../apps/web/src/app/api/document-versions/[versionId]/download/route.js');
    const crossSite = await GET(new Request(`http://web/api/document-versions/${VERSION}/download`, { headers: { 'sec-fetch-site': 'cross-site' } }), {
      params: Promise.resolve({ versionId: VERSION })
    });
    expect(crossSite.headers.get('location')).toBe('/documents?download=invalid');
    expect(calls).toEqual([]);
    const sameOrigin = await GET(new Request(`http://web/api/document-versions/${VERSION}/download`, { headers: { 'sec-fetch-site': 'same-origin' } }), {
      params: Promise.resolve({ versionId: VERSION })
    });
    expect(calls).toEqual(['manual']);
    expect(sameOrigin.headers.get('location')).toBe('/documents?download=unavailable');
  });

  it('a compressed answer is relayed without a stale content-length', async () => {
    const { response } = await get(VERSION, () => new Response(new TextEncoder().encode('abc'), {
      status: 200, headers: { 'content-length': '999', 'content-encoding': 'gzip', 'content-disposition': 'attachment' }
    }));
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('a malformed id or a missing session never reaches the API', async () => {
    const bad = await get('../../etc/passwd', () => new Response('x'));
    expect(bad.calls).toHaveLength(0);
    expect(bad.response.headers.get('location')).toBe('/documents?download=invalid');
    captured.token = null;
    const anonymous = await get(VERSION, () => new Response('x'));
    expect(anonymous.calls).toHaveLength(0);
    expect(anonymous.response.headers.get('location')).toBe('/documents?download=login');
  });

  it('the notice reads only the reasons the relay writes', () => {
    expect(download.downloadRefusalMessage('forbidden')).toBe('この書類をダウンロードする権限がありません（閲覧者、または担当外の案件です）。');
    expect(download.downloadRefusalMessage('<script>')).toBeNull();
    expect(download.downloadRefusalMessage('toString')).toBeNull();
    expect(download.downloadRefusalMessage(['forbidden'])).toBeNull();
    expect(download.documentDownloadHref(VERSION)).toBe(`/api/document-versions/${VERSION}/download`);
  });

  it('the documents screen links with a plain <a>, never next/link (no prefetch = no unrequested download record)', () => {
    const page = read('apps/web/src/screens/DocumentsScreen.tsx');
    expect(page).toContain('href={documentDownloadHref(version.id)}');
    expect(page).not.toContain("from 'next/link'");
  });
});
