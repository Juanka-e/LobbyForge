'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';

interface DmMessage {
  id: string;
  authorId: string;
  content: string;
  deletedAt: string | null;
  createdAt: string;
}

export default function DmView({
  channelId,
  currentUserId,
  initialMessages,
}: {
  channelId: string;
  currentUserId: string;
  initialMessages: DmMessage[];
}) {
  const [messages, setMessages] = useState<DmMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom when messages change.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Poll for new messages every 5s (fallback until WS-gateway gains a `dm` topic).
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/dm/${channelId}/messages?limit=50`, {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { messages: DmMessage[] };
        // Merge — keep only messages we don't already have (by id).
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const fresh = data.messages.filter((m) => !seen.has(m.id));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
      } catch {
        // Swallow — a single failed poll is fine.
      }
    };
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [channelId]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/dm/${channelId}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { message: DmMessage };
      setMessages((prev) => [...prev, data.message]);
      setDraft('');
    } catch {
      setError('Failed to send message');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-dvh w-full flex-col bg-background">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
        <Link
          href="/lobby"
          className="rounded-md p-1.5 text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
          title="Back to lobby"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        </Link>
        <h1 className="text-sm font-semibold text-text-primary">Direct Message</h1>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-text-muted mt-8">
            No messages yet — say hello!
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.authorId === currentUserId;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm ${
                    mine
                      ? 'bg-primary text-on-primary rounded-br-md'
                      : 'bg-surface-raised text-text-primary rounded-bl-md'
                  }`}
                >
                  {m.deletedAt ? (
                    <span className="italic opacity-60">message deleted</span>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            );
          })
        )}
        {error ? (
          <p className="text-center text-xs text-danger">{error}</p>
        ) : null}
      </div>

      {/* Composer */}
      <form onSubmit={send} className="border-t border-border-subtle p-3 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message..."
          maxLength={4000}
          className="flex-1 rounded-lg bg-surface-raised border border-border-subtle px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-primary"
          autoFocus
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition-all"
        >
          Send
        </button>
      </form>
    </div>
  );
}
