import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getEffectiveInstanceAccessSettings, getInstanceBootstrapStatus } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getSessionSecret } from '@/lib/api-auth';
import { readGuestSession } from '@/lib/guest-session';
import { isOfficialDeployment } from '@/lib/deployment-mode';
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
        <LoginForm
          guestEnabled={settings.guestAccessEnabled && settings.registrationMode !== 'closed'}
          inviteOnly={inviteOnly}
          initialInviteCode={invite}
        />
      </section>
    </div>
  );
}
