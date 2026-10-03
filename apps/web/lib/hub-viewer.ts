/**
 * The signed-in visitor on an official hub page, for the nav's account
 * menu and the hub home. Server-only.
 *
 * Wrapped in React's `cache`, so the layout (nav) and the page (hub home)
 * share one cookie read and one user lookup per request.
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import { getUserById } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getActiveSession } from '@/lib/active-session';

export interface HubViewer {
  userId: string;
  /** Current display name — the session cookie only carries the one from sign-in. */
  name: string;
  /** When the account was created, if the user row could be read. */
  createdAt: Date | null;
}

/**
 * The session's user, or null — never throws (a public page must still
 * render). security-review AUTH-002: a revoked session is signed out here
 * too, not only at the API boundary.
 */
export async function sessionUser(
  cookieHeader: string | null,
  secret: string | undefined
): Promise<{ userId: string; name: string } | null> {
  if (!secret || secret.length < 32) return null;
  const session = await getActiveSession(cookieHeader, secret);
  return session?.uid ? { userId: session.uid, name: session.name } : null;
}

export const getHubViewer = cache(async (): Promise<HubViewer | null> => {
  const store = await cookies();
  const user = await sessionUser(store.toString(), process.env.LOBBYFORGE_SESSION_SECRET);
  if (!user) return null;
  // The name is display-only: a failed or empty lookup keeps the name the
  // session was issued with rather than signing the visitor out.
  const row = await getUserById(getDb(), user.userId).catch(() => null);
  return {
    userId: user.userId,
    name: row?.displayName?.trim() || user.name,
    createdAt: row?.createdAt ?? null,
  };
});
