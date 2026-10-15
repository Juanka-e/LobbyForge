'use client';

import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import { useProfileCard } from './ProfileCardProvider';

/**
 * A voice participant's face: their profile photo when the lobby knows it
 * (the live member rows, projected for this viewer — a hidden profile has
 * no photo here either), else their initial. The voice list in the
 * sidebar and the call view use it (docs/PROFILES.md).
 *
 * Fills its parent: the caller sizes and shapes the circle.
 */
export function VoiceAvatar({ userId, name }: { userId: string | null | undefined; name: string }) {
  const t = useT();
  const profile = useProfileCard();
  const avatarUrl = userId ? (profile?.seedFor(userId)?.avatarUrl ?? null) : null;
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- same-origin avatar route
      <img src={avatarUrl} alt="" className="size-full rounded-full object-cover" draggable={false} data-voice-avatar="photo" />
    );
  }
  return <span data-voice-avatar="initial">{initialOf(name, { locale: t.locale })}</span>;
}
