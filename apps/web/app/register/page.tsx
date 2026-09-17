import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /register — deep link into the auth shell's "Create account" tab.
 *
 * Registration UI lives in the shared auth shell at /login (Sign in /
 * Create account tabs, policy-aware: open / invite-only / closed). This
 * route exists so links can say "Sign up" and land directly on the tab,
 * preserving an ?invite= code. All guards (official-deployment redirect,
 * bootstrap, session) run on /login itself — this is a pure redirect.
 */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  const suffix = invite ? `&invite=${encodeURIComponent(invite)}` : '';
  redirect(`/login?mode=register${suffix}`);
}
