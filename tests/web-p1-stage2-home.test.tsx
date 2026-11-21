import { isValidElement, cloneElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R26: the role home (HomeScreen) — 承認箱 / 自分の作業 / 履歴. */
const state = vi.hoisted(() => ({
  user: { role: 'admin' } as { role: string } | null,
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>,
  listError: null as string | null,
  work: { rows: [], unreadProjects: [], skippedProjects: 0 } as unknown
}));
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => state.user,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadSelectableProjectList: async () => ({ projects: state.listError ? [] : state.projects, error: state.listError })
}));
vi.mock('../apps/web/src/lib/my-work.js', () => ({ loadMyWork: async () => state.work }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');

/** Resolves async server components (HomeScreen's AdminInbox etc.) so a static render can print them. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return resolve(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  const children = element.props.children;
  if (children === undefined) return element;
  const resolved = await resolve(children);
  return Array.isArray(resolved) ? cloneElement(element, undefined, ...resolved) : cloneElement(element, undefined, resolved);
}

async function home(): Promise<string> {
  const tree = await HomeScreen();
  return renderToStaticMarkup((await resolve(tree)) as ReactElement);
}

const A = { id: 'p-a', code: 'PRS-A', name: '案件A', status: 'ACTIVE' };
const B = { id: 'p-b', code: '案件B', name: 'B', status: 'ACTIVE' };
const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, code: null });
const fail = (status: number, code: string | null) => ({ ok: false, status, data: code ? { code } : null, error: '失敗しました', code });

const qitem = (kind: string, over: Record<string, unknown> = {}) => ({
  key: kind, kind, label: kind === 'maker_po_ceo_approval' ? '代表承認' : '保留の解除',
  project: { id: 'p-a', code: 'PRS-A', name: '案件A' }, order: { id: `o-${kind}`, code: `FSO-${kind}`, status: 'MAKER_PO_READY' },
  makerPurchaseOrder: { amounts: { display: '¥312,000' } }, waitingSince: '2026-11-20T01:00:00Z', requestedBy: { displayName: '佐藤' }, ...over
});

beforeEach(() => {
  state.user = { role: 'admin' };
  state.projects = [A, B];
  state.listError = null;
  state.work = { rows: [], unreadProjects: [], skippedProjects: 0 };
  callApi.mockReset();
});

describe('HomeScreen: representative (承認箱)', () => {
  it('lists each server item as a link to the order at its step', async () => {
    callApi.mockResolvedValue(ok({ items: [qitem('maker_po_ceo_approval'), qitem('hold_release', { project: { id: 'p-b', code: '案件B', name: 'B' } })], blocked: [] }));
    const html = await home();
    expect(html).toContain('承認箱');
    expect(html).toContain('代表の判断が必要な作業 2件');
    expect(html).toContain('href="/p/PRS-A/o/FSO-maker_po_ceo_approval?step=8"');
    expect(html).toContain(`href="/p/${encodeURIComponent('案件B')}/o/FSO-hold_release"`);
    expect(html).not.toContain('FSO-hold_release?step');
  });

  it('labels the ceo-approval link 内容を見て承認 and the others 開く', async () => {
    callApi.mockResolvedValue(ok({ items: [qitem('maker_po_ceo_approval'), qitem('hold_release')], blocked: [] }));
    const html = await home();
    expect(html).toMatch(/href="\/p\/PRS-A\/o\/FSO-maker_po_ceo_approval\?step=8">内容を見て承認/);
    expect(html).toMatch(/href="\/p\/PRS-A\/o\/FSO-hold_release">開く/);
    expect(html.match(/内容を見て承認/g)).toHaveLength(1);
  });

  it('shows the amount, the requester and the order code on the row', async () => {
    callApi.mockResolvedValue(ok({ items: [qitem('maker_po_ceo_approval')], blocked: [] }));
    const html = await home();
    expect(html).toContain('¥312,000');
    expect(html).toContain('依頼 佐藤');
    expect(html).toContain('FSO-maker_po_ceo_approval');
  });

  it('shows a blocked section with the reason and a 直す link', async () => {
    callApi.mockResolvedValue(ok({
      items: [],
      blocked: [{ kind: 'payment_terms_undetermined', project: { id: 'p-a', code: 'PRS-A' }, order: { id: 'o9', code: 'FSO-9' }, reason: { message: '支払条件が未定です' } }]
    }));
    const html = await home();
    expect(html).toContain('止まっている（代表が直せるもの）');
    expect(html).toContain('支払条件が未定です');
    expect(html).toMatch(/href="\/p\/PRS-A\/o\/FSO-9\?step=7">直す/);
  });

  it('has no blocked section when nothing is blocked', async () => {
    callApi.mockResolvedValue(ok({ items: [qitem('hold_release')], blocked: [] }));
    expect(await home()).not.toContain('止まっている');
  });

  it('says there is no work only when the queue was read and is empty', async () => {
    callApi.mockResolvedValue(ok({ items: [], blocked: [] }));
    expect(await home()).toContain('代表の判断が必要な作業はありません');
  });

  it('shows an error banner, never 「ありません」, when the queue could not be read', async () => {
    callApi.mockResolvedValue(fail(500, null));
    const html = await home();
    expect(html).toContain('role="alert"');
    expect(html).toContain('代表の作業を読み込めませんでした');
    expect(html).not.toContain('作業はありません');
  });

  it('falls back to the audit replay (and says so) when the server queue route is missing', async () => {
    callApi.mockImplementation(async (path: string) => path === '/api/representative-queue'
      ? fail(404, null)
      : ok({ events: [{ entityId: 'o1', action: 'FILM_SUPPLY_ORDER_CREATED', afterState: { code: 'FSO-1', status: 'DUAL_APPROVED' } }] }));
    const html = await home();
    expect(html).toContain('href="/p/PRS-A/o/FSO-1?step=7"');
    expect(html).toContain('この一覧は発注の状態から作っています');
  });

  it('names projects whose orders could not be read in the fallback', async () => {
    callApi.mockImplementation(async (path: string) => path === '/api/representative-queue' ? fail(403, 'CEO_ONLY') : path.includes('p-b') ? fail(500, null) : ok({ events: [] }));
    expect(await home()).toContain('読み込めなかった案件: 案件B');
  });
});

describe('HomeScreen: staff (自分の作業)', () => {
  beforeEach(() => { state.user = { role: 'staff' }; });
  const row = (group: string, code: string, step: number | null) => ({
    key: code, group, projectCode: 'PRS-A', orderCode: code, step, stepTitle: step ? `${step} 校正` : '', text: `${code}の文`, status: 'X', statusLabel: 'X', updatedAt: ''
  });

  it('shows the three groups with their counts and rows linking to the order step', async () => {
    state.work = { rows: [row('now', 'FSO-N', 5), row('waiting', 'FSO-W', 8), row('stuck', 'FSO-S', null)], unreadProjects: [], skippedProjects: 0 };
    const html = await home();
    expect(html).toContain('自分の作業');
    expect(html).toContain('いま進められる（1）');
    expect(html).toContain('相手待ち（1）');
    expect(html).toContain('止まっている（1）');
    expect(html).toContain('href="/p/PRS-A/o/FSO-N?step=5"');
    expect(html).toContain('href="/p/PRS-A/o/FSO-W?step=8"');
    expect(html).toContain('href="/p/PRS-A/o/FSO-S"');
    expect(html).toContain('自分の作業 1件');
  });

  it('shows ありません inside an empty group of a successful read', async () => {
    state.work = { rows: [row('now', 'FSO-N', 5)], unreadProjects: [], skippedProjects: 0 };
    const html = await home();
    expect(html).toContain('相手待ち（0）');
    expect(html.match(/ありません。/g)).toHaveLength(2);
  });

  it('names unread and skipped projects', async () => {
    state.work = { rows: [], unreadProjects: ['PRS-B'], skippedProjects: 3 };
    const html = await home();
    expect(html).toContain('読み込めなかった案件: PRS-B');
    expect(html).toContain('ほかの3件');
  });

  it('does not read the representative queue or any audit history', async () => {
    await home();
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('HomeScreen: viewer (履歴)', () => {
  beforeEach(() => { state.user = { role: 'viewer' }; });
  const ev = (id: string, occurredAt: string, over: Record<string, unknown> = {}) => ({
    id, occurredAt, action: 'MAKER_PO_CEO_APPROVED', actor: { displayName: '山田' }, afterState: { amounts: { totalAmount: '999777' } }, ...over
  });

  it('shows a history table (日時 / 誰 / 何を / 案件), newest first, without amounts', async () => {
    callApi.mockImplementation(async (path: string) => ok({ events: path.includes('p-a') ? [ev('e1', '2026-11-18T00:00:00Z')] : [ev('e2', '2026-11-20T00:00:00Z', { actor: { displayName: '鈴木' } })] }));
    const html = await home();
    expect(html).toContain('履歴');
    expect(html).toContain('<table');
    for (const header of ['日時', '誰', '何を', '案件']) expect(html).toContain(`>${header}</th>`);
    expect(html.indexOf('鈴木')).toBeLessThan(html.indexOf('山田'));
    expect(html).not.toContain('999777');
    expect(html).not.toMatch(/[¥￥]/);
    expect(html).toContain('金額は表示しません');
  });

  it('reads the history of each project with the approval/confirmation actions only', async () => {
    callApi.mockResolvedValue(ok({ events: [] }));
    await home();
    const paths = callApi.mock.calls.map((call) => call[0] as string);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('/api/projects/p-a/audit-history?limit=50&order=desc&action=');
    expect(paths[0]).toContain(encodeURIComponent('MAKER_PO_CEO_APPROVED'));
    expect(paths.some((path) => path.includes('/api/representative-queue'))).toBe(false);
  });

  it('says there is no record only when every read succeeded', async () => {
    callApi.mockResolvedValue(ok({ events: [] }));
    expect(await home()).toContain('まだ承認・確認の記録はありません');
  });

  it('says the history could not be read (not 「記録はありません」) when every read failed', async () => {
    callApi.mockResolvedValue(fail(500, null));
    const html = await home();
    expect(html).toContain('履歴を読み込めませんでした');
    expect(html).not.toContain('記録はありません');
    expect(html).toContain('読み込めなかった案件');
  });

  it('shows no more than 20 rows', async () => {
    callApi.mockResolvedValue(ok({ events: Array.from({ length: 30 }, (_, index) => ev(`e${index}`, `2026-11-${String(10 + (index % 10)).padStart(2, '0')}T00:00:00Z`)) }));
    expect((await home()).match(/<tr>/g)?.length).toBe(21);
  });
});

describe('HomeScreen: every role', () => {
  it.each(['admin', 'staff', 'viewer'])('%s: a failed project list shows an error banner and no 「ありません」', async (role) => {
    state.user = { role };
    state.listError = 'timeout';
    const html = await home();
    expect(html).toContain('role="alert"');
    expect(html).toContain('案件の一覧を読み込めませんでした（timeout）');
    expect(html).not.toContain('ありません');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('draws nothing without a signed-in user', async () => {
    state.user = null;
    expect(await HomeScreen()).toBeNull();
  });

  it('an unknown role is treated as a viewer (履歴)', async () => {
    state.user = { role: 'auditor' };
    callApi.mockResolvedValue(ok({ events: [] }));
    expect(await home()).toContain('履歴');
  });

  it('links to the dashboard and to the first 5 projects', async () => {
    state.user = { role: 'staff' };
    state.projects = Array.from({ length: 7 }, (_, index) => ({ id: `p${index}`, code: `C${index}`, name: 'n', status: 'ACTIVE' }));
    const html = await home();
    expect(html).toContain('href="/dashboard"');
    expect(html.match(/href="\/p\/C\d"/g)).toHaveLength(5);
  });

  it('prints no lang="ko" Korean line outside the bilingual context', async () => {
    callApi.mockResolvedValue(ok({ items: [], blocked: [] }));
    expect(await home()).not.toContain('lang="ko"');
  });
});
