import type { Metadata } from 'next';
import HubShell from '@/app/(marketing)/_components/HubShell';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import ConnectForm from './ConnectForm';

export async function generateMetadata(): Promise<Metadata> {
  // A self-hosted instance keeps its own title (root layout).
  if (!isOfficialDeployment()) return {};
  const t = await getTranslator();
  return { title: `${t('auth.connect.title')} — LobbyForge` };
}

/**
 * /connect — on the official hub a hub page (header and footer from
 * HubShell); on a self-hosted instance it keeps the app's own header, as
 * before. Not a layout, so /connect/demo (a developer surface) is left
 * exactly as it is.
 */
export default function ConnectPage() {
  if (!isOfficialDeployment()) return <ConnectForm />;
  return (
    <HubShell>
      <div className="pb-24 pt-8 sm:pt-12">
        <ConnectForm />
      </div>
    </HubShell>
  );
}
