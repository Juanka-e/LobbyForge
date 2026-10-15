import { notFound } from 'next/navigation';
import SettingsPage from '@/app/settings/page';
import AccessibilityPage from '@/app/settings/accessibility/page';
import ActiveSessionsPage from '@/app/settings/active-sessions/page';
import AppearancePage from '@/app/settings/appearance/page';
import KeybindsPage from '@/app/settings/keybinds/page';
import MyAccountPage from '@/app/settings/my-account/page';
import NotificationsPage from '@/app/settings/notifications/page';
import ProfilePage from '@/app/settings/profile/page';
import VoiceVideoPage from '@/app/settings/voice-video/page';

const PAGES = {
  '': SettingsPage,
  accessibility: AccessibilityPage,
  'active-sessions': ActiveSessionsPage,
  appearance: AppearancePage,
  keybinds: KeybindsPage,
  'my-account': MyAccountPage,
  notifications: NotificationsPage,
  profile: ProfilePage,
  'voice-video': VoiceVideoPage,
} as const;

export default async function InterceptedUserSettings({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{ server?: string | string[] }>;
}) {
  const key = (await params).slug?.join('/') ?? '';
  const Page = PAGES[key as keyof typeof PAGES];
  if (!Page) notFound();
  // The profile page opens on the community the lobby showed (`?server=`).
  if (Page === ProfilePage) return <ProfilePage searchParams={searchParams} />;
  return <Page />;
}
