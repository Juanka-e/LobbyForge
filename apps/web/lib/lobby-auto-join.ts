/**
 * Which community a signed-in user may join WITHOUT an invite — the /lobby
 * auto-join rule, shared by the lobby page (a GET: it joins an open
 * community, or only REPORTS where the user stands under an approval
 * policy) and `POST /api/servers/{id}/join-requests/mine` (the lobby's
 * "Ask to join", which files the request).
 *
 * The answer is the instance's first community, for its owner or — on an
 * open-registration instance — anyone who could have registered into it
 * (a guest only while guest access is on). Null on the official hub,
 * before setup, or for everyone else: they join through an invite.
 */
import {
  getEffectiveInstanceAccessSettings,
  getInstanceBootstrapStatus,
  getUserById,
  type DbClient,
} from '@lobbyforge/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';

export async function resolveAutoJoinServerId(
  db: DbClient,
  userId: string,
  setup?: { firstServerId: string | null; ownerUserId: string | null } | null
): Promise<string | null> {
  if (isOfficialDeployment()) return null;
  const status = setup ?? (await getInstanceBootstrapStatus(db));
  if (!status.firstServerId) return null;
  if (status.ownerUserId === userId) return status.firstServerId;
  const access = await getEffectiveInstanceAccessSettings(db);
  if (access.registrationMode !== 'open') return null;
  const user = await getUserById(db, userId);
  if (user?.isGuest === true && !access.guestAccessEnabled) return null;
  return status.firstServerId;
}
