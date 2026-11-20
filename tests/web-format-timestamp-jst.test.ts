import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISPLAY_TIME_ZONE, formatTimestamp } from '../apps/web/src/lib/vocabulary.js';

/**
 * UI batch A (P1-5): displayed timestamps are JST with an explicit 「JST」,
 * whatever TZ the web server process runs in (the NAS host is UTC).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vocabularyUrl = pathToFileURL(path.join(repoRoot, 'apps/web/src/lib/vocabulary.ts')).href;

const SAMPLES = [
  '2026-11-18T01:05:00.000Z', // 10:05 JST
  '2026-11-17T15:30:00Z', // crosses midnight → 11/18 00:30 JST
  '2026-11-18T10:05:00+09:00', // an offset-qualified API value
  '2026-12-31T23:59:00Z' // crosses the year in JST
];

function formatInChildProcess(tz: string): string[] {
  // apps/web has no "type":"module", so tsx loads vocabulary.ts as CJS in this
  // eval context and the named exports arrive under `default`; accept both.
  const script = `const mod = await import(${JSON.stringify(vocabularyUrl)});
const m = typeof mod.formatTimestamp === 'function' ? mod : mod.default;
process.stdout.write(JSON.stringify(${JSON.stringify(SAMPLES)}.map((v) => m.formatTimestamp(v))));`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    timeout: 30_000
  });
  return JSON.parse(output) as string[];
}

describe('formatTimestamp (UI batch A, P1-5)', () => {
  it('renders in Asia/Tokyo with a JST suffix', () => {
    expect(DISPLAY_TIME_ZONE).toBe('Asia/Tokyo');
    expect(formatTimestamp('2026-11-18T01:05:00.000Z')).toBe('2026/11/18 10:05 JST');
    expect(formatTimestamp('2026-11-18T10:05:00+09:00')).toBe('2026/11/18 10:05 JST');
  });

  it('uses the JST calendar day and a 00-23 hour across midnight and the year end', () => {
    expect(formatTimestamp('2026-11-17T15:30:00Z')).toBe('2026/11/18 00:30 JST');
    expect(formatTimestamp('2026-12-31T23:59:00Z')).toBe('2027/01/01 08:59 JST');
  });

  it('keeps the dash for empty or non-string input and passes unparseable text through', () => {
    expect(formatTimestamp('')).toBe('—');
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(undefined)).toBe('—');
    expect(formatTimestamp(1700000000000)).toBe('—');
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('gives identical output when the server process runs with TZ=UTC or another zone', () => {
    const expected = [
      '2026/11/18 10:05 JST',
      '2026/11/18 00:30 JST',
      '2026/11/18 10:05 JST',
      '2027/01/01 08:59 JST'
    ];
    expect(formatInChildProcess('UTC')).toEqual(expected);
    expect(formatInChildProcess('America/Los_Angeles')).toEqual(expected);
    expect(formatInChildProcess('Asia/Tokyo')).toEqual(expected);
  });
});
