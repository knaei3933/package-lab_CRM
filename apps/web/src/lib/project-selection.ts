import type { ProjectSummary } from './project-data';

/**
 * ui/fix-project-select: which project a screen opens, decided from the
 * remembered choice (the kanei_web_project cookie) and the projects the API
 * lets this operator open (GET /api/projects — admin: every live project,
 * others: their assigned live projects; the same rule GET /api/projects/:id
 * applies). Pure, so the dashboard, the other screens and the
 * /project-selection route agree on one answer.
 *
 * - A remembered project that is in the list is opened.
 * - A remembered project that is not in the list (deleted, unassigned, left
 *   over from another server on the same host — cookies are per host, not per
 *   port) is forgotten without a message.
 * - With nothing (left) remembered: exactly one project is opened for the
 *   operator, several are offered as cards, none is explained.
 * - When the list itself could not be read nothing is judged: a remembered
 *   project stays (the screen's own read reports the problem), and without one
 *   the screen says the list failed.
 */
export type ProjectSelection =
  | { kind: 'open'; projectId: string }
  | { kind: 'choose'; projects: ProjectSummary[] }
  | { kind: 'none' }
  | { kind: 'list-failed'; error: string };

export interface ProjectSelectionDecision {
  selection: ProjectSelection;
  /** The value the cookie must hold afterwards: a project id, null (delete) or undefined (leave as is). */
  cookie: string | null | undefined;
}

export function decideProjectSelection(
  rememberedId: string | null | undefined,
  list: { projects: ProjectSummary[]; error: string | null }
): ProjectSelectionDecision {
  const remembered = typeof rememberedId === 'string' && rememberedId.length > 0 ? rememberedId : null;
  if (list.error !== null) {
    return remembered
      ? { selection: { kind: 'open', projectId: remembered }, cookie: undefined }
      : { selection: { kind: 'list-failed', error: list.error }, cookie: undefined };
  }
  const projects = list.projects.filter((project) => typeof project?.id === 'string' && project.id.length > 0);
  if (remembered && projects.some((project) => project.id === remembered)) {
    return { selection: { kind: 'open', projectId: remembered }, cookie: undefined };
  }
  const forget = remembered ? null : undefined;
  if (projects.length === 1) return { selection: { kind: 'open', projectId: projects[0]!.id }, cookie: projects[0]!.id };
  if (projects.length === 0) return { selection: { kind: 'none' }, cookie: forget };
  return { selection: { kind: 'choose', projects }, cookie: forget };
}

/** The route that writes the decision into the cookie and sends the operator back. */
export const PROJECT_SELECTION_PATH = '/project-selection';

/** Screens the route may send the operator back to (never an outside address). */
export const PROJECT_SELECTION_RETURN_PATHS = ['/dashboard', '/orders', '/documents', '/approvals', '/maker-po', '/deliveries'] as const;

export function safeReturnPath(value: string | null | undefined): string {
  return (PROJECT_SELECTION_RETURN_PATHS as readonly string[]).includes(value ?? '') ? (value as string) : '/dashboard';
}

/** `/project-selection?next=…` — `reset` forgets the remembered project first (「案件を選び直す」). */
export function projectSelectionHref(returnTo: string, options: { reset?: boolean } = {}): string {
  const params = new URLSearchParams({ next: safeReturnPath(returnTo) });
  if (options.reset) params.set('reset', '1');
  return `${PROJECT_SELECTION_PATH}?${params.toString()}`;
}
