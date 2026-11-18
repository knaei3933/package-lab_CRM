import { PROJECT_UNAVAILABLE_MESSAGE } from '../lib/project-data';
import { infoBoxStyle, noteStyle } from '../lib/ui';

/**
 * UI batch E (F-12): the screen body when the remembered project cannot be
 * opened (deleted, assignment removed). Only the way out is shown — the
 * project's forms would post into a project the API refuses. The API's own
 * reason follows in smaller print.
 */
export function ProjectUnavailable({ title, reason }: { title: string; reason: string | null }) {
  return (
    <section style={{ display: 'grid', gap: 16 }}>
      <h1 style={{ fontSize: 26, margin: 0 }}>{title}</h1>
      <div style={infoBoxStyle}>
        <p style={{ margin: 0 }}>{PROJECT_UNAVAILABLE_MESSAGE}</p>
        {reason ? <p style={{ ...noteStyle, margin: '4px 0 0' }}>理由: {reason}</p> : null}
      </div>
    </section>
  );
}
