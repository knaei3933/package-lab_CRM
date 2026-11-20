import { readSelectedProjectId } from './api';
import { webErrorText } from './error-dictionary';
import { PROJECT_CONTEXT_MISMATCH, RENDERED_PROJECT_FIELD, renderedProjectMatches } from './project-context';
import type { ActionState } from './types';

/**
 * P0 R03 (B3): the server half. The selected project lives in one host-wide
 * cookie, so a tab drawn for 案件A posts while the cookie (switched in another
 * tab) names 案件B. Every write action calls this first: when the form's
 * hidden RENDERED_PROJECT_FIELD differs from the cookie the write is refused
 * before anything is sent to the API, with 「別のタブで案件が切り替わりました」.
 * Order-scoped writes also carry their orderId (they post to the order's own
 * endpoint), and the project check stops a stale tab's write of either kind.
 */
export async function refuseIfProjectSwitched(formData: FormData): Promise<ActionState | null> {
  const current = await readSelectedProjectId();
  if (renderedProjectMatches(formData.get(RENDERED_PROJECT_FIELD), current)) return null;
  const text = webErrorText(PROJECT_CONTEXT_MISMATCH);
  return { ok: false, message: text.message, messageKo: text.messageKo, code: PROJECT_CONTEXT_MISMATCH };
}
