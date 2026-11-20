/**
 * P0 R06 (H1): the browser event a form sends after a successful write. The
 * layout's SavedRecordRefresher refreshes the screen (router.refresh) and
 * highlights the changed row (data-record-id) once it is there. Client-safe.
 */
export const SAVED_RECORD_EVENT = 'kanei:record-saved';

export interface SavedRecordDetail {
  changedId: string | null;
}

export const RECORD_ID_ATTRIBUTE = 'data-record-id';
export const CHANGED_ROW_CLASS = 'record-changed';

/** The CSS selector of the row (or card) carrying a record id. Ids are UUIDs; anything else matches nothing. */
export function recordSelector(id: string): string | null {
  return /^[0-9A-Za-z_-]{1,64}$/.test(id) ? `[${RECORD_ID_ATTRIBUTE}="${id}"]` : null;
}

/**
 * P0 R05: the in-flight lock of one form, outside React state — a second
 * click in the same tick (before React re-renders with pending) is dropped.
 * Released when a new result arrives or the action stops running.
 */
export interface SubmitInFlight {
  readonly busy: boolean;
  /** true when this submit may run (and the lock is now held). */
  acquire(currentResult: unknown): boolean;
  /** Called on every render: a new result object, or pending going true→false, releases the lock. */
  observe(result: unknown, pending: boolean): void;
}

export function createSubmitInFlight(): SubmitInFlight {
  let busy = false;
  let heldSince: unknown = undefined;
  let sawPending = false;
  return {
    get busy() {
      return busy;
    },
    acquire(currentResult) {
      if (busy) return false;
      busy = true;
      heldSince = currentResult;
      sawPending = false;
      return true;
    },
    observe(result, pending) {
      if (!busy) return;
      if (pending) {
        sawPending = true;
        return;
      }
      if (result !== heldSince || sawPending) {
        busy = false;
        sawPending = false;
      }
    }
  };
}
