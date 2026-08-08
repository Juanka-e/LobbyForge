import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getEffectiveInstanceAccessSettings, getInstanceBootstrapStatus } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getSessionSecret } from '@/lib/api-auth';
import { readGuestSession } from '@/lib/guest-session';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { isGoogleOAuthConfigured } from '@/lib/oauth-google';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  if (isOfficialDeployment()) redirect('/landing');
  const setup = await getInstanceBootstrapStatus(getDb());
  if (!setup.bootstrapComplete) redirect('/setup');

  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  if (session?.uid) redirect('/lobby');

  const settings = await getEffectiveInstanceAccessSettings(getDb());
  const { invite = '' } = await searchParams;
  const instanceName =
    setup.instanceName || process.env.LOBBYFORGE_INSTANCE_NAME?.trim() || 'LobbyForge Community';
  const inviteOnly = settings.registrationMode === 'invite_only';
  const googleEnabled = isGoogleOAuthConfigured();

  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-5 py-10 safe-area-page">
      <section className="w-full max-w-md rounded-lg border border-border-subtle bg-surface-raised p-6 md:p-8 shadow-lg">
        <div className="mb-7 flex items-center gap-3">
          <div className="size-11 rounded-lg bg-primary-container flex items-center justify-center font-bold text-[#07101e]">
            {instanceName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm text-text-muted">LobbyForge community</p>
            <h1 className="truncate text-balance text-xl font-semibold text-text-primary">{instanceName}</h1>
          </div>
        </div>
        <p className="mb-6 text-pretty text-sm text-text-secondary">
          {inviteOnly ? 'Sign in locally, or use a valid invitation to join as a guest.' : 'Sign in with your local community account.'}
        </p>

        {/* Google OAuth button (only if configured — works on both official + self-host) */}
        {googleEnabled ? (
          <div className="mb-4">
            <a
              href="/api/auth/oauth/google"
              className="flex w-full items-center justify-center gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-surface-container transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                <path d="M16.51 8.18c0-.55-.05-1.08-.14-1.59H9v3.01h4.21c-.18.97-.74 1.79-1.58 2.34v1.95h2.55c1.49-1.37 2.33-3.4 2.33-5.71z" fill="#4285F4"/>
                <path d="M9 17c2.13 0 3.92-.71 5.22-1.92l-2.55-1.95c-.71.47-1.61.75-2.67.75-2.05 0-3.79-1.39-4.41-3.25H1.96v2.02C3.25 15.19 5.92 17 9 17z" fill="#34A853"/>
                <path d="M4.59 10.63c-.16-.47-.25-.97-.25-1.5s.09-1.03.25-1.5V5.61H1.96C1.43 6.68 1.13 7.8 1.13 9.13s.3 2.45.83 3.52l2.63-2.02z" fill="#FBBC05"/>
                <path d="M9 4.63c1.16 0 2.2.4 3.02 1.18l2.27-2.27C12.91 2.27 11.12 1.56 9 1.56 5.92 1.56 3.25 3.37 1.96 6.1l2.63 2.02C5.21 6.02 6.95 4.63 9 4.63z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </a>
            <div className="my-3 flex items-center gap-3">
              <div className="h-px flex-1 bg-border-subtle" />
              <span className="text-xs text-text-muted">or</span>
              <div className="h-px flex-1 bg-border-subtle" />
            </div>
          </div>
        ) : null}

        <LoginForm
          guestEnabled={settings.guestAccessEnabled && settings.registrationMode !== 'closed'}
          registrationMode={settings.registrationMode}
          initialInviteCode={invite}
        />
      </section>
    </div>
  );
}
