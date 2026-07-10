import type { ReactNode } from 'react';
import SettingsShell from '../SettingsShell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <SettingsShell scope="community">{children}</SettingsShell>;
}
