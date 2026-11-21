import { sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';

/**
 * P1 integration (verifier M2, API_CONTRACT §0 expectedProjectId widened to every
 * write): the web sends the project its screen was drawn for in the
 * `X-Kanei-Expected-Project` header on every write. Before the handler runs, the
 * project of the write's target (read from the route's id: order, PO, document,
 * revision, event, delivery …) is compared with it; a different project is refused
 * with 409 PROJECT_CONTEXT_MISMATCH and nothing is written. Without the header,
 * or for an id this table cannot resolve, the handler decides as before (its own
 * 404/403). The assignment and role checks of every handler are unchanged.
 */
export const EXPECTED_PROJECT_HEADER = 'x-kanei-expected-project';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Execute = (query: ReturnType<typeof sql>) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** Route prefix → the SQL that returns the target's project_id for its first id parameter. */
const RESOLVERS: ReadonlyArray<{ pattern: RegExp; query: (id: string) => ReturnType<typeof sql> }> = [
  { pattern: /^\/api\/projects\/([^/]+)\//, query: (id) => sql`select id as project_id from projects where id = ${id}` },
  { pattern: /^\/api\/film-supply-orders\/([^/]+)\//, query: (id) => sql`select project_id from film_supply_orders where id = ${id}` },
  { pattern: /^\/api\/seven-purchase-orders\/([^/]+)\//, query: (id) => sql`select project_id from seven_purchase_orders where id = ${id}` },
  { pattern: /^\/api\/pre-order-references\/([^/]+)\//, query: (id) => sql`select project_id from pre_order_references where id = ${id}` },
  { pattern: /^\/api\/filling-orders\/([^/]+)\//, query: (id) => sql`select project_id from filling_orders where id = ${id}` },
  { pattern: /^\/api\/documents\/([^/]+)\//, query: (id) => sql`select project_id from documents where id = ${id}` },
  {
    pattern: /^\/api\/maker-purchase-orders\/([^/]+)\//,
    query: (id) => sql`select o.project_id from maker_purchase_orders p join film_supply_orders o on o.id = p.film_supply_order_id where p.id = ${id}`
  },
  {
    pattern: /^\/api\/maker-po-events\/([^/]+)\//,
    query: (id) => sql`select o.project_id from maker_po_events e join maker_purchase_orders p on p.id = e.maker_purchase_order_id join film_supply_orders o on o.id = p.film_supply_order_id where e.id = ${id}`
  },
  {
    pattern: /^\/api\/artwork-revisions\/([^/]+)\//,
    query: (id) => sql`select o.project_id from artwork_revisions r join film_supply_orders o on o.id = r.film_supply_order_id where r.id = ${id}`
  },
  {
    pattern: /^\/api\/artwork-approval-events\/([^/]+)\//,
    query: (id) => sql`select o.project_id from artwork_approval_events a join artwork_revisions r on r.id = a.artwork_revision_id join film_supply_orders o on o.id = r.film_supply_order_id where a.id = ${id}`
  },
  {
    pattern: /^\/api\/film-deliveries\/([^/]+)\//,
    query: (id) => sql`select o.project_id from film_deliveries d join film_supply_orders o on o.id = d.film_supply_order_id where d.id = ${id}`
  },
  {
    pattern: /^\/api\/filling-deliveries\/([^/]+)\//,
    query: (id) => sql`select o.project_id from filling_deliveries d join filling_orders o on o.id = d.filling_order_id where d.id = ${id}`
  }
];

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Pure: the resolver and id for a write path, or null (not a resolvable target). */
export function targetOf(path: string): { index: number; id: string } | null {
  for (const [index, resolver] of RESOLVERS.entries()) {
    const match = resolver.pattern.exec(path);
    if (match && UUID.test(match[1]!)) return { index, id: match[1]! };
  }
  return null;
}

/**
 * Review M1: who is asking, decided before anything about the target is looked up.
 * - anonymous: no valid session → 401, nothing is read about the target;
 * - a project the caller may not open: the middleware says nothing (the handler answers
 *   as it always did), so an existing-but-unassigned id and a missing id look the same.
 */
export interface ProjectAccess {
  signedIn(request: Request): Promise<boolean>;
  mayOpen(request: Request, projectId: string): Promise<boolean>;
}

export function expectedProjectMiddleware(db: { execute: Execute }, access: ProjectAccess): MiddlewareHandler {
  return async (context, next) => {
    const expected = context.req.header(EXPECTED_PROJECT_HEADER);
    if (!expected || !WRITE_METHODS.has(context.req.method)) return next();
    const target = targetOf(context.req.path);
    if (!target) return next();
    if (!(await access.signedIn(context.req.raw))) {
      return context.json({ error: '認証が必要です', code: 'AUTH_REQUIRED' }, 401);
    }
    const result = await db.execute(RESOLVERS[target.index]!.query(target.id));
    const projectId = result.rows[0]?.project_id;
    if (typeof projectId === 'string' && projectId !== expected && (await access.mayOpen(context.req.raw, projectId))) {
      return context.json({
        error: '別のタブで案件が切り替わりました。保存していません。画面を再読み込みしてください',
        code: 'PROJECT_CONTEXT_MISMATCH'
      }, 409);
    }
    return next();
  };
}
