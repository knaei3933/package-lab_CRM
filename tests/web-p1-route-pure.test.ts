import { describe, expect, it } from 'vitest';
import {
  decodeRouteCode,
  isRouteCode,
  legacyScreenOf,
  newOrderPath,
  orderPath,
  parseProjectPath,
  projectPath,
  scopeHref,
  unscopedPath
} from '../apps/web/src/lib/project-route.js';

/** P1 R20: the pure URL helpers (project and order codes in the address). */

describe('isRouteCode', () => {
  it.each(['P-001', 'FSO_2026.11', '案件A', 'ｐｒｏｊ１', 'a', 'A'.repeat(64)])('accepts %s', (code) => {
    expect(isRouteCode(code)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['a slash', 'a/b'],
    ['a leading slash', '/'],
    ['a space', 'a b'],
    ['a full-width space', 'a　b'],
    ['dot dot', '..'],
    ['a single dot', '.'],
    ['a newline', 'a\nb'],
    ['a NUL', 'a\u0000b'],
    ['a tab', 'a\tb'],
    ['a percent sign', 'a%2Fb'],
    ['a question mark', 'a?b'],
    ['a hash', 'a#b'],
    ['a backslash', 'a\\b'],
    ['an emoji', 'a😀'],
    ['65 characters', 'A'.repeat(65)]
  ])('refuses %s', (_name, code) => {
    expect(isRouteCode(code)).toBe(false);
  });

  it.each([null, undefined, 12, {}, ['a']])('refuses a non-string (%s)', (value) => {
    expect(isRouteCode(value)).toBe(false);
  });

  it('accepts dots inside a longer code, only "." and ".." alone are refused', () => {
    expect(isRouteCode('a..b')).toBe(true);
    expect(isRouteCode('...')).toBe(true);
  });
});

describe('decodeRouteCode', () => {
  it('decodes a percent-encoded Japanese code once', () => {
    expect(decodeRouteCode(encodeURIComponent('案件A'))).toBe('案件A');
  });

  it('returns a plain code unchanged', () => {
    expect(decodeRouteCode('P-001')).toBe('P-001');
  });

  it.each(['%', '%E0%A4%A', '%ZZ', 'abc%'])('returns null for a bad escape (%s)', (segment) => {
    expect(decodeRouteCode(segment)).toBeNull();
  });

  it('returns null when the decoded text hides a slash (%2F)', () => {
    expect(decodeRouteCode('a%2Fb')).toBeNull();
  });

  it('returns null for an encoded space, dot-dot and control character', () => {
    expect(decodeRouteCode('a%20b')).toBeNull();
    expect(decodeRouteCode('%2E%2E')).toBeNull();
    expect(decodeRouteCode('a%00b')).toBeNull();
  });

  it('does not decode twice (%252F stays a percent sign and is refused)', () => {
    expect(decodeRouteCode('a%252Fb')).toBeNull();
  });

  it.each([null, undefined, 5])('returns null for a non-string (%s)', (value) => {
    expect(decodeRouteCode(value)).toBeNull();
  });
});

describe('projectPath / orderPath / newOrderPath', () => {
  it('builds the project overview address', () => {
    expect(projectPath('P-001')).toBe('/p/P-001');
  });

  it('appends the rest and drops its leading slashes', () => {
    expect(projectPath('P-001', 'orders')).toBe('/p/P-001/orders');
    expect(projectPath('P-001', '//orders')).toBe('/p/P-001/orders');
  });

  it('percent-encodes a Japanese code and parses back to the same code', () => {
    const built = projectPath('案件A', 'orders');
    expect(built).toBe(`/p/${encodeURIComponent('案件A')}/orders`);
    expect(parseProjectPath(built)?.projectCode).toBe('案件A');
  });

  it('builds the order address and an integer step deep link', () => {
    expect(orderPath('P-1', 'FSO-1')).toBe('/p/P-1/o/FSO-1');
    expect(orderPath('P-1', 'FSO-1', 6)).toBe('/p/P-1/o/FSO-1?step=6');
  });

  it('ignores a step that is not an integer', () => {
    expect(orderPath('P-1', 'FSO-1', 1.5)).toBe('/p/P-1/o/FSO-1');
    expect(orderPath('P-1', 'FSO-1', null)).toBe('/p/P-1/o/FSO-1');
  });

  it('builds the wizard address', () => {
    expect(newOrderPath('P-1')).toBe('/p/P-1/new');
  });
});

describe('parseProjectPath', () => {
  it('reads the project overview', () => {
    expect(parseProjectPath('/p/P-1')).toEqual({ projectCode: 'P-1', rest: '', orderCode: null });
  });

  it('reads an order address', () => {
    expect(parseProjectPath('/p/P-1/o/FSO-9')).toEqual({ projectCode: 'P-1', rest: 'o/FSO-9', orderCode: 'FSO-9' });
  });

  it('reads a list screen and has no order code', () => {
    expect(parseProjectPath('/p/P-1/orders')).toEqual({ projectCode: 'P-1', rest: 'orders', orderCode: null });
  });

  it('ignores a trailing slash, a query and a hash', () => {
    expect(parseProjectPath('/p/P-1/orders/')?.rest).toBe('orders');
    expect(parseProjectPath('/p/P-1/orders?x=1#a')?.rest).toBe('orders');
    expect(parseProjectPath('/p/P-1?x=1')?.rest).toBe('');
  });

  it('has no order code when the order segment is not a route code', () => {
    expect(parseProjectPath('/p/P-1/o/a%20b')?.orderCode).toBeNull();
  });

  it.each(['/', '/p', '/p/', '/orders', '/projects/P-1', '/dashboard', '/px/P-1', '/guide'])('returns null for non-matching %s', (pathname) => {
    expect(parseProjectPath(pathname)).toBeNull();
  });

  it('returns null when the project segment is not a valid code', () => {
    expect(parseProjectPath('/p/a%2Fb/orders')).toBeNull();
    expect(parseProjectPath('/p/%E0%A4%A')).toBeNull();
    expect(parseProjectPath('/p/../orders')).toBeNull();
  });

  it.each([null, undefined])('returns null for %s', (pathname) => {
    expect(parseProjectPath(pathname)).toBeNull();
  });
});

describe('scopeHref', () => {
  it('places a legacy screen link under the project and keeps the hash', () => {
    expect(scopeHref('P-1', '/orders#order-abc')).toBe('/p/P-1/orders#order-abc');
  });

  it('keeps the query string', () => {
    expect(scopeHref('P-1', '/documents?download=d1')).toBe('/p/P-1/documents?download=d1');
  });

  it('scopes every former screen', () => {
    for (const screen of ['orders', 'documents', 'approvals', 'maker-po', 'deliveries']) {
      expect(scopeHref('P-1', `/${screen}`)).toBe(`/p/P-1/${screen}`);
    }
  });

  it('turns /dashboard into the project overview', () => {
    expect(scopeHref('P-1', '/dashboard')).toBe('/p/P-1');
  });

  it('leaves the guide, external and already scoped links alone', () => {
    expect(scopeHref('P-1', '/guide')).toBe('/guide');
    expect(scopeHref('P-1', 'https://example.com/orders')).toBe('https://example.com/orders');
    expect(scopeHref('P-1', '/p/P-2/orders')).toBe('/p/P-2/orders');
    expect(scopeHref('P-1', '#top')).toBe('#top');
  });

  it('does not treat a longer path that merely starts with a screen name as that screen', () => {
    expect(scopeHref('P-1', '/orders-archive')).toBe('/orders-archive');
    expect(scopeHref('P-1', '/orders/1')).toBe('/orders/1');
  });

  it('returns the link unchanged without a usable project code', () => {
    expect(scopeHref(null, '/orders')).toBe('/orders');
    expect(scopeHref(undefined, '/orders')).toBe('/orders');
    expect(scopeHref('a/b', '/orders')).toBe('/orders');
  });
});

describe('legacyScreenOf / unscopedPath', () => {
  it('names the legacy screen of an old address', () => {
    expect(legacyScreenOf('/orders')).toBe('orders');
    expect(legacyScreenOf('/maker-po')).toBe('maker-po');
    expect(legacyScreenOf('/orders?x=1')).toBe('orders');
  });

  it('returns null for any other path', () => {
    expect(legacyScreenOf('/dashboard')).toBeNull();
    expect(legacyScreenOf('/p/P-1/orders')).toBeNull();
    expect(legacyScreenOf('/orders-x')).toBeNull();
  });

  it('maps a scoped list screen and the overview back to their legacy paths', () => {
    expect(unscopedPath('/p/P-1/orders')).toBe('/orders');
    expect(unscopedPath('/p/P-1/maker-po')).toBe('/maker-po');
    expect(unscopedPath('/p/P-1')).toBe('/dashboard');
  });

  it('has no legacy path for the order screen and the wizard', () => {
    expect(unscopedPath('/p/P-1/o/FSO-1')).toBeNull();
    expect(unscopedPath('/p/P-1/new')).toBeNull();
  });

  it('returns other paths as they are and null for null', () => {
    expect(unscopedPath('/guide')).toBe('/guide');
    expect(unscopedPath(null)).toBeNull();
  });
});
