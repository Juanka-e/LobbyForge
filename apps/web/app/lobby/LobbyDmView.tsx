'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { useLobbyVoice, type ActiveDm } from './LobbyVoiceProvider';

/**
 * A direct message, rendered in the centre column.
 *
 * design pass: DMs used to be a `h-dvh` page at /dm/<id>. Opening one
 * replaced the entire app — channel list, member roster and voice
 * controls all disappeared, and the only way back was a small arrow. A
 * conversation is just another thing you read in the middle of the
 * window, so it renders there, in the same grammar as a channel: a
 * header you can dismiss, grouped messages, one composer.
 */

interface DmMessage {
  id: string;
  authorId: string;
  content: string;
  deletedAt: string | null;
  createdAt: string;
}

const POLL_INTERVAL_MS = 10_000;
/** Messages from the same author within this window share one header. */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDay(iso: string): string {
  try {
    const date = new Date(iso);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    if (sameDay) return 'Today';
    const yesterday = new Date(today.getTime() - 86_400_000);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

export function LobbyDmView({ dm, currentUserId }: { dm: ActiveDm; currentUserId: string | null }) {
  const voice = useLobbyVoice();
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dm/${dm.channelId}/messages?limit=50`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Failed to load messages (${res.status})`);
      const data = (await res.json()) as { messages?: DmMessage[] };
      // The API returns newest-first; the transcript reads oldest-first.
      setMessages([...(data.messages ?? [])].reverse());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dm.channelId]);

  useEffect(() => {
    setLoading(true);
    setMessages([]);
    void load();
  }, [load]);

  // Realtime first; the poll below is the recovery lane.
  useEffect(() => {
    let unsub: (() => void) | null = null;
    try {
      const client = getRealtimeClient();
      client.connect();
      unsub = client.subscribe(`dm:${dm.channelId}`, (raw: unknown) => {
        const msg = raw as DmMessage;
        if (!msg?.id) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      });
    } catch {
      // WS unavailable — the poll delivers.
    }
    return () => unsub?.();
  }, [dm.channelId]);

  useEffect(() => {
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/dm/${dm.channelId}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`Failed to send (${res.status})`);
      setDraft('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  // Group consecutive messages by the same author so the transcript
  // reads as conversation rather than a list of labelled rows.
  const groups = useMemo(() => {
    const out: Array<{ key: string; authorId: string; at: string; items: DmMessage[]; dayLabel: string | null }> = [];
    let lastDay = '';
    for (const message of messages) {
      const day = formatDay(message.createdAt);
      const dayLabel = day !== lastDay ? day : null;
      lastDay = day;
      const previous = out[out.length - 1];
      const continues =
        previous &&
        !dayLabel &&
        previous.authorId === message.authorId &&
        new Date(message.createdAt).getTime() - new Date(previous.at).getTime() < GROUPING_WINDOW_MS;
      if (continues) {
        previous.items.push(message);
        previous.at = message.createdAt;
        continue;
      }
      out.push({
        key: message.id,
        authorId: message.authorId,
        at: message.createdAt,
        items: [message],
        dayLabel,
      });
    }
    return out;
  }, [messages]);

  const initial = dm.name.trim().charAt(0).toUpperCase() || '?';

  return (
    <main className="flex-1 flex flex-col bg-background min-w-0 relative text-[14px] animate-fade-in-up">
      <header className="h-16 px-6 flex items-center justify-between border-b border-border-subtle bg-surface-dim/80 backdrop-blur-md z-10 sticky top-0 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-secondary-container flex items-center justify-center overflow-hidden flex-shrink-0">
            {dm.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- user avatar, may be a data URL
              <img src={dm.avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-label-sm font-bold text-text-primary">{initial}</span>
            )}
          </div>
          <h2 className="font-body-lg font-bold text-text-primary truncate">{dm.name}</h2>
          <div className="h-4 w-[1px] bg-border-subtle mx-1" />
          <p className="font-label-sm hidden md:block text-text-secondary">Direct message</p>
        </div>
        <button
          type="button"
          onClick={() => voice.setMainViewMode('chat')}
          title="Back to the channel"
          aria-label="Back to the channel"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
          <span className="hidden sm:inline">Close</span>
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6" role="log" aria-live="polite">
        {loading ? (
          <p className="text-sm text-text-muted">Loading conversation…</p>
        ) : groups.length === 0 ? (
          <div className="py-12 flex flex-col items-start">
            <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center mb-4 overflow-hidden">
              {dm.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- user avatar, may be a data URL
                <img src={dm.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-2xl font-bold text-text-primary">{initial}</span>
              )}
            </div>
            <h1 className="font-section-h2-mobile text-text-primary mb-2">{dm.name}</h1>
            <p className="font-body-md text-text-secondary">
              This is the beginning of your direct message history with {dm.name}.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {groups.map((group) => {
              const mine = group.authorId === currentUserId;
              const author = mine ? 'You' : dm.name;
              return (
                <div key={group.key}>
                  {group.dayLabel ? (
                    <div className="flex items-center gap-3 my-5" aria-hidden>
                      <div className="h-px flex-1 bg-border-subtle/60" />
                      <span className="font-label-xs text-[11px] uppercase tracking-wider text-text-muted">
                        {group.dayLabel}
                      </span>
                      <div className="h-px flex-1 bg-border-subtle/60" />
                    </div>
                  ) : null}
                  <div className="flex gap-4 group hover:bg-surface-container/30 p-2 -mx-2 rounded-lg transition-colors">
                    <div className="w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 mt-1 flex items-center justify-center font-bold text-text-primary overflow-hidden">
                      {!mine && dm.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- user avatar, may be a data URL
                        <img src={dm.avatarUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        author.charAt(0).toUpperCase()
                      )}
                    </div>
                    <div className="flex flex-col w-full min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`font-label-sm font-medium ${mine ? 'text-primary' : 'text-text-primary'}`}
                        >
                          {author}
                        </span>
                        <span className="font-label-xs text-[11px] text-text-secondary">
                          {formatTime(group.at)}
                        </span>
                      </div>
                      {group.items.map((message) => (
                        <p
                          key={message.id}
                          className={`font-body-md mt-1 whitespace-pre-wrap break-words ${
                            message.deletedAt ? 'italic text-text-muted' : 'text-text-secondary'
                          }`}
                        >
                          {message.deletedAt ? 'message deleted' : message.content}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-4 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>

      <form onSubmit={send} className="px-6 pb-6 pt-2">
        <div className="flex items-end gap-2 rounded-xl border border-border-subtle bg-surface-container px-3 py-2 focus-within:border-primary transition-colors">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message ${dm.name}`}
            maxLength={4000}
            aria-label={`Message ${dm.name}`}
            className="flex-1 bg-transparent py-1.5 text-sm text-text-primary placeholder:text-text-muted outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            title="Send"
            aria-label="Send message"
            className="flex items-center justify-center rounded-lg bg-primary-container px-3 py-1.5 text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <span className="material-symbols-outlined text-[18px]">send</span>
          </button>
        </div>
      </form>
    </main>
  );
}
