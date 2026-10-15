'use client';

import { useCallback, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { profileActionErrorMessage, type ProfileAction } from '@/lib/profile-action-errors';
import { fetchMemberProfile } from '@/lib/member-profile';
import type { ModerationKind, ModerationRequest } from './ModerationDialog';

export interface ProfileNotice {
  tone: 'success' | 'danger';
  text: string;
}

/**
 * Everything a profile can DO, through the existing routes only:
 *
 *   roles      PUT  /api/servers/{id}/members/{userId}/role          (the whole set)
 *   timeout    PUT  /api/servers/{id}/members/{userId}/timeout       ({ until })
 *   kick       DELETE /api/servers/{id}/members/{userId}
 *   ban        POST /api/servers/{id}/bans                           ({ userId, reason?, expiresAt? })
 *   server mute POST /api/servers/{id}/channels/{ch}/members/{userId}/voice/mute
 *
 * The profile only offers what `viewerCan` allows; the routes decide.
 * A refusal is said in the viewer's language from the route's `code`.
 */
export function useProfileActions({
  serverId,
  userId,
  viewerId,
  name,
  onChanged,
  onRemoved,
}: {
  serverId: string;
  userId: string;
  /** Whose projection the profile cache holds (see lib/member-profile.ts). */
  viewerId?: string | null;
  name: string;
  /** Refetch the profile after a change. */
  onChanged?: () => void;
  /** The member left the community (kick, ban). */
  onRemoved?: (userId: string, message: string) => void;
}) {
  const t = useT();
  const [rolesBusy, setRolesBusy] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ProfileNotice | null>(null);
  const [dialog, setDialog] = useState<ModerationKind | null>(null);

  const refusal = useCallback(
    async (action: ProfileAction, res: Response): Promise<string> => {
      const detail = (await res.json().catch(() => ({}))) as { code?: unknown; permissions?: unknown };
      const message = profileActionErrorMessage(action, { status: res.status, code: detail.code, permissions: detail.permissions });
      return t(message.key, message.params);
    },
    [t]
  );

  const base = `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`;

  /**
   * The role PUT replaces the WHOLE set. Built from a profile shown a while
   * ago, it would silently undo a change someone else made since (another
   * moderator, the admin Members page). So the set is read fresh right
   * before every change and the edit is applied to that.
   */
  const changeRoles = useCallback(
    async (edit: (current: string[]) => string[]) => {
      setRolesBusy(true);
      setRolesError(null);
      try {
        const fresh = await fetchMemberProfile(serverId, userId, { force: true, viewerId }).catch(() => undefined);
        if (fresh === undefined) {
          setRolesError(t('shell.profile.error.network'));
          return;
        }
        if (!fresh || !fresh.viewerCan.manageRoles) {
          setRolesError(t(fresh ? 'shell.profile.error.forbidden' : 'shell.profile.error.notMember'));
          onChanged?.();
          return;
        }
        const current = fresh.viewerCan.currentRoleIds;
        const roleIds = edit(current);
        if (roleIds.length === current.length && roleIds.every((id) => current.includes(id))) {
          onChanged?.();
          return;
        }
        const res = await fetch(`${base}/role`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roleIds }),
        });
        if (!res.ok) {
          setRolesError(await refusal('roles', res));
          return;
        }
        onChanged?.();
      } catch {
        setRolesError(t('shell.profile.error.network'));
      } finally {
        setRolesBusy(false);
      }
    },
    [base, onChanged, refusal, serverId, t, userId, viewerId]
  );

  const addRole = useCallback(
    (roleId: string) => void changeRoles((current) => (current.includes(roleId) ? current : [...current, roleId])),
    [changeRoles]
  );

  const removeRole = useCallback(
    (roleId: string) => void changeRoles((current) => current.filter((id) => id !== roleId)),
    [changeRoles]
  );

  /** Run a confirmed moderation action. Resolves to the error to show in the dialog, or null. */
  const moderate = useCallback(
    async (request: ModerationRequest): Promise<string | null> => {
      try {
        let res: Response;
        if (request.kind === 'timeout' || request.kind === 'untimeout') {
          const until = request.kind === 'timeout' ? new Date(Date.now() + (request.durationMs ?? 0)).toISOString() : null;
          res = await fetch(`${base}/timeout`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ until }),
          });
        } else if (request.kind === 'kick') {
          res = await fetch(base, { method: 'DELETE', credentials: 'same-origin' });
        } else {
          res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/bans`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId,
              ...(request.reason ? { reason: request.reason } : {}),
              // A ban with a length ends on its own; without one it is permanent.
              ...(request.durationMs ? { expiresAt: new Date(Date.now() + request.durationMs).toISOString() } : {}),
            }),
          });
        }
        if (!res.ok) return await refusal(request.kind === 'untimeout' ? 'timeout' : request.kind, res);
        setDialog(null);
        const done = t(`shell.profile.moderation.${request.kind}.done`, { name });
        setNotice({ tone: 'success', text: done });
        if (request.kind === 'kick' || request.kind === 'ban') onRemoved?.(userId, done);
        else onChanged?.();
        return null;
      } catch {
        return t('shell.profile.error.network');
      }
    },
    [base, name, onChanged, onRemoved, refusal, serverId, t, userId]
  );

  const setServerMute = useCallback(
    async (channelId: string, muted: boolean) => {
      setNotice(null);
      try {
        const res = await fetch(
          `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}/voice/mute`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ muted }),
          }
        );
        if (!res.ok) {
          setNotice({ tone: 'danger', text: await refusal('mute', res) });
          return;
        }
        setNotice({ tone: 'success', text: t(muted ? 'shell.profile.serverMuted' : 'shell.profile.serverUnmuted', { name }) });
      } catch {
        setNotice({ tone: 'danger', text: t('shell.profile.error.network') });
      }
    },
    [name, refusal, serverId, t, userId]
  );

  const copyUserId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setNotice({ tone: 'success', text: t('shell.profile.idCopied') });
    } catch {
      setNotice({ tone: 'danger', text: t('shell.profile.idCopyFailed') });
    }
  }, [t, userId]);

  return {
    rolesBusy,
    rolesError,
    addRole,
    removeRole,
    notice,
    setNotice,
    dialog,
    openDialog: setDialog,
    closeDialog: useCallback(() => setDialog(null), []),
    moderate,
    setServerMute,
    copyUserId,
  };
}
