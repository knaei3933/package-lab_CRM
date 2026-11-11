/**
 * M1 units vocabulary (design section 5).
 *
 * Film and filling live in separate unit domains. A quantity is always recorded
 * together with its unit, and a unit is always validated against the domain of
 * the table it is written to. Mixing across the film/filling boundary is a
 * validation error (HTTP 422), never a silent conversion.
 */
export const FILM_UNITS = ['rolls', 'meters', 'sheets'] as const;
export const FILLING_UNITS = ['pods', 'pieces'] as const;
export const MEASURE_UNITS = [...FILM_UNITS, ...FILLING_UNITS] as const;

export type FilmUnit = (typeof FILM_UNITS)[number];
export type FillingUnit = (typeof FILLING_UNITS)[number];
export type MeasureUnit = (typeof MEASURE_UNITS)[number];
export type UnitDomain = 'film' | 'filling';

export type UnitValidation =
  | { ok: true; unit: MeasureUnit; domain: UnitDomain }
  | { ok: false; code: 'UNKNOWN_UNIT' | 'UNIT_DOMAIN_MISMATCH'; message: string };

export function isFilmUnit(unit: MeasureUnit): unit is FilmUnit {
  return (FILM_UNITS as readonly string[]).includes(unit);
}

export function unitDomainOf(unit: MeasureUnit): UnitDomain {
  return isFilmUnit(unit) ? 'film' : 'filling';
}

/**
 * Validates a raw request value against the unit vocabulary and the domain of
 * the table being written. Cross-domain units are rejected with
 * UNIT_DOMAIN_MISMATCH so they can never reach a line or delivery row.
 */
export function validateUnit(value: unknown, domain: UnitDomain): UnitValidation {
  if (typeof value !== 'string' || !(MEASURE_UNITS as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_UNIT',
      message: `unit must be one of ${MEASURE_UNITS.join(', ')}; received ${String(value)}`
    };
  }
  const unit = value as MeasureUnit;
  const actual = unitDomainOf(unit);
  if (actual !== domain) {
    return {
      ok: false,
      code: 'UNIT_DOMAIN_MISMATCH',
      message: `unit ${unit} belongs to the ${actual} vocabulary and cannot be used on a ${domain} record`
    };
  }
  return { ok: true, unit, domain: actual };
}

export const MAX_QUANTITY = 999_999_999_999.999;

export type QuantityValidation =
  | { ok: true; quantity: number }
  | { ok: false; code: 'INVALID_QUANTITY'; message: string };

/**
 * Quantities are stored as numeric(14,3) and never re-derived from another row.
 * Zero, negative, and non-finite quantities are rejected before persistence.
 */
export function validateQuantity(value: unknown): QuantityValidation {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) {
    return {
      ok: false,
      code: 'INVALID_QUANTITY',
      message: `quantity must be a positive number up to ${MAX_QUANTITY}; received ${String(value)}`
    };
  }
  return { ok: true, quantity: value };
}

/** Canonical numeric(14,3) text used for every persisted quantity. */
export function toQuantityString(quantity: number): string {
  return quantity.toFixed(3);
}
