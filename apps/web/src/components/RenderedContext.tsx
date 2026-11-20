'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { RENDERED_PROJECT_FIELD } from '../lib/project-context';

/**
 * P0 R03/R09: what the screen was drawn with, handed from the root layout to
 * every form: the selected project (the hidden field the server action checks
 * against the cookie, B3) and whether the viewer is the representative (the
 * Korean auxiliary line of a refusal is shown to the representative only —
 * REDESIGN §4, policy P-7: the representative's screens first).
 */
export interface RenderedContextValue {
  projectId: string;
  showKorean: boolean;
}

const RenderedContext = createContext<RenderedContextValue | null>(null);

export function RenderedContextProvider({ value, children }: { value: RenderedContextValue; children: ReactNode }) {
  return <RenderedContext.Provider value={value}>{children}</RenderedContext.Provider>;
}

export function useRenderedContext(): RenderedContextValue | null {
  return useContext(RenderedContext);
}

/**
 * The hidden project field. Without the layout's context (a form rendered on
 * its own) it is left out, and the server action refuses the write.
 */
export function RenderedProjectField() {
  const context = useContext(RenderedContext);
  if (!context) return null;
  return <input type="hidden" readOnly name={RENDERED_PROJECT_FIELD} value={context.projectId} />;
}
