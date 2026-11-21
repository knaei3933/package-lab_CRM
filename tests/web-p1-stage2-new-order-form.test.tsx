import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1 R21: NewOrderForm existing-PO mode. The component keeps `mode` and
 * `existingPoId` in useState, and a static render cannot click, so useState is
 * wrapped: the 2nd call (mode) and the 4th call (existingPoId) of the form's own
 * state can be preset. The form's own hooks run before any child renders, so the
 * call order is: lines, mode, paymentTerms, existingPoId.
 */
const preset = vi.hoisted(() => ({ calls: 0, values: {} as Record<number, unknown> }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      preset.calls += 1;
      if (preset.calls in preset.values) return [preset.values[preset.calls], () => undefined];
      return actual.useState(initial as never);
    }
  };
});
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined, usePathname: () => '/p/PRJ-1/new', useRouter: () => ({ refresh: () => undefined }) }));

const { NewOrderForm } = await import('../apps/web/src/components/NewOrderForm.js');
const { startFilmOrderAction } = await import('../apps/web/src/app/step-actions.js');

const choices = [{ value: 'po-verified', label: '確認済みPO' }, { value: 'po-unverified', label: '未照合PO（照合がまだ）' }];
const props = {
  action: startFilmOrderAction, projectCode: 'PRJ-1',
  unitChoices: [{ value: 'rolls', label: 'ロール' }],
  paymentTermsChoices: [{ value: 'prepaid', label: '前払い' }],
  existingPoChoices: choices, unverifiedPoIds: ['po-unverified']
};

function render(values: Record<number, unknown>, over: Partial<typeof props> = {}) {
  preset.calls = 0;
  preset.values = values;
  return renderToStaticMarkup(<NewOrderForm {...props} {...over} />);
}

const MODE = 2;
const EXISTING_PO = 4;

beforeEach(() => { preset.calls = 0; preset.values = {}; });

describe('NewOrderForm: existing-PO mode', () => {
  it('posts runChecklist=true and shows the checklist for an unverified PO', () => {
    const html = render({ [MODE]: 'existing', [EXISTING_PO]: 'po-unverified' });
    expect(html).toContain('name="runChecklist" value="true"');
    expect(html).toContain('発注書の照合');
    expect(html).toContain('name="issuerNameRecorded"');
    expect(html).not.toContain('name="poNumber"');
  });

  it('does not post runChecklist and hides the checklist for a verified PO', () => {
    const html = render({ [MODE]: 'existing', [EXISTING_PO]: 'po-verified' });
    expect(html).not.toContain('name="runChecklist"');
    expect(html).not.toContain('name="issuerNameRecorded"');
  });

  it('does not post runChecklist while no PO is chosen yet', () => {
    expect(render({ [MODE]: 'existing', [EXISTING_PO]: '' })).not.toContain('name="runChecklist"');
  });

  it('offers the registered POs and no new-PO fields in existing mode', () => {
    const html = render({ [MODE]: 'existing', [EXISTING_PO]: '' });
    expect(html).toContain('name="existingPoId"');
    expect(html).toContain('未照合PO（照合がまだ）');
    expect(html).not.toContain('name="officialRegisteredAt"');
  });
});

describe('NewOrderForm: new-PO mode (default)', () => {
  it('asks for the number, date and the checklist, and never posts runChecklist', () => {
    const html = render({});
    expect(html).toContain('name="poNumber"');
    expect(html).toContain('name="officialRegisteredAt"');
    expect(html).toContain('name="issuerNameRecorded"');
    expect(html).not.toContain('name="runChecklist"');
    expect(html).not.toContain('name="existingPoId"');
  });

  it('shows the mode choice only when a registered PO exists', () => {
    expect(render({})).toContain('name="poMode"');
    expect(render({}, { existingPoChoices: [], unverifiedPoIds: [] })).not.toContain('name="poMode"');
  });

  it('carries the project code and the serialized lines', () => {
    const html = render({});
    expect(html).toContain('name="projectCode" value="PRJ-1"');
    expect(html).toContain('name="lines"');
  });
});
