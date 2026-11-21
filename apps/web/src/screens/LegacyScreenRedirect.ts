import { redirect } from 'next/navigation';
import { loadSession } from '../lib/api';
import { legacyProjectTarget } from '../lib/project-route-server';

/**
 * P1 R20: an old address (/orders, /maker-po#…, /documents?download=…) from a
 * bookmark or an old link. It moves to the same list under the last project
 * opened in this browser; without one, to the project cards on /dashboard.
 * The fragment (#order-…) is kept by the browser across the redirect.
 * Without a usable session the root layout already shows its notice, so
 * nothing is read or redirected here.
 */
export async function legacyScreenPage(
  screen: string,
  searchParams: Record<string, string | string[] | undefined>
): Promise<null> {
  const session = await loadSession();
  if (session.kind !== 'user') return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  const search = params.size > 0 ? `?${params.toString()}` : '';
  const target = await legacyProjectTarget(screen, search);
  redirect(target ?? '/dashboard');
}
