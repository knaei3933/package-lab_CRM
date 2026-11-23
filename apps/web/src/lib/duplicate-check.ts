import { webErrorText } from './error-dictionary';
import { isRouteCode, orderPath, scopeHref } from './project-route';
import { loadWorkspace } from './project-data';
import type { Workspace } from './project-data';
import type { ActionState } from './types';

/**
 * P0 R05 (H7): a create that collides with a registered number answers
 * 「この番号はすでに登録されています」 and a link to the registered record,
 * never 「サーバーエラー」.
 *
 * The API is the rule: p0-server answers a unique violation (23505) with
 * 409 DUPLICATE. Until that server change is live the API answers 500
 * INTERNAL_ERROR for the same collision, so after a refused create the web
 * looks the number up in the open project (read only) — a match means the
 * number is registered there and the refusal is shown as the duplicate it is.
 * A number the role may not read (seven-PO numbers are withheld from staff and
 * viewer) is never matched, so nothing is disclosed that the list would not show.
 */
export type DuplicateKind = 'seven_po' | 'film_order' | 'filling_order';

export const DUPLICATE_CODE = 'DUPLICATE';

/** Refusals that may be a unique-number collision: the server's own code, or the pre-p0-server 500. */
export function mayBeDuplicate(code: string | null | undefined, status: number): boolean {
  return code === DUPLICATE_CODE || code === 'INTERNAL_ERROR' || (code === null && status >= 500) || status === 409;
}

const ANCHOR: Record<DuplicateKind, (id: string) => string> = {
  seven_po: (id) => `/orders#seven-po-${id}`,
  film_order: (id) => `/orders#order-${id}`,
  filling_order: (id) => `/orders#filling-order-${id}`
};

const LINK_LABEL: Record<DuplicateKind, string> = {
  seven_po: '登録済みのセブン化学発注書を開く',
  film_order: '登録済みのフィルム発注を開く',
  filling_order: '登録済みの充填発注を開く'
};

/**
 * P4 H7②: the link names the registered record — its 発注コード (or 発注番号), not only its kind — so the
 * operator can tell it is the one they meant before opening it.
 */
export function duplicateLinkLabel(kind: DuplicateKind, value: string | null | undefined): string {
  const name = value?.trim() ?? '';
  if (name.length === 0 || name.length > 64) return LINK_LABEL[kind];
  const head = kind === 'seven_po' ? '登録済みのセブン化学発注書' : kind === 'film_order' ? '登録済みのフィルム発注' : '登録済みの充填発注';
  return `${head} ${name} を開く`;
}

/** The registered record with this number in the workspace (visible numbers only). Pure. */
export function findRegistered(workspace: Pick<Workspace, 'sevenPurchaseOrders' | 'filmOrders' | 'fillingOrders'>, kind: DuplicateKind, value: string): string | null {
  const wanted = value.trim();
  if (wanted.length === 0) return null;
  if (kind === 'seven_po') {
    return workspace.sevenPurchaseOrders.find((po) => !po.poNumberHidden && po.poNumber === wanted)?.id ?? null;
  }
  const orders = kind === 'film_order' ? workspace.filmOrders : workspace.fillingOrders;
  return orders.find((order) => order.code === wanted)?.id ?? null;
}

/** Where the link of a duplicate result points: the project the form was drawn for (P4 H7① / N6). */
export interface DuplicateScope {
  projectCode?: string | null | undefined;
  /** The number the operator typed: for a film order it is the order code, so the link opens its own screen. */
  value?: string | null | undefined;
}

/**
 * P4 H7①: the link to the registered record, always inside the project the form was drawn
 * for (never the remembered-project address). A film order opens its own screen
 * (/p/{案件}/o/{発注}); the others open that project's list at the record.
 */
export function duplicateHref(kind: DuplicateKind, existingId: string, scope: DuplicateScope = {}): string {
  const value = scope.value?.trim() ?? '';
  if (kind === 'film_order' && scope.projectCode && isRouteCode(scope.projectCode) && isRouteCode(value)) {
    return orderPath(scope.projectCode, value);
  }
  return scopeHref(scope.projectCode, ANCHOR[kind](existingId));
}

/** The duplicate result line, with the link when the registered record is known. Pure. */
export function duplicateState(kind: DuplicateKind, existingId: string | null, scope: DuplicateScope = {}): ActionState {
  const text = webErrorText(DUPLICATE_CODE);
  return {
    ok: false,
    message: text.message,
    messageKo: text.messageKo,
    code: DUPLICATE_CODE,
    link: existingId ? { href: duplicateHref(kind, existingId, scope), label: duplicateLinkLabel(kind, scope.value) } : null,
    // The number is registered: the submit is over (a new key for the next one).
    settled: true
  };
}

interface ServerExisting {
  id: string;
  projectId: string | null;
  projectCode: string | null;
}

/** p0-server 409 DUPLICATE: `existing: { id, projectId, projectCode }` (only for a project the caller may read). */
function existingFrom(data: unknown): ServerExisting | null {
  if (typeof data !== 'object' || data === null) return null;
  const existing = (data as { existing?: { id?: unknown; projectId?: unknown; projectCode?: unknown } }).existing;
  const id = existing?.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  return {
    id,
    projectId: typeof existing?.projectId === 'string' ? existing.projectId : null,
    projectCode: typeof existing?.projectCode === 'string' ? existing.projectCode.slice(0, 64) : null
  };
}

/** The duplicate is registered in another project: said, without a link into a project this screen is not on. */
export function otherProjectState(kind: DuplicateKind, projectCode: string | null): ActionState {
  const base = duplicateState(kind, null);
  return {
    ...base,
    message: projectCode
      ? `この番号は別の案件（${projectCode}）にすでに登録されています。番号を確認してください。`
      : 'この番号は別の案件にすでに登録されています。番号を確認してください。'
  };
}

/**
 * P4 H7①: the duplicate result from the 409 body alone (the new-order wizard's chain). The body's
 * `existing` names the record; it is linked only when it lives in the open project. Pure.
 */
export function duplicateFromAnswer(
  kind: DuplicateKind,
  data: unknown,
  scope: { projectId: string; projectCode: string | null; value: string }
): ActionState {
  const found = existingFrom(data);
  if (!found) return duplicateState(kind, null, scope);
  return found.projectId && found.projectId !== scope.projectId
    ? otherProjectState(kind, found.projectCode)
    : duplicateState(kind, found.id, scope);
}

/**
 * After a refused create: the duplicate result, or null when the refusal is
 * something else. Reads the project's list once (only on a refusal).
 */
export async function duplicateRefusal(input: {
  projectId: string;
  kind: DuplicateKind;
  value: string;
  status: number;
  code: string | null;
  data: unknown;
  /** The project the form was drawn for (hidden field `projectCode`), for the link. */
  projectCode?: string | null | undefined;
}): Promise<ActionState | null> {
  if (!mayBeDuplicate(input.code, input.status)) return null;
  const scope = { projectCode: input.projectCode ?? null, value: input.value };
  const fromServer = existingFrom(input.data);
  if (fromServer) {
    return fromServer.projectId && fromServer.projectId !== input.projectId
      ? otherProjectState(input.kind, fromServer.projectCode)
      : duplicateState(input.kind, fromServer.id, scope);
  }
  const workspace = await loadWorkspace(input.projectId);
  const found = findRegistered(workspace, input.kind, input.value);
  if (found) return duplicateState(input.kind, found, scope);
  return input.code === DUPLICATE_CODE ? duplicateState(input.kind, null, scope) : null;
}
