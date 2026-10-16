// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LobbyVoiceContext } from '../LobbyVoiceProvider';
import { makeVoice } from './voice-context';

/**
 * docs/PROFILES.md "Live updates": the sidebar's conversations follow the
 * account's own feed — a message re-reads the list and marks a conversation
 * that is not open — and the feed going live re-reads it too, so one started
 * between the page render and the subscription is not missed.
 */

const { subscribers, liveListeners } = vi.hoisted(() => ({
  subscribers: new Map<string, (data: unknown) => void>(),
  liveListeners: new Set<() => void>(),
}));
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({
    subscribe: (topic: string, handler: (data: unknown) => void, options?: { onLive?: () => void }) => {
      subscribers.set(topic, handler);
      if (options?.onLive) liveListeners.add(options.onLive);
      return () => {
        subscribers.delete(topic);
        if (options?.onLive) liveListeners.delete(options.onLive);
      };
    },
  }),
}));

import DmLinkSection from '../DmLinkSection';

function conversation(id: string, name: string, extra: { lastMessageAt?: string; lastMessageFromOther?: boolean } = {}) {
  return {
    id,
    otherUserId: `u-${id}`,
    otherUserDisplayName: name,
    otherUserAvatarUrl: null,
    lastMessageAt: '2026-10-16T10:00:00.000Z',
    lastMessageFromOther: false,
    ...extra,
  };
}

let answer: ReturnType<typeof conversation>[] = [];
let reads = 0;

function renderSection() {
  return render(
    <I18nProvider {...providerPropsFor('en')}>
      <LobbyVoiceContext.Provider value={makeVoice({ serverId: 'srv-1' })}>
        <DmLinkSection currentUserId="me" />
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
}

beforeEach(() => {
  subscribers.clear();
  liveListeners.clear();
  answer = [];
  reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reads += 1;
      return Response.json({ channels: answer });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DmLinkSection', () => {
  it('a first message from someone else adds the conversation with an unread mark', async () => {
    renderSection();
    await screen.findByText('No conversations yet');
    answer = [conversation('c1', 'Bora')];
    act(() => subscribers.get('user:me')!({ type: 'dm_activity', channelId: 'c1', fromUserId: 'u-c1' }));
    expect(await screen.findByText('Bora')).toBeInTheDocument();
    expect(screen.getByTestId('dm-unread-dot')).toBeInTheDocument();
  });

  it('a conversation that moved while no event came (the feed not live yet, the socket down) is marked when the other person wrote last', async () => {
    answer = [conversation('c1', 'Bora'), conversation('c2', 'Cem')];
    renderSection();
    await screen.findByText('Cem');
    // The first read marks nothing: there is nothing to compare it with.
    expect(screen.queryByTestId('dm-unread-dot')).toBeNull();
    answer = [
      conversation('c1', 'Bora', { lastMessageAt: '2026-10-16T10:05:00.000Z', lastMessageFromOther: true }),
      conversation('c2', 'Cem', { lastMessageAt: '2026-10-16T10:06:00.000Z', lastMessageFromOther: false }),
      conversation('c3', 'Deniz', { lastMessageAt: '2026-10-16T10:07:00.000Z', lastMessageFromOther: true }),
    ];
    await act(async () => {
      for (const listener of liveListeners) listener();
    });
    await screen.findByText('Deniz');
    const marked = (id: string) => document.querySelector(`[data-dm-row="${id}"] [data-testid="dm-unread-dot"]`) !== null;
    await waitFor(() => expect(marked('c1')).toBe(true));
    expect(marked('c3')).toBe(true);
    // The viewer's own message (from another tab or device) is not unread.
    expect(marked('c2')).toBe(false);
  });

  it('the feed going live re-reads the list: a conversation started before then appears', async () => {
    renderSection();
    await screen.findByText('No conversations yet');
    const before = reads;
    answer = [conversation('c2', 'Cem')];
    await act(async () => {
      for (const listener of liveListeners) listener();
    });
    expect(await screen.findByText('Cem')).toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(before + 1));
    // Nothing said it was unread — only an event does.
    expect(screen.queryByTestId('dm-unread-dot')).toBeNull();
  });
});
