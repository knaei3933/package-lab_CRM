import { callApi } from './api';

/**
 * P4 N1: 担当の割り当て (p4-server REPORT §2-1). The API (admin only) lists, adds and removes a
 * project's assignments; the web shows them on the project overview, only to the representative.
 * The API decides every request (role, project, duplicates) — nothing here is a rule.
 *
 * p4/web3 (d): the representative picks the person by name from GET /api/assignable-users (server2 §1(1):
 * active staff / viewer / auditor only — every one of them is accepted by the POST). The 利用者ID field is
 * offered only when that list is cut short (`truncated`); the old detour (people of other projects + a pasted
 * ID) is gone. Both end in the same POST {userId}.
 */
export interface ProjectAssignment {
  id: string;
  userId: string;
  displayName: string;
  role: string;
  isActive: boolean;
  assignedAt: string | null;
}

export interface AssignmentCandidate {
  userId: string;
  displayName: string;
  role: string;
}

export interface AssignmentsView {
  assignments: ProjectAssignment[];
  assignableRoles: string[];
  /** Set when the list could not be read (said on the screen, never shown as 「担当者なし」). */
  error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value.trim());
}

/** The user to assign from the add form: the one picked from the list, else the typed 利用者ID. */
export function chosenUserId(formData: FormData): string | null {
  const read = (key: string) => {
    const value = formData.get(key);
    return typeof value === 'string' ? value.trim() : '';
  };
  const value = read('candidateUserId') || read('typedUserId');
  return isUserId(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pure: one assignment row of the API's answer. */
export function assignmentFrom(value: unknown): ProjectAssignment | null {
  const row = record(value);
  const userId = str(row.userId);
  const displayName = str(row.displayName);
  if (!userId || !displayName) return null;
  return {
    id: str(row.id) ?? userId,
    userId,
    displayName,
    role: str(row.role) ?? '',
    isActive: row.isActive !== false,
    assignedAt: str(row.assignedAt)
  };
}

/** Pure: GET …/assignments in the screen's shape. */
export function assignmentsFrom(data: unknown): Omit<AssignmentsView, 'error'> {
  const body = record(data);
  const list = Array.isArray(body.assignments) ? body.assignments : [];
  return {
    assignments: list.map(assignmentFrom).filter((row): row is ProjectAssignment => row !== null),
    assignableRoles: Array.isArray(body.assignableRoles) ? body.assignableRoles.filter((role): role is string => typeof role === 'string') : []
  };
}

export async function loadProjectAssignments(projectId: string): Promise<AssignmentsView> {
  const result = await callApi<unknown>(`/api/projects/${encodeURIComponent(projectId)}/assignments`);
  if (!result.ok) {
    return { assignments: [], assignableRoles: [], error: result.error ?? '担当者の一覧を読み込めませんでした。' };
  }
  return { ...assignmentsFrom(result.data), error: null };
}

/** p4/web3 (d): the people the representative can choose from (GET /api/assignable-users). */
export interface AssignableDirectory {
  candidates: AssignmentCandidate[];
  /** The server cut the list short: more people exist, the 利用者ID field is offered for them. */
  truncated: boolean;
  /** Set when the list could not be read (said on the screen; no form without it). */
  error: string | null;
}

/** Pure: the directory answer minus the people already assigned here, in the server's order (name, then id). */
export function assignableCandidatesFrom(data: unknown, here: readonly Pick<ProjectAssignment, 'userId'>[]): Omit<AssignableDirectory, 'error'> {
  const body = record(data);
  const roles = Array.isArray(body.assignableRoles) ? body.assignableRoles.filter((role): role is string => typeof role === 'string') : null;
  const taken = new Set(here.map((row) => row.userId));
  const seen = new Set<string>();
  const candidates: AssignmentCandidate[] = [];
  for (const entry of Array.isArray(body.users) ? body.users : []) {
    const row = record(entry);
    const userId = str(row.id);
    const displayName = str(row.displayName);
    const role = str(row.role);
    if (!userId || !isUserId(userId) || !displayName || !role || taken.has(userId) || seen.has(userId)) continue;
    if (roles && !roles.includes(role)) continue;
    seen.add(userId);
    candidates.push({ userId, displayName, role });
  }
  return { candidates, truncated: body.truncated === true };
}

/** p4/web3 (d): the directory (admin only — the overview asks only for the representative; the API answers 403 to anyone else). */
export async function loadAssignableDirectory(here: readonly Pick<ProjectAssignment, 'userId'>[]): Promise<AssignableDirectory> {
  const result = await callApi<unknown>('/api/assignable-users');
  if (!result.ok) return { candidates: [], truncated: false, error: result.error ?? '割り当てられる人の一覧を読み込めませんでした。' };
  return { ...assignableCandidatesFrom(result.data, here), error: null };
}

export const ASSIGNMENT_ROLE_LABELS: Readonly<Record<string, string>> = {
  staff: '担当者',
  viewer: '閲覧',
  auditor: '監査'
};
