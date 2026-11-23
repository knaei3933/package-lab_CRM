import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * p6 int round 2 (review L-7, V07): after a .eml is picked, the send form's hidden `filename` carries the
 * picked file's own name. There is no DOM in this suite (no jsdom, and no new tool may be added), so the
 * state a pick leaves behind is seeded through React's useState: the form's first two string states are
 * the EML bytes (contentBase64) and its file name, in that order (MakerPoSendEvidenceForm). The pick itself
 * (FileReader) is checked in the browser (REPORT §5 / round 2).
 */
const seeded = vi.hoisted(() => ({ values: [] as string[], used: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      // Only the form's own empty-string states are seeded, in order; every other state is React's.
      if (initial === '' && seeded.used < seeded.values.length) return actual.useState(seeded.values[seeded.used++]);
      return actual.useState(initial);
    }
  };
});
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));

const feedbackProps = vi.hoisted(() => ({ seen: [] as Array<Record<string, unknown>> }));
vi.mock('../apps/web/src/components/form-feedback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../apps/web/src/components/form-feedback.js')>();
  return {
    ...actual,
    FeedbackForm: (props: Parameters<typeof actual.FeedbackForm>[0]) => {
      feedbackProps.seen.push(props as unknown as Record<string, unknown>);
      return actual.FeedbackForm(props);
    }
  };
});

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { MakerPoSendEvidenceForm } = await import('../apps/web/src/components/MakerPoSendEvidenceForm.js');

const render = () => renderToStaticMarkup(
  <RenderedContextProvider value={{ projectId: 'project-a', showKorean: false }}>
    <MakerPoSendEvidenceForm action={async () => null} poId="po-1" sendEvidenceChoices={[]} orderCode="FSO-1" />
  </RenderedContextProvider>
).replaceAll('<!-- -->', '');

beforeEach(() => {
  feedbackProps.seen = [];
  seeded.values = [];
  seeded.used = 0;
});

describe('V07: the picked .eml\'s name is what the form posts as `filename`', () => {
  it('a picked file: hidden contentBase64 and filename hold it, and the 読み込み済み line names the same file', () => {
    seeded.values = ['RU1MLWJ5dGVz', 'レビュー送信_p6.eml'];
    const html = render();
    expect(seeded.used).toBe(2);
    expect(html).toContain('<input type="hidden" readOnly="" name="contentBase64" value="RU1MLWJ5dGVz"/>');
    expect(html).toContain('<input type="hidden" readOnly="" name="filename" value="レビュー送信_p6.eml"/>');
    expect(html).toContain('読み込み済み: レビュー送信_p6.eml');
  });

  it('nothing picked: both are empty and there is no 読み込み済み line', () => {
    const html = render();
    expect(html).toContain('name="contentBase64" value=""');
    expect(html).toContain('<input type="hidden" readOnly="" name="filename" value=""/>');
    expect(html).not.toContain('読み込み済み');
  });
});

describe('p6/web review M-1: the send form names its submit for the status line (intentLabel)', () => {
  it('the form shell gets intentLabel 「送信を記録する」 — the button\'s own words, not 「書類を登録」', async () => {
    const { MAKER_PO_SEND_SUBMIT_LABEL } = await import('../apps/web/src/lib/confirm-summary.js');
    render();
    expect(feedbackProps.seen).toHaveLength(1);
    expect(feedbackProps.seen[0]!.intentLabel).toBe(MAKER_PO_SEND_SUBMIT_LABEL);
    expect(MAKER_PO_SEND_SUBMIT_LABEL).toBe('送信を記録する');
  });
});
