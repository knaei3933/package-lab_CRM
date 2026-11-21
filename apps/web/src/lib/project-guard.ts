import { webErrorText } from './error-dictionary';
import { PROJECT_CONTEXT_MISMATCH, RENDERED_PROJECT_FIELD, renderedProjectOf } from './project-context';
import type { ActionState } from './types';

/**
 * P0 R03 (B3) → P1 R20: the server half. Every write form carries the project
 * its screen was drawn for (the /p/{案件コード} of the URL, RENDERED_PROJECT_FIELD),
 * and a write is sent to THAT project — never to whatever a cookie names now.
 * So a tab drawn for 案件A writes to 案件A even after another tab opened 案件B
 * (B3 resolved at the root: there is no shared "selected project" a tab could
 * switch). A form without the field, with an empty or malformed one, is refused
 * before anything reaches the API — fail closed, as before.
 */
export async function refuseIfProjectSwitched(formData: FormData): Promise<ActionState | null> {
  if (renderedProjectOf(formData.get(RENDERED_PROJECT_FIELD)) !== null) return null;
  const text = webErrorText(PROJECT_CONTEXT_MISMATCH);
  return { ok: false, message: text.message, messageKo: text.messageKo, code: PROJECT_CONTEXT_MISMATCH };
}

/** The project a write goes to: the rendered (URL) project of the form, or null. */
export function writeProjectOf(formData: FormData): string | null {
  return renderedProjectOf(formData.get(RENDERED_PROJECT_FIELD));
}
