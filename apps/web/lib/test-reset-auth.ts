import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export const TEST_RESET_HEADER = 'x-lobbyforge-test-token';

export function requireTestResetAccess(req: Request): NextResponse | null {
  if (process.env.NODE_ENV !== 'test') {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const expected = process.env.LOBBYFORGE_TEST_RESET_TOKEN;
  const provided = req.headers.get(TEST_RESET_HEADER);
  if (!expected || expected.length < 32 || !provided || !safeEqual(provided, expected)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  return null;
}

function safeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
