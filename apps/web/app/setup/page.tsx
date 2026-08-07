import { redirect } from 'next/navigation';
import { getInstanceBootstrapStatus, getUserById } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import SetupWizard from './SetupWizard';

/**
 * /setup — initial instance bootstrap wizard.
 *
 * Single-page gate: if `setupCompletedAt` is already set, the page
 * just redirects to /lobby. The page is rendered server-side so the
 * lock check is authoritative (no client-side bypass possible).
 *
 * Why force-dynamic: every request must read the current DB state.
 * Otherwise a stale RSC payload could let a re-visitor re-enter the
 * wizard after completion.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SetupPage() {
  const status = await getInstanceBootstrapStatus(getDb());
  if (status.bootstrapComplete) redirect('/lobby');

  const defaultInstanceName =
    process.env.LOBBYFORGE_INSTANCE_NAME?.trim() || status.instanceName;
  const existingOwner = status.ownerUserId ? await getUserById(getDb(), status.ownerUserId) : null;

  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-5 py-10 safe-area-page">
      <SetupWizard
        defaultInstanceName={defaultInstanceName}
        defaultOwnerDisplayName={existingOwner?.displayName ?? ''}
        setupTokenRequired={process.env.NODE_ENV === 'production' || Boolean(process.env.LOBBYFORGE_SETUP_TOKEN)}
        instanceId={status.instanceId}
        isOfficialHost={isOfficialDeployment()}
      />
    </div>
  );
}
