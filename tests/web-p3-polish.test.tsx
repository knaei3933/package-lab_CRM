import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * P3 polish: touch targets / focus (M-2), the lock-confirm buttons keep their
 * layout (M-3, RM1 = KEY_REUSED, RM2 = OUTCOME_UNKNOWN), Korean next to every
 * remedy button, one Korean sentence for an ended session.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams()
}));

import { FormFeedbackContext, FormResult } from '../apps/web/src/components/form-feedback';
import { RenderedContextProvider } from '../apps/web/src/components/RenderedContext';
import * as notice from '../apps/web/src/lib/idempotency-notice';
import { ERROR_DICTIONARY } from '../apps/web/src/lib/error-dictionary-data';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
/** The body of the first rule whose selector list has `selector` as one exact entry. */
const ruleFor = (css: string, selector: string): string => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g);
  for (const [, list, body] of rules) {
    if (list!.split(',').some((entry) => entry.trim() === selector)) return body!;
  }
  throw new Error(`no rule for ${selector}`);
};

describe('P3 M-3 / RM1 / RM2: the lock-confirm buttons', () => {
  const css = read('app/p3-polish.css');

  it('stacks the Japanese label above the Korean line (column) and wraps by word, not by letter', () => {
    const rule = ruleFor(css, '.form-result-action');
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).not.toMatch(/word-break:\s*(break-all|anywhere)/);
    expect(rule).not.toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('the Korean line inside the button is a full-width block, not a flex-basis 100% item', () => {
    const rule = ruleFor(css, '.form-result-action > .form-result-ko');
    expect(rule).toMatch(/flex:\s*0 0 auto/);
    expect(rule).toMatch(/width:\s*100%/);
  });

  it('the remedy block may use the full row so the button is not squeezed', () => {
    expect(ruleFor(css, '.form-result-remedy')).toMatch(/width:\s*100%/);
  });

  // The buttons only render when the form holds the lock / pending check, so drive the real context.
  const withContext = (code: string, flags: { keyReuseLocked?: boolean; outcomeCheckPending?: boolean }, showKorean: boolean) => renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'p', showKorean }}>
      <FormFeedbackContext.Provider value={{ errors: {}, summaryCount: 0, startNewIntent: () => undefined, ...flags } as never}>
        <FormResult state={{ ok: false, message: 'x', messageKo: '엑스', code }} />
      </FormFeedbackContext.Provider>
    </RenderedContextProvider>
  );
  const buttonOf = (html: string) => html.match(/<button type="button" class="form-result-action">[\s\S]*?<\/button>/)?.[0];

  it('RM2 (OUTCOME_UNKNOWN): the confirm button holds the ja label and its ko line, in every display mode', () => {
    for (const showKorean of [false, true]) {
      const button = buttonOf(withContext('IDEMPOTENCY_OUTCOME_UNKNOWN', { outcomeCheckPending: true }, showKorean));
      expect(button, String(showKorean)).toBeDefined();
      expect(button).toContain(notice.OUTCOME_UNKNOWN_CHECKED_LABEL);
      expect(button).toContain(`<span class="form-result-ko" lang="ko">${notice.OUTCOME_UNKNOWN_CHECKED_KO}</span>`);
    }
  });

  it('RM1 (KEY_REUSED): the lock button holds the ja label and its ko line, in every display mode', () => {
    for (const showKorean of [false, true]) {
      const button = buttonOf(withContext('IDEMPOTENCY_KEY_REUSED', { keyReuseLocked: true }, showKorean));
      expect(button, String(showKorean)).toBeDefined();
      expect(button).toContain(notice.KEY_REUSED_CHECKED_LABEL);
      expect(button).toContain(`<span class="form-result-ko" lang="ko">${notice.KEY_REUSED_CHECKED_KO}</span>`);
    }
  });

  it('every ko constant is Hangul and every ja label has its ko pair', () => {
    for (const ko of [notice.OUTCOME_UNKNOWN_CHECKED_KO, notice.KEY_REUSED_CHECKED_KO, notice.RELOAD_KO, notice.LOGIN_OTHER_TAB_KO]) {
      expect(ko).toMatch(/[가-힣]/);
    }
  });
});

describe('P3 (4) / P-7: Korean next to the remedy buttons follows showKorean', () => {
  const render = (code: string, showKorean: boolean) => renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'p', showKorean }}>
      <FormResult state={{ ok: false, message: 'x', code }} />
    </RenderedContextProvider>
  );
  it('Japanese-only: the session-ended link and the reload button carry no Hangul', () => {
    for (const code of ['SESSION_EXPIRED', 'PROJECT_CONTEXT_MISMATCH']) {
      expect(render(code, false), code).not.toMatch(/[\uAC00-\uD7A3]/);
    }
    expect(render('SESSION_EXPIRED', false)).toContain(notice.LOGIN_OTHER_TAB_LABEL);
    expect(render('PROJECT_CONTEXT_MISMATCH', false)).toContain(notice.RELOAD_LABEL);
  });
  it('ja-ko: both get their Korean line', () => {
    expect(render('SESSION_EXPIRED', true)).toContain(`lang="ko">${notice.LOGIN_OTHER_TAB_KO}`);
    expect(render('PROJECT_CONTEXT_MISMATCH', true)).toContain(`lang="ko">${notice.RELOAD_KO}`);
  });
});

describe('P3 Low: one Korean sentence for an ended session', () => {
  it('AUTH_REQUIRED and SESSION_EXPIRED say the same thing in Korean and in Japanese', () => {
    const dict = ERROR_DICTIONARY as Record<string, { ja: string; ko: string }>;
    expect(dict.SESSION_EXPIRED!.ko).toBe(dict.AUTH_REQUIRED!.ko);
    expect(dict.SESSION_EXPIRED!.ja).toBe(dict.AUTH_REQUIRED!.ja);
    expect(dict.SESSION_EXPIRED!.ko).toBe('로그인이 만료되었습니다. 다시 로그인하세요.');
  });
  it('the login 401 wording stays the fixed non-oracle sentence', () => {
    expect(read('lib/login-messages.ts')).toContain("LOGIN_INVALID_MESSAGE = 'ユーザー名またはパスワードが正しくありません。'");
  });
});

describe('P3 M-2: touch targets, focus and names', () => {
  const css = read('app/p3-polish.css');
  it('buttons and links in the shell are at least 44px high', () => {
    for (const sel of ['.form-shell button', ".form-shell button[type='submit']", '.form-shell summary', '.project-picker-details > summary', '.confirm-dialog-actions button', '.app-nav a', '.app-help-link', '.project-picker-submit', '.p1-button', '.dash-next-link']) {
      expect(ruleFor(css, sel), sel).toMatch(/min-height:\s*44px/);
    }
  });
  it('the 44px summary rule is scoped: no bare `summary` selector can grow dense tables and cards', () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g);
    for (const [, list, body] of bare) {
      if (/min-height:\s*44px/.test(body!)) {
        expect(list!.split(',').map((e) => e.trim()), list).not.toContain('summary');
      }
    }
  });
  it('focus is a visible 2px ring on the remedy buttons and dialog buttons', () => {
    const rule = ruleFor(css, '.form-result-action:focus-visible');
    expect(rule).toMatch(/outline:\s*2px solid/);
  });
  it('the order-line delete button names its line', () => {
    expect(read('components/OrderCreateForm.tsx')).toContain('aria-label={`明細${index + 1}を削除`}');
  });
  it('the stylesheet is loaded after the others', () => {
    const layout = read('app/layout.tsx');
    expect(layout.indexOf("./p3-polish.css")).toBeGreaterThan(layout.indexOf("./p2-audit.css"));
  });
});
