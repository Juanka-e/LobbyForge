import type { ReactNode } from 'react';
import SettingsShell from '../SettingsShell';

export default function UserSettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsShell scope="user">{children}</SettingsShell>;
}
