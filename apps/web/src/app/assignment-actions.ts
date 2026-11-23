'use server';

import { revalidatePath } from 'next/cache';
import { refusalState } from '../lib/action-result';
import { callApi } from '../lib/api';
import { chosenUserId, isUserId } from '../lib/assignments';
import { webErrorText } from '../lib/error-dictionary';
import { idempotencyKeyOf } from '../lib/project-context';
import { refuseIfProjectSwitched, writeProjectOf } from '../lib/project-guard';
import { rememberAssignmentRemoval } from '../lib/assignment-notice-server';
import type { ActionState } from '../lib/types';

/**
 * P4 N1: 担当者 of the open project — add and remove (p4-server REPORT §2-1). Thin adapters like every
 * other write: the rendered project and the per-submit key go with the request, and the API decides
 * (admin only → 403 CEO_ONLY for anyone else; an unknown or deactivated user → 422; a second
 * assignment → 409). The web sends nothing for a value that is not a user id.
 */
function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function noUser(): ActionState {
  const text = webErrorText('ASSIGNMENT_USER_REQUIRED');
  return { ok: false, message: text.message, messageKo: text.messageKo, code: 'ASSIGNMENT_USER_REQUIRED' };
}

export async function addAssignmentAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  const projectId = writeProjectOf(formData)!;
  const userId = chosenUserId(formData);
  if (!userId) {
    return field(formData, 'typedUserId').length > 0
      ? { ok: false, message: '利用者IDは、担当になる人の画面（「開ける案件がありません」）に出る英数字とハイフンの文字列です。一覧にない人だけ、そのまま貼り付けてください。' }
      : noUser();
  }
  const result = await callApi(`/api/projects/${encodeURIComponent(projectId)}/assignments`, {
    method: 'POST',
    body: { userId },
    idempotencyKey: idempotencyKeyOf(formData),
    expectedProjectId: projectId
  });
  if (!result.ok) return refusalState(result);
  revalidatePath('/', 'layout');
  return { ok: true, message: '担当者を割り当てました。この人は、すぐにこの案件を開けます。', changedId: userId };
}

export async function removeAssignmentAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  const projectId = writeProjectOf(formData)!;
  const userId = field(formData, 'userId');
  if (!isUserId(userId)) return noUser();
  const result = await callApi(`/api/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    idempotencyKey: idempotencyKeyOf(formData),
    expectedProjectId: projectId
  });
  if (!result.ok) return refusalState(result);
  // web2b review L-6: the row (and this result line) disappears — the panel's status line says it.
  await rememberAssignmentRemoval(projectId, userId);
  revalidatePath('/', 'layout');
  return { ok: true, message: '担当から外しました。この人は、この案件を開けなくなりました。', changedId: userId };
}
