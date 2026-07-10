import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getInstanceSetupStatus } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';

export const ADMIN_TOKEN_COOKIE = 'lf_admin_token';
export const ADMIN_TOKEN_HEADER = 'x-lobbyforge-admin-token';

function constantTimeTokenMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Emergency/operator token path. Owner browser sessions use isInstanceAdminAllowed. */
export function isAdminHealthAllowed(token: string | null | undefined): boolean {
  const expected = process.env.LOBBYFORGE_ADMIN_TOKEN;
  if (!token || !expected || expected.length < 32) return false;
  return constantTimeTokenMatch(token, expected);
}

function getSessionSecret(): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export async function isInstanceAdminAllowed(
  cookieHeader: string | null,
  emergencyToken?: string | null
): Promise<boolean> {
  if (isAdminHealthAllowed(emergencyToken)) return true;
  const secret = getSessionSecret();
  if (!secret) return false;
  const session = readGuestSession(cookieHeader, secret);
  if (!session?.uid) return false;

  try {
    const setup = await getInstanceSetupStatus(getDb());
    return setup.bootstrapVersion >= 2 && setup.ownerUserId === session.uid;
  } catch {
    return false;
  }
}

export async function requireInstanceAdmin(req: Request): Promise<NextResponse | null> {
  const headerToken = req.headers.get(ADMIN_TOKEN_HEADER);
  const cookieToken = readCookie(req.headers.get('cookie'), ADMIN_TOKEN_COOKIE);
  if (await isInstanceAdminAllowed(req.headers.get('cookie'), headerToken ?? cookieToken)) {
    return null;
  }
  return NextResponse.json({ error: 'Instance owner authentication required' }, { status: 401 });
}

/** @deprecated Use requireInstanceAdmin. */
export const requireAdminHealthToken = requireInstanceAdmin;

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return rawValue.join('=') || null;
  }
  return null;
}
