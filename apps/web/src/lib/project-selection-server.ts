import { redirect } from 'next/navigation';
import { readSelectedProjectId } from './api';
import { loadSelectableProjectList } from './project-data';
import { decideProjectSelection, projectSelectionHref } from './project-selection';
import type { ProjectSelection } from './project-selection';

/**
 * ui/fix-project-select: the project a screen works on. A server component
 * cannot write cookies, so when the remembered choice must change (forgotten
 * because it can no longer be opened, or the operator's only project opened
 * for them) the screen hands over to the /project-selection route, which
 * writes the cookie and comes straight back. The list read is shared with the
 * layout's selector (React cache), so a valid choice costs no extra request.
 */
export async function projectSelectionFor(returnTo: string): Promise<ProjectSelection> {
  const [remembered, list] = await Promise.all([readSelectedProjectId(), loadSelectableProjectList()]);
  const decision = decideProjectSelection(remembered, list);
  if (decision.cookie !== undefined) redirect(projectSelectionHref(returnTo));
  return decision.selection;
}

/** The open project's id, or null when the operator still has to choose (or has none). */
export async function openProjectIdFor(returnTo: string): Promise<string | null> {
  const selection = await projectSelectionFor(returnTo);
  return selection.kind === 'open' ? selection.projectId : null;
}
