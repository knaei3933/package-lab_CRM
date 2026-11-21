import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0 R03 (B3) → P1 R20: a write form carries the project it was drawn for (the
 * URL's /p/{案件コード}), and the write goes to THAT project — the selected /
 * last-project cookie (another tab) never redirects it. A form without the
 * field, or with an empty or malformed one, is refused before any API call
 * (fail closed, as before).
 */
const state = vi.hoisted(() => ({ selected: 'project-a' as string | null }));
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => state.selected,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

const { renderedProjectMatches, RENDERED_PROJECT_FIELD, PROJECT_CONTEXT_MISMATCH } = await import('../apps/web/src/lib/project-context.js');
const { refuseIfProjectSwitched } = await import('../apps/web/src/lib/project-guard.js');
const mainActions = await import('../apps/web/src/app/actions.js');
const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
const { FeedbackForm } = await import('../apps/web/src/components/form-feedback.js');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

const UNGUARDED = new Set(['selectProjectAction', 'openProjectFromCardAction']);

function formWith(rendered: string | null, entries: Record<string, string> = {}): FormData {
  const data = new FormData();
  if (rendered !== null) data.set(RENDERED_PROJECT_FIELD, rendered);
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

type Action = (prev: null, formData: FormData) => Promise<{ ok: boolean; code?: string | null; message: string }>;

function writeActions(module: Record<string, unknown>): Array<[string, Action]> {
  return Object.entries(module)
    .filter(([name, value]) => typeof value === 'function' && /Action$/.test(name) && !UNGUARDED.has(name))
    .map(([name, value]) => [name, value as Action]);
}

beforeEach(() => {
  state.selected = 'project-a';
  callApi.mockReset();
  callApi.mockResolvedValue({ ok: true, status: 201, data: { id: 'new-id' }, error: null });
  revalidatePath.mockReset();
});

describe('renderedProjectMatches (R03)', () => {
  it.each([
    ['the same project', 'project-a', 'project-a', true],
    ['another project', 'project-a', 'project-b', false],
    ['no project on both sides (null is the empty string)', '', null, true],
    ['a rendered project but no cookie', 'project-a', null, false],
    ['an empty rendered project but a cookie', '', 'project-a', false],
    ['case differs', 'Project-A', 'project-a', false],
    ['a trailing space', 'project-a ', 'project-a', false]
  ])('%s', (_label, rendered, current, expected) => {
    expect(renderedProjectMatches(rendered, current)).toBe(expected);
  });

  it('a missing field (null) is refused: fail closed', () => {
    expect(renderedProjectMatches(null, 'project-a')).toBe(false);
    expect(renderedProjectMatches(null, null)).toBe(false);
  });

  it('a file entry in place of the field is refused', () => {
    expect(renderedProjectMatches(new File(['x'], 'x.txt'), 'project-a')).toBe(false);
  });
});

describe('refuseIfProjectSwitched (R03 → R20)', () => {
  it('lets the write through when the form carries its rendered project', async () => {
    expect(await refuseIfProjectSwitched(formWith('project-a'))).toBeNull();
  });

  it('a cookie naming another project (another tab) does not refuse it: the write goes to the rendered project', async () => {
    state.selected = 'project-b';
    expect(await refuseIfProjectSwitched(formWith('project-a'))).toBeNull();
  });

  it.each([
    ['without the field', null],
    ['an empty field (a form drawn outside /p/{code})', ''],
    ['spaces', '  '],
    ['a path', 'project-a/../b'],
    ['a trailing space', 'project-a '],
    ['an over-long value', 'x'.repeat(65)]
  ])('refuses a form %s with PROJECT_CONTEXT_MISMATCH and operator text', async (_label, rendered) => {
    const refused = await refuseIfProjectSwitched(formWith(rendered));
    expect(refused).toMatchObject({ ok: false, code: PROJECT_CONTEXT_MISMATCH });
    expect(refused?.message).not.toMatch(/PROJECT_CONTEXT_MISMATCH/);
  });

  it('refuses a file in place of the field', async () => {
    const data = new FormData();
    data.set(RENDERED_PROJECT_FIELD, new File(['project-a'], 'x.txt'));
    expect(await refuseIfProjectSwitched(data)).toMatchObject({ ok: false, code: PROJECT_CONTEXT_MISMATCH });
  });
});

describe('every write action is guarded (source scan)', () => {
  const files = ['apps/web/src/app/actions.ts', 'apps/web/src/app/maker-po/actions.ts'];

  function exportedBodies(text: string): Array<{ name: string; body: string }> {
    const starts = [...text.matchAll(/^export async function (\w+)\(/gm)];
    return starts.map((match, index) => ({
      name: match[1]!,
      body: text.slice(match.index!, starts[index + 1]?.index ?? text.length)
    }));
  }

  it.each(files)('%s: finds the exported actions', (file) => {
    expect(exportedBodies(source(file)).length).toBeGreaterThan(5);
  });

  it.each(files.flatMap((file) => exportedBodies(source(file)).filter(({ name }) => !UNGUARDED.has(name)).map(({ name, body }) => [file, name, body] as const)))(
    '%s %s calls refuseIfProjectSwitched before any API call',
    (_file, _name, body) => {
      const guard = body.indexOf('refuseIfProjectSwitched(formData)');
      expect(guard).toBeGreaterThan(-1);
      for (const call of ['callApi(', 'post(', 'postCreate(', 'patch(', 'send(', 'readSelectedProjectId(', 'requireProjectId(']) {
        const at = body.indexOf(call);
        if (at !== -1) expect(guard, `${call} comes before the guard`).toBeLessThan(at);
      }
      // The refusal is returned, not ignored.
      expect(body).toMatch(/if \(switched\) return switched;/);
    }
  );

  it('selectProjectAction does not call the guard (it is what switches the project)', () => {
    const select = exportedBodies(source(files[0]!)).find(({ name }) => name === 'selectProjectAction')!;
    expect(select.body).not.toContain('refuseIfProjectSwitched');
  });
});

describe('every write action refuses before the API (runtime)', () => {
  const all = [...writeActions(mainActions), ...writeActions(makerActions)];

  it('finds the actions of both files', () => {
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(all.map(([name]) => name)).toEqual(expect.arrayContaining(['createFilmSupplyOrderAction', 'createMakerPoAction', 'uploadDocumentAction', 'cancelMakerPoAction']));
  });

  it.each(all.map(([name, action]) => [name, action] as const))('%s: another tab opened project-b => never written to project-b', async (_name, action) => {
    state.selected = 'project-b';
    await action(null, formWith('project-a', { orderId: 'o1', poId: 'p1', code: 'X', poNumber: 'X' }));
    for (const call of callApi.mock.calls) expect(String(call[0])).not.toContain('project-b');
  });

  it.each(all.map(([name, action]) => [name, action] as const))('%s: an empty rendered project => refused, API not called', async (_name, action) => {
    const result = await action(null, formWith('', { orderId: 'o1', poId: 'p1', code: 'X', poNumber: 'X' }));
    expect(result).toMatchObject({ ok: false, code: PROJECT_CONTEXT_MISMATCH });
    expect(callApi).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(all.map(([name, action]) => [name, action] as const))('%s: a form without the hidden field => refused, API not called', async (_name, action) => {
    const result = await action(null, formWith(null, { orderId: 'o1', poId: 'p1' }));
    expect(result).toMatchObject({ ok: false, code: PROJECT_CONTEXT_MISMATCH });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('a matching form reaches the API (createSevenPurchaseOrderAction)', async () => {
    const result = await mainActions.createSevenPurchaseOrderAction(null, formWith('project-a', { poNumber: 'SEVEN-GUARD-1' }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]![0]).toBe('/api/projects/project-a/seven-purchase-orders');
  });

  it('a matching form reaches the API (approveMakerPoAction)', async () => {
    // P1 integration: the approval first reads the card's snapshot hash, then approves with it.
    callApi.mockImplementation(async (path: string) => (String(path).endsWith('/approval-card')
      ? { ok: true, status: 200, data: { makerPurchaseOrder: { approvalSnapshotSha256: 'ab'.repeat(32) }, snapshot: { amounts: { currency: 'JPY', totalAmount: '1' } } }, error: null }
      : { ok: true, status: 201, data: { id: 'new-id' }, error: null }));
    const result = await makerActions.approveMakerPoAction(null, formWith('project-a', { poId: 'po1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: 'ab'.repeat(32) }));
    expect(result.ok).toBe(true);
    // Review H1: one call — the approval itself, with the hash the screen was drawn with.
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]![0]).toBe('/api/maker-purchase-orders/po1/ceo-approval');
    expect(callApi.mock.calls[0]![1]).toMatchObject({ body: { expectedSnapshotSha256: 'ab'.repeat(32) }, expectedProjectId: 'project-a' });
  });

  it('B3 in the URL model: a tab drawn for project-a still creates in project-a after another tab opened project-b', async () => {
    state.selected = 'project-b';
    const result = await mainActions.createSevenPurchaseOrderAction(null, formWith('project-a', { poNumber: 'SEVEN-GUARD-2' }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]![0]).toBe('/api/projects/project-a/seven-purchase-orders');
  });

  it('an order-scoped write posts to the order of the form (the API checks the order belongs to the operator)', async () => {
    state.selected = 'project-b';
    const result = await mainActions.recordDeliveryAction(null, formWith('project-a', { kind: 'film', orderId: 'order-of-a', lineId: 'l', unit: 'rolls', deliveredQuantity: '1' }));
    expect(result.ok).toBe(true);
    expect(callApi.mock.calls[0]![0]).toBe('/api/film-supply-orders/order-of-a/deliveries');
  });

  it('selectProjectAction is not refused for a missing hidden field and opens /p/{code}', async () => {
    callApi.mockResolvedValue({ ok: true, status: 200, data: { code: 'P-1', name: '合成' }, error: null });
    redirect.mockReset();
    const result = await mainActions.selectProjectAction(null, formWith(null, { projectId: 'project-z' }));
    expect(result?.code ?? null).not.toBe(PROJECT_CONTEXT_MISMATCH);
    expect(redirect).toHaveBeenCalledWith('/p/P-1');
  });
});

describe('FeedbackForm renders the hidden project field (R03)', () => {
  const noop = (() => undefined) as never;

  it('inside RenderedContextProvider the form carries the rendered project id', () => {
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'project-a', showKorean: false }}>
        <FeedbackForm action={noop} state={null}>
          <span>body</span>
        </FeedbackForm>
      </RenderedContextProvider>
    );
    expect(html).toContain(`<input type="hidden" readOnly="" name="${RENDERED_PROJECT_FIELD}" value="project-a"/>`);
  });

  it('with no project selected the field is present and empty (it matches a null cookie)', () => {
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: '', showKorean: false }}>
        <FeedbackForm action={noop} state={null}>
          <span>body</span>
        </FeedbackForm>
      </RenderedContextProvider>
    );
    expect(html).toContain(`name="${RENDERED_PROJECT_FIELD}" value=""`);
  });

  it('outside the provider the field is left out, so the server refuses the write', () => {
    const html = renderToStaticMarkup(
      <FeedbackForm action={noop} state={null}>
        <span>body</span>
      </FeedbackForm>
    );
    expect(html).not.toContain(RENDERED_PROJECT_FIELD);
  });

  it('the idempotency key is never in the server markup (it is drawn after mount)', () => {
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'project-a', showKorean: false }}>
        <FeedbackForm action={noop} state={null}>
          <span>body</span>
        </FeedbackForm>
      </RenderedContextProvider>
    );
    expect(html).not.toContain('_kaneiIdempotencyKey');
  });
});
