import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { expectedProjectMiddleware, EXPECTED_PROJECT_HEADER, targetOf } from '../apps/api/src/project-context.js';
import { isOwnDocumentOfStaff, isOwnEvidenceOfStaff, uploaderIdsOf } from '../apps/web/src/lib/self-verification.js';

/**
 * P1 integration: M2 (every write checked against the project its screen was drawn
 * for) and P-4 (staff never confirm their own evidence; the representative may).
 */
const A = '01a1e8eb-5b0f-7d64-aa2a-2da0a82a2050';
const B = '01a1e8eb-5b15-7b47-9c5d-82d2e64c44b1';
const ORDER = '01a1fc0e-5b5d-7d45-bb85-a3f02aa14a0e';

describe('targetOf (M2)', () => {
  it.each([
    [`/api/film-supply-orders/${ORDER}/transitions`, 1],
    [`/api/maker-purchase-orders/${ORDER}/ceo-approval`, 6],
    [`/api/documents/${ORDER}/verify`, 5],
    [`/api/projects/${A}/documents`, 0],
    [`/api/filling-deliveries/${ORDER}/confirmation`, 11]
  ])('%s resolves (resolver %i)', (path, index) => {
    expect(targetOf(path)).toEqual({ index, id: path.split('/')[3] });
  });

  it.each(['/api/auth/login', '/api/film-supply-orders/not-a-uuid/transitions', `/api/unknown/${ORDER}/x`])('%s is not a resolvable target', (path) => {
    expect(targetOf(path)).toBeNull();
  });
});

describe('expectedProjectMiddleware (M2)', () => {
  const allowAll = { signedIn: async () => true, mayOpen: async () => true };
  function appWith(projectId: string | null, access = allowAll) {
    const calls: string[] = [];
    const lookups: number[] = [];
    const app = new Hono();
    app.use('/api/*', expectedProjectMiddleware({ execute: async () => { lookups.push(1); return { rows: projectId ? [{ project_id: projectId }] : [] }; } }, access));
    app.post('/api/film-supply-orders/:id/transitions', (context) => { calls.push('written'); return context.json({ ok: true }); });
    return { app, calls, lookups };
  }
  const post = (app: Hono, header?: string) => app.request(`/api/film-supply-orders/${ORDER}/transitions`, {
    method: 'POST', headers: header ? { [EXPECTED_PROJECT_HEADER]: header } : {}, body: '{}'
  });

  it('refuses a write to another project with 409 PROJECT_CONTEXT_MISMATCH and never runs the handler', async () => {
    const { app, calls } = appWith(A);
    const answer = await post(app, B);
    expect(answer.status).toBe(409);
    expect((await answer.json() as { code: string }).code).toBe('PROJECT_CONTEXT_MISMATCH');
    expect(calls).toEqual([]);
  });

  it('lets the write through for the same project, without the header, or for an unknown target', async () => {
    for (const [project, header] of [[A, A], [A, undefined], [null, B]] as const) {
      const { app, calls } = appWith(project);
      expect((await post(app, header)).status).toBe(200);
      expect(calls).toEqual(['written']);
    }
  });

  it('review M1: without a session it answers 401 before anything about the target is read', async () => {
    const { app, calls, lookups } = appWith(A, { signedIn: async () => false, mayOpen: async () => true });
    const answer = await post(app, B);
    expect(answer.status).toBe(401);
    expect(lookups).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('review M1: a project the caller may not open is never confirmed — the handler answers as for a missing id', async () => {
    const { app, calls } = appWith(A, { signedIn: async () => true, mayOpen: async () => false });
    expect((await post(app, B)).status).toBe(200);
    expect(calls).toEqual(['written']);
  });

  it('never checks a read', async () => {
    const app = new Hono();
    app.use('/api/*', expectedProjectMiddleware({ execute: async () => ({ rows: [{ project_id: A }] }) }, allowAll));
    app.get('/api/film-supply-orders/:id/auto-advance', (context) => context.json({ ok: true }));
    expect((await app.request(`/api/film-supply-orders/${ORDER}/auto-advance`, { headers: { [EXPECTED_PROJECT_HEADER]: B } })).status).toBe(200);
  });
});

describe('P-4 self-verification on the staff screens', () => {
  const doc = { uploadedByUserId: 'u-creator', versions: [{ uploadedByUserId: 'u-v2' }] };
  it('staff: the creator or any version uploader is 「本人」', () => {
    expect(uploaderIdsOf(doc)).toEqual(['u-creator', 'u-v2']);
    expect(isOwnDocumentOfStaff('staff', 'u-creator', doc)).toBe(true);
    expect(isOwnDocumentOfStaff('staff', 'u-v2', doc)).toBe(true);
    expect(isOwnDocumentOfStaff('staff', 'u-other', doc)).toBe(false);
    expect(isOwnEvidenceOfStaff('staff', 'u-v2', 'u-v2')).toBe(true);
  });
  it('the representative may confirm their own evidence; nobody without an id is matched', () => {
    expect(isOwnDocumentOfStaff('admin', 'u-creator', doc)).toBe(false);
    expect(isOwnEvidenceOfStaff('admin', 'u-v2', 'u-v2')).toBe(false);
    expect(isOwnEvidenceOfStaff('staff', null, null)).toBe(false);
  });
});
