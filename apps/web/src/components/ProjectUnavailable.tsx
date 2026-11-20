import { PROJECT_UNAVAILABLE_MESSAGE, RESELECT_PROJECT_HINT, RESELECT_PROJECT_LABEL } from '../lib/project-data';
import { projectSelectionHref } from '../lib/project-selection';
import { infoBoxStyle, noteStyle } from '../lib/ui';

/**
 * UI batch E (F-12): the screen body when the remembered project cannot be
 * opened (deleted, assignment removed). Only the way out is shown — the
 * project's forms would post into a project the API refuses. The API's own
 * reason follows in smaller print. Plain markup on purpose: it renders on the
 * non-pilot screens too, which must not load the Astryx bundle for it
 * (ASTRYX_EVAL §1 — non-pilot First Load JS unchanged).
 *
 * ui/fix-project-select: a project missing from the operator's list is now
 * forgotten before a screen renders (lib/project-selection), so this is left
 * for the API refusing a project the list still offered. 「案件を選び直す」
 * forgets it and opens the dashboard's project cards.
 */
export function ProjectUnavailable({ title, reason, returnTo = '/dashboard' }: { title: string; reason: string | null; returnTo?: string }) {
  return (
    <section style={{ display: 'grid', gap: 16 }}>
      <h1 style={{ fontSize: 26, margin: 0 }}>{title}</h1>
      <div style={infoBoxStyle}>
        <p style={{ margin: 0 }}>{PROJECT_UNAVAILABLE_MESSAGE}</p>
        <p style={{ margin: '12px 0 0' }}>
          <a className="dash-next-link" href={projectSelectionHref(returnTo, { reset: true })}>{RESELECT_PROJECT_LABEL}</a>
        </p>
        {/* Review L11: the API reason without the 「選び直してください」 hint already said above. */}
        {reason ? <p style={{ ...noteStyle, margin: '8px 0 0' }}>理由（システムの応答）: {reason.replace(RESELECT_PROJECT_HINT, '').trim()}</p> : null}
      </div>
    </section>
  );
}
