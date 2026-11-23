import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FILM_SUPPLY_ORDER_EXCEPTION_STATES, FILM_SUPPLY_ORDER_STATES } from '@kanei/core';

/** P1 R28: one wording (lib/terms) — coverage, precedence, no legacy word on a screen, clean Korean. */
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session', PROJECT_COOKIE: 'kanei_web_project', apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token', readSelectedProjectId: async () => null, loadSessionUser: async () => null,
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { STANDARD_LABELS, LEGACY_TERMS, KO_LEGACY_TERMS, MENU_TERMS, standardTerm } = await import('../apps/web/src/lib/terms.js');
const { labelLookup } = await import('../apps/web/src/lib/project-data.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('STANDARD_LABELS covers the core states', () => {
  const states = [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES] as string[];

  it.each(states)('filmSupplyOrderStates has a Japanese and a Korean term for %s', (state) => {
    const term = STANDARD_LABELS.filmSupplyOrderStates[state];
    expect(term, state).toBeDefined();
    expect(term!.ja.length).toBeGreaterThan(0);
    expect(term!.ko.length).toBeGreaterThan(0);
  });

  it('has no Japanese label that is still an enum key', () => {
    for (const [key, term] of Object.entries(STANDARD_LABELS.filmSupplyOrderStates)) expect(term.ja, key).not.toMatch(/^[A-Z_]+$/);
  });

  it('standardTerm returns the row or null', () => {
    expect(standardTerm('filmSupplyOrderStates', 'DUAL_APPROVED')).toBe(STANDARD_LABELS.filmSupplyOrderStates.DUAL_APPROVED);
    expect(standardTerm('filmSupplyOrderStates', 'NOPE')).toBeNull();
  });
});

describe('labelLookup precedence: standard, then the API label, then the key', () => {
  const surface = { filmSupplyOrderStates: [{ key: 'DUAL_APPROVED', label: 'API旧称' }, { key: 'BRAND_NEW', label: 'APIだけの名称' }] } as never;

  it('prefers the standard wording over the API label', () => {
    expect(labelLookup(surface, 'filmSupplyOrderStates')('DUAL_APPROVED')).toBe(STANDARD_LABELS.filmSupplyOrderStates.DUAL_APPROVED!.ja);
  });
  it('uses the API label for a key the standard does not know', () => {
    expect(labelLookup(surface, 'filmSupplyOrderStates')('BRAND_NEW')).toBe('APIだけの名称');
  });
  it('falls back to the key when nobody knows it', () => {
    expect(labelLookup(surface, 'filmSupplyOrderStates')('UNKNOWN_KEY')).toBe('UNKNOWN_KEY');
  });
  it('still gives the standard wording when the label surface could not be read', () => {
    expect(labelLookup(null, 'filmSupplyOrderStates')('DRAFT')).toBe('下書き');
  });
});

describe('no legacy word on a screen', () => {
  // P4 M16: lib/ is scanned too (the error dictionary, guide and labels are screen text). Not scanned:
  // terms.ts (it defines the legacy list) and eml-form.ts (the subject of the mail that goes OUT to the
  // maker keeps 「製造先発注書」, §4-4).
  const OUTBOUND_OR_DEFINITION = new Set(['terms.ts', 'eml-form.ts']);
  const files = ['screens', 'components', 'app', 'lib']
    .flatMap((dir) => sources(path.join(root, dir)))
    .filter((file) => !OUTBOUND_OR_DEFINITION.has(path.basename(file)));

  it('scans the screen sources', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((file) => file.endsWith(`${path.sep}lib${path.sep}error-dictionary-data.ts`))).toBe(true);
  });

  it('covers the words the audit found on the old screens', () => {
    const legacy = LEGACY_TERMS.map(([word]) => word);
    for (const word of ['セブン発注書', '真性確認', 'ダブル承認', '二重承認', '手動送信', '受領確認（問題なしとみなす）']) expect(legacy).toContain(word);
  });

  it.each(KO_LEGACY_TERMS.map(([legacy]) => legacy))('%s (Korean) appears in no source — メーカー is 제조사', (legacy) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(legacy)).map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it.each(LEGACY_TERMS.map(([legacy]) => legacy))('%s appears in no screen, component or route source', (legacy) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(legacy)).map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});

describe('Korean terms are Hangul (no kana or kanji outside 「」 quotes)', () => {
  const rows: Array<[string, string]> = [
    ...Object.entries(STANDARD_LABELS).flatMap(([surface, entries]) => Object.entries(entries).map(([key, term]): [string, string] => [`${surface}.${key}`, term.ko])),
    ...Object.entries(MENU_TERMS).map(([key, term]): [string, string] => [`menu ${key}`, term.ko])
  ];

  it.each(rows)('%s', (_name, ko) => {
    const outsideQuotes = ko.replace(/「[^」]*」/g, '');
    expect(outsideQuotes).not.toMatch(/[぀-ヿ一-鿿]/);
    expect(ko.length).toBeGreaterThan(0);
  });
});
