import { webErrorText } from './error-dictionary';
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

/** The duplicate result line, with the link when the registered record is known. Pure. */
export function duplicateState(kind: DuplicateKind, existingId: string | null): ActionState {
  const text = webErrorText(DUPLICATE_CODE);
  return {
    ok: false,
    message: text.message,
    messageKo: text.messageKo,
    code: DUPLICATE_CODE,
    link: existingId ? { href: ANCHOR[kind](existingId), label: LINK_LABEL[kind] } : null
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
function otherProjectState(kind: DuplicateKind, projectCode: string | null): ActionState {
  const base = duplicateState(kind, null);
  return {
    ...base,
    message: projectCode
      ? `この番号は別の案件（${projectCode}）にすでに登録されています。番号を確認してください。`
      : 'この番号は別の案件にすでに登録されています。番号を確認してください。'
  };
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
}): Promise<ActionState | null> {
  if (!mayBeDuplicate(input.code, input.status)) return null;
  const fromServer = existingFrom(input.data);
  if (fromServer) {
    return fromServer.projectId && fromServer.projectId !== input.projectId
      ? otherProjectState(input.kind, fromServer.projectCode)
      : duplicateState(input.kind, fromServer.id);
  }
  const workspace = await loadWorkspace(input.projectId);
  const found = findRegistered(workspace, input.kind, input.value);
  if (found) return duplicateState(input.kind, found);
  return input.code === DUPLICATE_CODE ? duplicateState(input.kind, null) : null;
}
