import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  accounts,
  createDatabase,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';

/**
 * ui/fix-project-select (demo-eml/ui-fix-project-select/REPORT.md). Symptom: a
 * new login landed on 「選択中の案件を開けません…理由: 案件が見つかりません」
 * because the browser still remembered a project (kanei_web_project cookie,
 * shared by every port on the same host) the API does not open for this
 * operator. Checked against the REAL API on the isolated test database
 * (callApi routed into the Hono app, as in web-nav-dashboard-parity):
 * - a remembered project that is deleted, not assigned, not in this database
 *   or not even an id is forgotten without a message (dashboard and screens
 *   hand over to /project-selection, which deletes the cookie);
 * - 1 project: opened for the operator; N: one card per project on the
 *   dashboard; 0: why, and the next step for the role;
 * - logout forgets the project for the next person.
 * No API, schema or migration file is changed.
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);
type Who = 'admin' | 'one' | 'many' | 'none';
const ids: Record<Who, string> = { admin: uuidv7(), one: uuidv7(), many: uuidv7(), none: uuidv7() };
const tokens: Record<Who, string> = { admin: '', one: '', many: '', none: '' };
const project = { a: uuidv7(), b: uuidv7(), unassigned: uuidv7(), deleted: uuidv7() };
const NOT_IN_DB = '0b6f1c2e-0000-4000-8000-000000000000';
let app: ReturnType<typeof createApp>;

const signedIn = vi.hoisted(() => ({ token: '', role: 'staff', userId: '', projectId: '' as string, cookiesSet: [] as Array<[string, string]> }));

vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://in-process',
  readSessionToken: async () => signedIn.token,
  readSelectedProjectId: async () => signedIn.projectId || null,
  loadSessionUser: async () => ({ id: signedIn.userId, role: signedIn.role, displayName: '合成' }),
  callApi: async (apiPath: string, options: { method?: string; body?: unknown; sessionToken?: string | null } = {}) => {
    const token = options.sessionToken !== undefined ? options.sessionToken : signedIn.token;
    const response = await app.request(apiPath, {
      method: options.method ?? 'GET',
      headers: {
        ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const raw = await response.text();
    let data: unknown = null;
    try { data = raw.length > 0 ? JSON.parse(raw) : null; } catch { data = null; }
    const error = response.ok
      ? null
      : (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `status ${response.status}`);
    return { ok: response.ok, status: response.status, data, error };
  }
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, refresh: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string) => { signedIn.cookiesSet.push([name, value]); }
  })
}));

const { default: DashboardPage } = await import('../apps/web/src/app/dashboard/page.js');
const { default: OrdersPage } = await import('../apps/web/src/app/orders/page.js');
const { default: DocumentsPage } = await import('../apps/web/src/app/documents/page.js');
const { GET: projectSelectionRoute } = await import('../apps/web/src/app/project-selection/route.js');
const { POST: logoutRoute } = await import('../apps/web/src/app/api/auth/logout/route.js');
const { openProjectFromCardAction } = await import('../apps/web/src/app/actions.js');
const { decideProjectSelection, safeReturnPath, projectSelectionHref } = await import('../apps/web/src/lib/project-selection.js');
const { CHOOSE_TITLE, NONE_TITLE, LIST_FAILED_TITLE, OPEN_PROJECT_LABEL } = await import('../apps/web/src/components/ProjectChooser.js');
const { NO_PROJECT_SELECTED_MESSAGE } = await import('../apps/web/src/lib/project-data.js');

const OLD_MESSAGE = '選択中の案件を開けません';

function signIn(who: Who, remembered: string = '') {
  signedIn.role = who === 'admin' ? 'admin' : 'staff';
  signedIn.userId = ids[who];
  signedIn.token = tokens[who];
  signedIn.projectId = remembered;
  signedIn.cookiesSet = [];
}

async function render(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

/** The address a screen redirected to (Next's redirect() throws), or null when it rendered. */
async function redirectOf(page: () => Promise<unknown>): Promise<string | null> {
  try {
    await render(page);
    return null;
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT')) throw error;
    return digest.split(';')[2] ?? '';
  }
}

/** The /project-selection route as the browser calls it: the session and the remembered project from the Cookie header. */
async function selectRoute(who: Who, query: string, remembered: string | null) {
  const cookie = [`${SESSION_COOKIE}=${tokens[who]}`, remembered === null ? null : `kanei_web_project=${remembered}`].filter(Boolean).join('; ');
  const response = await projectSelectionRoute(new Request(`http://projsel.localhost:3092/project-selection${query}`, { headers: { cookie } }));
  return { status: response.status, location: response.headers.get('location'), setCookie: response.headers.getSetCookie() };
}

beforeAll(async () => {
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_po_send_manual_verifications,
      maker_purchase_orders, artwork_revisions, artwork_approval_events,
      evidence_manual_verifications, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, film_supply_order_lines, film_deliveries,
      filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      delivery_confirmations, project_assignments, projects, sessions, accounts, users cascade
  `);
  const passwordHash = await hashPassword('composite-staff-pass');
  await db.insert(users).values([
    { id: ids.admin, username: 'admin_ps_test', passwordHash, displayName: '合成代表者PS', role: 'admin' },
    { id: ids.one, username: 'staff_ps_one', passwordHash, displayName: '合成担当者PS1', role: 'staff' },
    { id: ids.many, username: 'staff_ps_many', passwordHash, displayName: '合成担当者PSN', role: 'staff' },
    { id: ids.none, username: 'staff_ps_none', passwordHash, displayName: '合成担当者PS0', role: 'staff' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成PSエンドカスタマー', role: 'end_customer', externalCode: 'TEST-PS-CUST' },
    { id: seven, name: '合成PSセブン', role: 'seven', externalCode: 'TEST-PS-SEVEN' },
    { id: maker, name: '合成PSメーカー', role: 'maker', externalCode: 'TEST-PS-MAKER' }
  ]);
  const now = new Date();
  const row = (id: string, code: string, name: string, deletedAt: Date | null = null) => ({
    id, code, name, businessUnit: 'F1' as const, route: 'F1' as const, leadSource: 'KANEI', status: 'DRAFT' as const,
    endCustomerAccountId: customer, sevenAccountId: seven, makerAccountId: maker, createdByUserId: ids.admin,
    createdAt: now, updatedAt: now, deletedAt
  });
  await db.insert(projects).values([
    row(project.a, 'TEST-PS-A', '合成PS案件A'),
    row(project.b, 'TEST-PS-B', '合成PS案件B'),
    row(project.unassigned, 'TEST-PS-X', '合成PS案件X（担当外）'),
    row(project.deleted, 'TEST-PS-D', '合成PS案件D（削除済み）', now)
  ]);
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: ids.one, projectId: project.a },
    { id: uuidv7(), userId: ids.many, projectId: project.a },
    { id: uuidv7(), userId: ids.many, projectId: project.b },
    { id: uuidv7(), userId: ids.many, projectId: project.deleted }
  ]);
  for (const who of Object.keys(ids) as Who[]) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({ id: uuidv7(), userId: ids[who], tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    tokens[who] = token;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await pool.end();
});

describe('the decision (pure)', () => {
  const p = (id: string) => ({ id, code: `C-${id}`, name: `N-${id}`, status: 'DRAFT' });
  const ok = (...list: string[]) => ({ projects: list.map(p), error: null });

  it('a remembered project in the list stays open; nothing is written', () => {
    expect(decideProjectSelection('a', ok('a', 'b'))).toEqual({ selection: { kind: 'open', projectId: 'a' }, cookie: undefined });
  });

  it('0 / 1 / N projects with nothing remembered: none / opened for the operator / cards', () => {
    expect(decideProjectSelection(null, ok())).toEqual({ selection: { kind: 'none' }, cookie: undefined });
    expect(decideProjectSelection(null, ok('a'))).toEqual({ selection: { kind: 'open', projectId: 'a' }, cookie: 'a' });
    expect(decideProjectSelection('', ok('a', 'b'))).toEqual({ selection: { kind: 'choose', projects: [p('a'), p('b')] }, cookie: undefined });
  });

  it('a remembered project missing from the list is forgotten, then 0 / 1 / N as above', () => {
    expect(decideProjectSelection('gone', ok())).toEqual({ selection: { kind: 'none' }, cookie: null });
    expect(decideProjectSelection('gone', ok('a'))).toEqual({ selection: { kind: 'open', projectId: 'a' }, cookie: 'a' });
    expect(decideProjectSelection('gone', ok('a', 'b'))).toEqual({ selection: { kind: 'choose', projects: [p('a'), p('b')] }, cookie: null });
  });

  it('a failed list read judges nothing: the remembered project stays, without one the failure is reported', () => {
    const failed = { projects: [], error: 'API（x）に接続できません。' };
    expect(decideProjectSelection('a', failed)).toEqual({ selection: { kind: 'open', projectId: 'a' }, cookie: undefined });
    expect(decideProjectSelection(null, failed)).toEqual({ selection: { kind: 'list-failed', error: failed.error }, cookie: undefined });
  });

  it('the return address is one of the screens, never another site', () => {
    expect(safeReturnPath('/orders')).toBe('/orders');
    for (const bad of ['https://evil.example/', '//evil.example', '/project-selection', '/dashboard?x', null, '']) {
      expect(safeReturnPath(bad)).toBe('/dashboard');
    }
    expect(projectSelectionHref('/maker-po', { reset: true })).toBe('/project-selection?next=%2Fmaker-po&reset=1');
  });
});

describe('a remembered project this operator cannot open is forgotten without a message (real API)', () => {
  const cases: Array<[string, string]> = [
    ['not in this database (another server on the same host)', NOT_IN_DB],
    ['deleted', project.deleted],
    ['not assigned to the operator', project.unassigned],
    ['not a project id at all', 'old-demo']
  ];
  for (const [label, remembered] of cases) {
    it(`${label}: the dashboard hands over, the route deletes the cookie, the cards follow`, async () => {
      signIn('many', remembered);
      expect(await redirectOf(DashboardPage)).toBe('/project-selection?next=%2Fdashboard');
      const answer = await selectRoute('many', '?next=%2Fdashboard', remembered);
      expect(answer.status).toBe(303);
      expect(answer.location).toBe('/dashboard');
      expect(answer.setCookie).toEqual(['kanei_web_project=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
      signIn('many');
      const html = await render(DashboardPage);
      expect(html).not.toContain(OLD_MESSAGE);
      expect(html).not.toContain('案件が見つかりません');
      expect(html).toContain(CHOOSE_TITLE);
    });
  }

  it('the other screens do the same and come back to themselves', async () => {
    signIn('many', NOT_IN_DB);
    expect(await redirectOf(OrdersPage)).toBe('/project-selection?next=%2Forders');
    expect(await redirectOf(DocumentsPage)).toBe('/project-selection?next=%2Fdocuments');
    expect((await selectRoute('many', '?next=%2Forders', NOT_IN_DB)).location).toBe('/orders');
    // Without a remembered project and several to choose from, the screen asks for a choice.
    signIn('many');
    expect(await render(OrdersPage)).toContain(NO_PROJECT_SELECTED_MESSAGE);
  });

  it('with only one project left, the forgotten one is replaced by it', async () => {
    const answer = await selectRoute('one', '?next=%2Fdashboard', project.deleted);
    expect(answer.setCookie).toEqual([`kanei_web_project=${project.a}; Path=/; HttpOnly; SameSite=Lax`]);
  });
});

describe('after login: 1 / N / 0 projects (real API)', () => {
  it('1 project: opened for the operator, the dashboard shows it', async () => {
    signIn('one');
    expect(await redirectOf(DashboardPage)).toBe('/project-selection?next=%2Fdashboard');
    const answer = await selectRoute('one', '?next=%2Fdashboard', null);
    expect(answer.location).toBe('/dashboard');
    expect(answer.setCookie).toEqual([`kanei_web_project=${project.a}; Path=/; HttpOnly; SameSite=Lax`]);
    signIn('one', project.a);
    const html = await render(DashboardPage);
    expect(html).toContain('案件: TEST-PS-A（合成PS案件A）');
    expect(html).not.toContain(CHOOSE_TITLE);
  });

  it('N projects: one large card per project the operator may open — not the deleted or unassigned ones', async () => {
    signIn('many');
    expect(await redirectOf(DashboardPage)).toBeNull();
    const html = await render(DashboardPage);
    expect(html).toContain(CHOOSE_TITLE);
    expect(html).toContain('あなたが開ける案件は2件です。');
    const cards = html.match(/<button type="submit" class="project-choice">[\s\S]*?<\/button>/g) ?? [];
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('合成PS案件A');
    expect(cards[0]).toContain('TEST-PS-A');
    expect(cards[0]).toContain(OPEN_PROJECT_LABEL);
    expect(cards[1]).toContain('合成PS案件B');
    expect(html).toContain(`name="projectId" value="${project.a}"`);
    expect(html).not.toContain('TEST-PS-X');
    expect(html).not.toContain('TEST-PS-D');
    // The route leaves a valid choice alone.
    expect((await selectRoute('many', '?next=%2Fdashboard', project.b)).setCookie).toEqual([]);
  });

  it('N projects: a card opens its project; a card for a project the API refuses writes nothing', async () => {
    signIn('many');
    const form = new FormData();
    form.set('projectId', project.b);
    await expect(openProjectFromCardAction(form)).rejects.toMatchObject({ digest: expect.stringContaining(';/dashboard;') });
    expect(signedIn.cookiesSet).toEqual([['kanei_web_project', project.b]]);

    signIn('many');
    form.set('projectId', project.unassigned);
    await expect(openProjectFromCardAction(form)).rejects.toMatchObject({ digest: expect.stringContaining(';/dashboard;') });
    expect(signedIn.cookiesSet).toEqual([]);
  });

  it('N projects with a valid remembered one: that project opens, no hand-over', async () => {
    signIn('many', project.b);
    expect(await redirectOf(DashboardPage)).toBeNull();
    expect(await render(DashboardPage)).toContain('案件: TEST-PS-B（合成PS案件B）');
  });

  it('0 projects: why, and the next step for the role — no card, no dead end', async () => {
    signIn('none');
    expect(await redirectOf(DashboardPage)).toBeNull();
    const html = await render(DashboardPage);
    expect(html).toContain(NONE_TITLE);
    expect(html).toContain('あなたが担当する案件が、まだ割り当てられていません。');
    expect(html).toContain('代表者に「担当する案件への割り当て」を依頼してください。');
    expect(html).not.toContain('class="project-choice"');
    expect(html).not.toContain(OLD_MESSAGE);
    // A stale cookie for an operator without projects is forgotten too.
    expect((await selectRoute('none', '', NOT_IN_DB)).setCookie).toEqual(['kanei_web_project=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
  });

  it('admin sees every live project as a card (the API lists all for the representative)', async () => {
    signIn('admin');
    const html = await render(DashboardPage);
    const cards = html.match(/class="project-choice"/g) ?? [];
    expect(cards).toHaveLength(3);
    expect(html).toContain('TEST-PS-X');
    expect(html).not.toContain('TEST-PS-D');
  });
});

describe('the /project-selection route', () => {
  it('「案件を選び直す」 (reset=1) forgets even a valid project, then decides again', async () => {
    expect((await selectRoute('many', '?next=%2Fmaker-po&reset=1', project.a))).toEqual({
      status: 303, location: '/maker-po', setCookie: ['kanei_web_project=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']
    });
    // With one project, re-selecting lands on it again.
    expect((await selectRoute('one', '?reset=1', project.a)).setCookie).toEqual([`kanei_web_project=${project.a}; Path=/; HttpOnly; SameSite=Lax`]);
  });

  it('never sends the operator to another site', async () => {
    expect((await selectRoute('many', '?next=https%3A%2F%2Fevil.example%2F', null)).location).toBe('/dashboard');
    expect((await selectRoute('many', '?next=%2F%2Fevil.example', null)).location).toBe('/dashboard');
  });

  it('without a session it writes nothing and goes to the login screen', async () => {
    const response = await projectSelectionRoute(new Request('http://projsel.localhost:3092/project-selection', { headers: { cookie: `kanei_web_project=${NOT_IN_DB}` } }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('a failed list read writes nothing (no judgement on what could not be read)', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('unreachable'); });
    const failingApp = app;
    app = { request: async () => new Response(JSON.stringify({ error: 'API停止' }), { status: 503 }) } as unknown as typeof app;
    try {
      const answer = await selectRoute('many', '', NOT_IN_DB);
      expect(answer.setCookie).toEqual([]);
      signIn('many');
      expect(await render(DashboardPage)).toContain(LIST_FAILED_TITLE);
    } finally {
      app = failingApp;
    }
  });
});

describe('logout forgets the project for the next person on this browser', () => {
  it('the project cookie is deleted with the session (API reachable or not)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const reached = await logoutRoute(new Request('http://projsel.localhost:3092/api/auth/logout', { method: 'POST', headers: { cookie: `kanei_web_project=${project.a}` } }));
    expect(reached.headers.getSetCookie()).toContain('kanei_web_project=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    vi.stubGlobal('fetch', async () => { throw new Error('unreachable'); });
    const unreachable = await logoutRoute(new Request('http://projsel.localhost:3092/api/auth/logout', { method: 'POST' }));
    expect(unreachable.status).toBe(502);
    expect(unreachable.headers.getSetCookie()).toContain('kanei_web_project=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
});
