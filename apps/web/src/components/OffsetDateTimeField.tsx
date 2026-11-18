'use client';

import { useEffect, useState } from 'react';
import { datetimeLocalToIso } from '../lib/datetime';
import { DateTimeInputs } from './DateTimeInputs';

interface OffsetDateTimeFieldProps {
  /** The form/API field name carrying the explicit-offset value. */
  name: string;
  label: string;
  required?: boolean | undefined;
  hint?: string | undefined;
  defaultValue?: string | undefined;
  /** Kept for call-site compatibility; the date and time inputs size themselves (UI batch C). */
  width?: number | undefined;
}

/**
 * Shows plain date and time text inputs (UI batch C: no locale-bound
 * datetime-local picker) while submits carry UTC ISO. The posted fields are
 * unchanged: hidden `name` = the browser-side UTC conversion, hidden
 * `${name}Local` = the datetime-local wall clock the server action falls back
 * to (as Asia/Tokyo) when the explicit value is empty.
 */
export function OffsetDateTimeField({ name, label, required, hint, defaultValue }: OffsetDateTimeFieldProps) {
  const [localValue, setLocalValue] = useState(defaultValue ?? '');
  // SSR must not convert a naive default using the server timezone. Keep the
  // hidden field empty until mounted; a pre-hydration submit uses the action's
  // Local fallback, which has explicit Asia/Tokyo semantics.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <>
      <input
        readOnly
        type="hidden"
        name={name}
        value={mounted ? datetimeLocalToIso(localValue) ?? '' : ''}
      />
      <input readOnly type="hidden" name={`${name}Local`} value={localValue} />
      {/* On the form's reset (after a successful record only, review H1) DateTimeInputs hands back the starting value (the default) through onChange. */}
      <DateTimeInputs name={name} label={label} required={required} hint={hint} value={localValue} onChange={setLocalValue} />
    </>
  );
}
