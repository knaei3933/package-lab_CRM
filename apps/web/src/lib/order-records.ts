import { ACTION_LABELS } from './dashboard';
import type { AuditEventView } from './project-data';

/**
 * P1 R21: one line of the order screen's 記録 list — what was recorded, in the
 * screens' words, with the new state for a transition. Never an amount (the
 * audit read is the role's own answer; amounts are not read from it).
 */
export function orderRecordText(event: Pick<AuditEventView, 'action' | 'entityType' | 'afterState'>, stateLabel: (key: string) => string): string {
  const base = ACTION_LABELS[event.action] ?? '記録';
  const status = event.afterState && typeof event.afterState.status === 'string' ? event.afterState.status : null;
  if (event.entityType === 'film_supply_order' && status && event.action !== 'FILM_SUPPLY_ORDER_CREATED') {
    return `${base}（→「${stateLabel(status)}」）`;
  }
  return base;
}
