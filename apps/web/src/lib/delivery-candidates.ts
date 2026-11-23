/**
 * P4 M11: which film orders the delivery form offers by default. A delivery is
 * recorded once the film is shipped, so the form lists the shipped and the
 * delivered orders (a delivery can arrive in parts) — never the order that has
 * not shipped (it used to be the first of the list, and got the delivery).
 * An order whose status this role may not read (null) stays a candidate: the
 * API decides. Display only; the API still checks every write.
 */
export const FILM_DELIVERY_CANDIDATE_STATES: ReadonlySet<string> = new Set(['FILM_SHIPPED', 'FILM_DELIVERED']);

export function isFilmDeliveryCandidate(status: string | null): boolean {
  return status === null || FILM_DELIVERY_CANDIDATE_STATES.has(status);
}

export const NO_FILM_DELIVERY_CANDIDATE_NOTE = '出荷済みのフィルム発注がまだありません。発注の状態が「出荷済み」になると、ここで納品を記録できます。';
