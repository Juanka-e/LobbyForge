import type { Translator } from '@/lib/i18n/core';
import type { MemberProfileResponse } from '@/lib/member-profile';
import type { ProfileMenuItem } from './ProfileMenu';
import type { ModerationKind } from './ModerationDialog';

/** Where "Edit profile" goes — the user settings' profile page. */
export const EDIT_PROFILE_HREF = '/settings/profile';

/**
 * The "⋯" menu of a profile (card and full profile alike): copy the ID;
 * Edit profile for yourself, Block/Unblock for anyone else; then the
 * moderation actions `viewerCan` allows — nothing the routes would refuse.
 */
export function buildProfileMenuItems(input: {
  t: Translator;
  userId: string;
  name: string;
  isSelf: boolean;
  data: MemberProfileResponse | null;
  isBlocked: boolean;
  onCopyId: () => void;
  onToggleBlock?: () => void;
  onModerate: (kind: ModerationKind) => void;
  /** Server mute is offered while the member is in the viewer's voice room. */
  serverMute?: { muted: boolean; onToggle: () => void } | null;
}): ProfileMenuItem[] {
  const { t, isSelf, data } = input;
  const can = data?.viewerCan;
  const items: ProfileMenuItem[] = [
    { id: 'copy-id', label: t('shell.profile.copyId'), icon: 'content_copy', onSelect: input.onCopyId },
  ];
  if (isSelf) {
    items.push({ id: 'edit', label: t('shell.profile.editProfile'), icon: 'edit', href: EDIT_PROFILE_HREF });
    return items;
  }
  if (input.onToggleBlock) {
    items.push({
      id: 'block',
      label: input.isBlocked ? t('shell.profile.unblock') : t('shell.profile.block'),
      icon: input.isBlocked ? 'remove_circle' : 'block',
      tone: input.isBlocked ? undefined : 'danger',
      onSelect: input.onToggleBlock,
    });
  }
  if (!can) return items;
  const moderation: ProfileMenuItem[] = [];
  if (can.serverMute && input.serverMute) {
    moderation.push({
      id: 'server-mute',
      label: input.serverMute.muted ? t('shell.profile.serverUnmute') : t('shell.profile.serverMute'),
      icon: input.serverMute.muted ? 'mic' : 'mic_off',
      onSelect: input.serverMute.onToggle,
    });
  }
  if (can.timeout) {
    moderation.push(
      data?.profile.timedOutUntil
        ? { id: 'untimeout', label: t('shell.profile.removeTimeout'), icon: 'timer_off', onSelect: () => input.onModerate('untimeout') }
        : { id: 'timeout', label: t('shell.profile.timeout'), icon: 'timer', tone: 'danger', onSelect: () => input.onModerate('timeout') }
    );
  }
  if (can.kick) {
    moderation.push({ id: 'kick', label: t('shell.profile.kick'), icon: 'person_remove', tone: 'danger', onSelect: () => input.onModerate('kick') });
  }
  if (can.ban) {
    moderation.push({ id: 'ban', label: t('shell.profile.ban'), icon: 'gavel', tone: 'danger', onSelect: () => input.onModerate('ban') });
  }
  if (moderation[0]) moderation[0].separated = true;
  return [...items, ...moderation];
}
