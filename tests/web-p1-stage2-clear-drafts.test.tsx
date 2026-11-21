import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R34: draftKeyPrefix and ClearDrafts (the effect is run directly; no DOM here). */
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => { effect(); }
}));

const { ClearDrafts } = await import('../apps/web/src/components/ClearDrafts.js');
const { draftKey, draftKeyPrefix } = await import('../apps/web/src/lib/unsaved-guard.js');

class FakeStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  keys() { return [...this.map.keys()].sort(); }
}

const g = globalThis as unknown as { window?: unknown };
let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  g.window = { sessionStorage: storage };
});
afterEach(() => { delete g.window; });

describe('draftKeyPrefix', () => {
  it('is the screen path followed by a colon, shared by every form draft key of that screen', () => {
    expect(draftKeyPrefix('/p/A/new')).toBe('kanei-draft:/p/A/new:');
    expect(draftKey('/p/A/new', 'new-order').startsWith(draftKeyPrefix('/p/A/new'))).toBe(true);
    expect(draftKey('/p/A/new', 'lines').startsWith(draftKeyPrefix('/p/A/new'))).toBe(true);
  });

  it('does not match the drafts of a longer path that merely starts the same', () => {
    expect(draftKey('/p/A/newer', 'x').startsWith(draftKeyPrefix('/p/A/new'))).toBe(false);
  });
});

describe('ClearDrafts', () => {
  it('renders nothing', () => {
    expect(ClearDrafts({ pathname: '/p/A/o/X' })).toBeNull();
  });

  it('removes every draft of the given screen and keeps the others', () => {
    storage.setItem(draftKey('/p/A/o/X', 'proof'), '1');
    storage.setItem(draftKey('/p/A/o/X', 'approval'), '2');
    storage.setItem(draftKey('/p/A/o/XY', 'proof'), '3');
    storage.setItem(draftKey('/p/A/new', 'new-order'), '4');
    storage.setItem('unrelated', '5');
    ClearDrafts({ pathname: '/p/A/o/X' });
    expect(storage.keys()).toEqual([draftKey('/p/A/new', 'new-order'), draftKey('/p/A/o/XY', 'proof'), 'unrelated'].sort());
  });

  it('does nothing when there is no draft', () => {
    ClearDrafts({ pathname: '/p/A/o/X' });
    expect(storage.keys()).toEqual([]);
  });

  it('ignores blocked storage', () => {
    g.window = { get sessionStorage(): never { throw new Error('blocked'); } };
    expect(() => ClearDrafts({ pathname: '/p/A/o/X' })).not.toThrow();
  });
});
