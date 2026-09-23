import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isDmChannelParticipant } from '@lobbyforge/db';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * design pass: a direct message is no longer its own full-screen page —
 * it opens in the lobby's centre column, so the channel list, the member
 * roster and the voice controls survive reading a message. This route
 * stays as a deep link (old bookmarks, notifications, shared URLs) and
 * hands off to the lobby, which opens the conversation from `?dm=`.
 *
 * Participation is still checked HERE: the redirect must not confirm
 * that a channel exists to someone who is not in it.
 */
export default async function DmPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { channelId } = await params;
  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  if (!session?.uid) redirect('/login');

  const isParticipant = await isDmChannelParticipant(getDb(), channelId, session.uid);
  if (!isParticipant) redirect('/lobby');

  redirect(`/lobby?dm=${encodeURIComponent(channelId)}`);
}
