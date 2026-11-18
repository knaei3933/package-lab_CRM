import { HIDDEN_BY_ROLE_LABEL } from '../lib/redaction';
import { statusSymbol, statusTone } from '../lib/status-tone';
import type { StatusDomain, StatusTone } from '../lib/status-tone';

/**
 * UI batch C (2-⑤): the status badge — symbol + Japanese label on a tint of
 * the tone's token (globals.css .status-badge). The symbol is written out, so
 * the state reads the same without colour; the label is what a screen reader
 * announces. The stored code is never put in the markup.
 *
 * Pass `domain` + `status` to look the tone up (status `null` = withheld from
 * this role → hidden tone, label 「（閲覧権限なし）」), or `tone` directly.
 */
export function StatusBadge({
  label,
  domain,
  status,
  tone
}: {
  label?: string;
  domain?: StatusDomain;
  status?: string | null;
  tone?: StatusTone;
}) {
  const resolved: StatusTone = tone ?? (domain ? statusTone(domain, status) : 'neutral');
  const text = label ?? (resolved === 'hidden' ? HIDDEN_BY_ROLE_LABEL : status ?? '');
  return (
    <span className={`status-badge status-badge--${resolved}`}>
      <span className="status-badge-mark" aria-hidden="true">{statusSymbol(domain, status, resolved)}</span>
      {text}
    </span>
  );
}
