import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import CreateInstanceForm from './CreateInstanceForm';

export default function NewInstancePage() {
  if (!isOfficialDeployment()) redirect('/lobby');
  return (
    <section className="w-full max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold text-text-primary mb-2">Create an instance</h1>
      <p className="text-text-secondary mb-8">Start a new community on the official LobbyForge hub.</p>
      <CreateInstanceForm />
    </section>
  );
}
