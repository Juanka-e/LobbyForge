import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isDmChannelParticipant, listDmMessages } from '@lobbyforge/db';
import { requireMaterializedSession, getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import DmView from './DmView';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function DmPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { channelId } = await params;
  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  if (!session?.uid) redirect('/login');

  const db = getDb();
  const isParticipant = await isDmChannelParticipant(db, channelId, session.uid);
  if (!isParticipant) redirect('/lobby');

  const messages = await listDmMessages(db, channelId, { limit: 50 });
  const reversed = [...messages].reverse(); // oldest first for display

  return (
    <DmView
      channelId={channelId}
      currentUserId={session.uid}
      initialMessages={reversed.map((m) => ({
        id: m.id,
        authorId: m.authorId,
        content: m.deletedAt ? '' : m.content,
        deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
        createdAt: m.createdAt.toISOString(),
      }))}
    />
  );
}
