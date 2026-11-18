/**
 * UI batch B (⑥): the short label of an id shown next to a name. A uuidv7
 * starts with its creation time, so ids made within about a minute share
 * their first characters; the last 8 characters (random bits) keep them apart.
 * Pure and client-safe.
 */
export function shortId(id: string): string {
  return `…${id.slice(-8)}`;
}
