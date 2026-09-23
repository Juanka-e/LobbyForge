import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import CreateInstanceForm from './CreateInstanceForm';

export default async function NewInstancePage() {
  if (!isOfficialDeployment()) redirect('/lobby');
  const t = await getTranslator();
  return (
    <section className="w-full max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold text-text-primary mb-2">{t('hub.instances.new.title')}</h1>
      <p className="text-text-secondary mb-8">{t('hub.instances.new.subtitle')}</p>
      <CreateInstanceForm />
    </section>
  );
}
