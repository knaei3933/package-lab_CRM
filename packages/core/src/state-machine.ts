export type ProjectState = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

const PROJECT_TRANSITIONS: Record<ProjectState, readonly ProjectState[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: []
};

export type TransitionResult<TFrom extends ProjectState, TTo extends ProjectState> =
  | { ok: true; from: TFrom; to: TTo }
  | { ok: false; from: ProjectState; to: ProjectState };

export function transitionProject<TFrom extends ProjectState, TTo extends ProjectState>(
  from: TFrom,
  to: TTo
): TransitionResult<TFrom, TTo> {
  const allowed = PROJECT_TRANSITIONS[from].includes(to);
  return allowed ? { ok: true, from, to } : { ok: false, from, to };
}
