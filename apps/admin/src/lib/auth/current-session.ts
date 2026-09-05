/**
 * Reading the session inside server components and server actions.
 *
 * Refreshing happens in `src/middleware.ts`, which is the only place that can still write cookies
 * for the current request; by the time a server component renders, the session is already fresh.
 */

import 'server-only';

import { cookies } from 'next/headers';
import { sessionSecret } from '../env';
import type { Session } from './session';
import { joinChunks, openSession } from './session';

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const sealed = joinChunks((name) => store.get(name)?.value);
  if (sealed === null) return null;
  return openSession(sealed, sessionSecret());
}

/** For routes that have already been gated by the middleware and may assume a session. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (session === null) {
    throw new Error('No session — the middleware should have redirected to /api/auth/login');
  }
  return session;
}
