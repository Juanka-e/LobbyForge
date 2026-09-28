import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { container } from '@/app/(marketing)/_components/styles';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import CreateInstanceForm from './CreateInstanceForm';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: `${t('hub.instances.new.title')} — LobbyForge` };
}

export default async function NewInstancePage() {
  if (!isOfficialDeployment()) redirect('/lobby');
  const t = await getTranslator();
  return (
    <div className={`${container} pb-24 pt-12 sm:pt-16`}>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <h1 className="text-balance font-display text-[36px] font-bold leading-[1.08] tracking-[-0.02em] text-text-primary sm:text-[44px]">
            {t('hub.instances.new.title')}
          </h1>
          <p className="text-pretty text-lg leading-[1.6] text-text-secondary">{t('hub.instances.new.subtitle')}</p>
        </header>
        <CreateInstanceForm />
      </div>
    </div>
  );
}
