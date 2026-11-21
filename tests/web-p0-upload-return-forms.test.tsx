import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOCUMENT_MAX_BYTES } from '../apps/api/src/document-storage.js';

/**
 * P0 R07 (upload size), R08 (return path, result remedies, Korean line),
 * R01 (the 支払条件 select on the create form).
 */
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  loadSessionUser: async () => session.user
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
  redirect: (target: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { target });
  }
}));

const nextConfig = (await import('../apps/web/next.config.mjs')) as { SERVER_ACTIONS_BODY_SIZE_LIMIT: string; default: { experimental: { serverActions: { bodySizeLimit: string } } } };
const { UPLOAD_MAX_BYTES, isUploadTooLarge, FILE_TOO_LARGE_MESSAGE, megabytesText, fileReadIssue } = await import('../apps/web/src/lib/form-validation.js');
const { safeReturnPath, loginHrefFor, RETURN_PARAM } = await import('../apps/web/src/lib/return-path.js');
const { FormResult } = await import('../apps/web/src/components/form-feedback.js');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { OrderCreateForm } = await import('../apps/web/src/components/OrderCreateForm.js');
const { DocumentUploadForm } = await import('../apps/web/src/components/DocumentUploadForm.js');
const { LoginForm } = await import('../apps/web/src/components/LoginForm.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MiB = 1024 * 1024;

/** Next's bodySizeLimit parser semantics (bytes package): kb/mb/gb are powers of 1024. */
function bytesOf(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(text.trim());
  if (!match) throw new Error(`unreadable size ${text}`);
  const unit = { b: 1, kb: 1024, mb: MiB, gb: 1024 * MiB }[match[2]!.toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'];
  return Math.floor(Number(match[1]) * unit);
}

const noop = (() => undefined) as never;

// ---------------------------------------------------------------------------
describe('R07: the server action body limit holds the largest file the API accepts', () => {
  const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

  it('the web limit and the API limit are both 5 MiB', () => {
    expect(UPLOAD_MAX_BYTES).toBe(5 * MiB);
    expect(DEFAULT_DOCUMENT_MAX_BYTES).toBe(UPLOAD_MAX_BYTES);
  });

  it('next.config bodySizeLimit is at least the Base64 size of 5 MiB plus 1 MiB of margin', () => {
    const limit = bytesOf(nextConfig.SERVER_ACTIONS_BODY_SIZE_LIMIT);
    expect(limit).toBeGreaterThanOrEqual(base64Size(UPLOAD_MAX_BYTES) + MiB);
  });

  it('the exported constant is what the config really uses', () => {
    expect(nextConfig.default.experimental.serverActions.bodySizeLimit).toBe(nextConfig.SERVER_ACTIONS_BODY_SIZE_LIMIT);
  });

  it('is not Next default of 1 MB (it refused every file over ~750 KB)', () => {
    expect(bytesOf(nextConfig.SERVER_ACTIONS_BODY_SIZE_LIMIT)).toBeGreaterThan(MiB);
  });

  it('the config file text sets a bodySizeLimit (source guard)', () => {
    expect(readFileSync(path.join(root, 'apps/web/next.config.mjs'), 'utf8')).toMatch(/serverActions:\s*\{\s*bodySizeLimit:\s*SERVER_ACTIONS_BODY_SIZE_LIMIT/);
  });
});

describe('R07: isUploadTooLarge boundary', () => {
  it.each([
    [0, false],
    [1, false],
    [5 * MiB - 1, false],
    [5 * MiB, false],
    [5 * MiB + 1, true],
    [50 * MiB, true]
  ])('%i bytes => too large: %s', (bytes, expected) => {
    expect(isUploadTooLarge(bytes)).toBe(expected);
  });

  it('the message names the 5MB limit in Japanese only', () => {
    expect(FILE_TOO_LARGE_MESSAGE).toContain('5MB');
    expect(FILE_TOO_LARGE_MESSAGE).not.toMatch(/[A-Za-z]{3,}/);
  });

  it('megabytesText rounds up to one decimal', () => {
    expect(megabytesText(5 * MiB + 1)).toBe('5.1MB');
    expect(megabytesText(7.2 * MiB)).toBe('7.2MB');
    expect(megabytesText(0)).toBe('0.0MB');
  });

  it('the too-large read state is an issue the form shell reports', () => {
    expect(fileReadIssue('too-large')).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(fileReadIssue('read')).toBeNull();
  });

  it('the upload form says 5MBまで before a file is chosen', () => {
    const html = renderToString(
      <DocumentUploadForm
        action={noop}
        documentTypeChoices={[{ value: 'proof', label: '校正ゲラ' }]}
        issuerEntityChoices={[{ value: 'kanei', label: 'KANEI' }]}
        contentTypeChoices={[{ value: 'text/plain', label: 'テキスト' }]}
        sevenPurchaseOrderChoices={[]}
        filmSupplyOrderChoices={[]}
      />
    );
    expect(html).toContain('5MBまで');
  });
});

// ---------------------------------------------------------------------------
describe('R08: safeReturnPath', () => {
  it.each([
    ['//evil.test', 'protocol-relative'],
    ['//evil.test/orders', 'protocol-relative with a path'],
    ['/\\evil.test', 'slash backslash'],
    ['\\\\evil.test', 'backslashes'],
    ['https://evil.test', 'absolute URL'],
    ['http://evil.test/orders', 'absolute URL with a path'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['orders', 'relative path'],
    ['/api/auth/logout', 'the API relays'],
    ['/api/', 'api root'],
    ['/', 'the login page itself'],
    ['/?next=/orders', 'the login page with a query'],
    ['/orders\u0000', 'NUL'],
    ['/orders\n/x', 'newline'],
    ['/orders\r\nSet-Cookie: x=1', 'CRLF header injection'],
    ['/or\tders', 'tab inside'],
    ['/or\\ders', 'backslash inside'],
    ['/orders\u007f', 'DEL'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['/' + 'a'.repeat(600), 'over 512 characters']
  ])('refuses %j (%s)', (raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it.each([null, undefined, 5, {}, ['/orders']])('refuses a non-string %j', (raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it.each(['/orders', '/orders?x=1', '/maker-po#order-1', '/documents?tab=a&b=c', '/dashboard'])('accepts %j unchanged', (raw) => {
    expect(safeReturnPath(raw)).toBe(raw);
  });

  it('trims surrounding spaces of an otherwise valid path', () => {
    expect(safeReturnPath('  /orders ')).toBe('/orders');
  });

  it('loginHrefFor encodes the path as next=', () => {
    expect(RETURN_PARAM).toBe('next');
    expect(loginHrefFor('/orders?x=1')).toBe('/?next=%2Forders%3Fx%3D1');
  });

  it.each(['//evil.test', '/', '', 'https://evil.test', '/api/me'])('loginHrefFor(%j) is the plain login page', (raw) => {
    expect(loginHrefFor(raw)).toBe('/');
  });

  it('the login form only ever navigates to safeReturnPath(returnTo) (source guard)', () => {
    const text = readFileSync(path.join(root, 'apps/web/src/components/LoginForm.tsx'), 'utf8');
    expect(text).toContain('router.replace(safeReturnPath(returnTo) ?? DEFAULT_AFTER_LOGIN)');
    expect(text).not.toMatch(/router\.(replace|push)\(returnTo/);
  });

  it('the login form renders without the return path leaking into the markup', () => {
    expect(renderToString(<LoginForm returnTo="//evil.test" />)).not.toContain('evil.test');
  });

  describe('the login screen of a signed-in operator', () => {
    const redirectTarget = async (next: string | undefined): Promise<string | null> => {
      session.user = { id: 'u1', role: 'staff' };
      const { default: LoginPage } = await import('../apps/web/src/app/page.js');
      try {
        await LoginPage({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });
        return null;
      } catch (error) {
        return (error as { target?: string }).target ?? null;
      } finally {
        session.user = null;
      }
    };

    it('goes back to the screen named by ?next=', async () => {
      expect(await redirectTarget('/orders?x=1')).toBe('/orders?x=1');
    });

    // P1 R26: without ?next= the operator lands on the role's home.
    it('goes to the role home without ?next=', async () => {
      expect(await redirectTarget(undefined)).toBe('/home');
    });

    it.each(['//evil.test', 'https://evil.test', '/\\evil.test', '/api/auth/logout'])('never follows %j (the role home instead)', async (next) => {
      expect(await redirectTarget(next)).toBe('/home');
    });
  });
});

// ---------------------------------------------------------------------------
describe('R08/R05/R03/R09: FormResult remedies and the Korean line', () => {
  const render = (state: Parameters<typeof FormResult>[0]['state'], showKorean = false) =>
    renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean }}>
        <FormResult state={state} />
      </RenderedContextProvider>
    );

  it('SESSION_EXPIRED offers a login link that opens in a new tab and keeps this tab', () => {
    const html = render({ ok: false, message: 'ログインの有効期限が切れました。', code: 'SESSION_EXPIRED' });
    expect(html).toContain('別のタブでログインする');
    expect(html).toMatch(/<a [^>]*class="form-result-action"[^>]*href="\/"[^>]*target="_blank"[^>]*rel="noopener"|<a [^>]*href="\/"[^>]*target="_blank"/);
  });

  it('PROJECT_CONTEXT_MISMATCH offers a reload button (a button, not a link)', () => {
    const html = render({ ok: false, message: '別のタブで案件が切り替わりました。', code: 'PROJECT_CONTEXT_MISMATCH' });
    expect(html).toContain('<button type="button" class="form-result-action">画面を再読み込みする</button>');
    expect(html).not.toContain('別のタブでログインする');
  });

  it('DUPLICATE with a link offers that link', () => {
    const html = render({ ok: false, message: 'この番号はすでに登録されています。', code: 'DUPLICATE', link: { href: '/orders#seven-po-abc', label: '登録済みのセブン化学発注書を開く' } });
    expect(html).toContain('<a class="form-result-action" href="/orders#seven-po-abc">登録済みのセブン化学発注書を開く</a>');
  });

  it('a DUPLICATE without a link has no action', () => {
    const html = render({ ok: false, message: 'この番号はすでに別の案件に登録されています。', code: 'DUPLICATE', link: null });
    expect(html).not.toContain('form-result-action');
  });

  it('a plain refusal has no action', () => {
    expect(render({ ok: false, message: '数量を入力してください。' })).not.toContain('form-result-action');
  });

  it('a success has no action and no refusal mark', () => {
    const html = render({ ok: true, message: '記録しました。', changedId: 'x', code: 'SESSION_EXPIRED' });
    expect(html).not.toContain('form-result-action');
    expect(html).toContain('記録しました。');
  });

  it('the Korean line is shown when the representative sees the screen (showKorean)', () => {
    const html = render({ ok: false, message: '日本語の文', messageKo: '한국어 문장' }, true);
    expect(html).toContain('<span class="form-result-ko" lang="ko">한국어 문장</span>');
  });

  it('the Korean line is not shown to others (showKorean false)', () => {
    expect(render({ ok: false, message: '日本語の文', messageKo: '한국어 문장' }, false)).not.toContain('한국어');
  });

  it('without the layout context there is no Korean line either', () => {
    expect(renderToStaticMarkup(<FormResult state={{ ok: false, message: '日本語の文', messageKo: '한국어 문장' }} />)).not.toContain('한국어');
  });

  it('a refusal without a Korean sentence shows none, even for the representative', () => {
    expect(render({ ok: false, message: '日本語の文', messageKo: null }, true)).not.toContain('lang="ko"');
  });

  it('a success never shows a Korean line', () => {
    expect(render({ ok: true, message: '記録しました。', messageKo: '기록했습니다' }, true)).not.toContain('기록했습니다');
  });

  it('no state renders no remedy', () => {
    expect(render(null)).not.toContain('form-result-action');
  });
});

// ---------------------------------------------------------------------------
describe('R01: the create form has no preselected 支払条件', () => {
  const choices = [
    { value: 'prepaid', label: '前払い' },
    { value: 'on_delivery', label: '納品後払い' },
    { value: 'undetermined', label: '未定' }
  ];
  const html = renderToString(
    <OrderCreateForm
      action={noop}
      orderKind="film"
      unitChoices={[{ value: 'rolls', label: 'ロール' }]}
      sevenPurchaseOrderChoices={[{ value: 'po-1', label: 'SEVEN-1' }]}
      paymentTermsChoices={choices}
    />
  ).replaceAll('<!-- -->', '');
  const select = /<select[^>]*name="paymentTerms"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';

  it('renders the select', () => {
    expect(select).not.toBe('');
  });

  it('the select is required', () => {
    expect(/<select[^>]*name="paymentTerms"[^>]*>/.exec(html)?.[0]).toContain('required');
  });

  it('the first option is empty, disabled and the selected one', () => {
    const first = /<option[^>]*>/.exec(select)?.[0] ?? '';
    expect(first).toContain('value=""');
    expect(first).toContain('disabled');
    expect(first).toContain('selected');
  });

  it('no real choice is selected', () => {
    const selected = [...select.matchAll(/<option[^>]*selected[^>]*>/g)].map((match) => match[0]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('value=""');
  });

  it('offers the three choices in glossary words', () => {
    for (const label of ['前払い', '納品後払い', '未定']) expect(select).toContain(`>${label}</option>`);
    expect(select).not.toMatch(/搬入時払い|未確定/);
  });

  it('the label says 支払条件 and marks it required', () => {
    expect(html).toContain('支払条件');
    expect(html).toContain('（必須）');
    expect(html).not.toContain('決済条件');
  });

  it('the 「未定」 warning is not shown before 「未定」 is chosen', () => {
    expect(html).not.toContain('「未定」のままでは代表承認できません');
  });

  it('the filling order form has no 支払条件 select', () => {
    const filling = renderToString(<OrderCreateForm action={noop} orderKind="filling" unitChoices={[{ value: 'pods', label: 'ポッド' }]} />);
    expect(filling).not.toContain('name="paymentTerms"');
  });
});
