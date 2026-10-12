// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { interactionStore } from '@/lib/bots/interaction-store';

/**
 * security-review AUTHZ-009: the server render and the REST list mask a
 * blocked author's messages, but the live chat used to render them as they
 * came off the realtime feed — words, poll and a desktop notification. The
 * roster now reads the viewer's block list (BlockListProvider): a blocked
 * author's live message shows the same placeholder (no poll), raises no
 * notification, and a message that arrived before the list loaded is
 * masked once it does.
 */

const subscribers = new Map<string, (envelope: unknown) => void>();
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({
    subscribe: (topic: string, handler: (envelope: unknown) => void) => {
      subscribers.set(topic, handler);
      return () => subscribers.delete(topic);
    },
  }),
}));

const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const TOPIC = `chat:${SERVER}:${CHANNEL}`;
const BLOCKED = 'u-blocked';
const FRIEND = 'u-friend';

let releaseBlocks: (() => void) | null = null;
let blocksGate: Promise<void> = Promise.resolve();
const shownNotifications: string[] = [];

class FakeNotification {
  static permission = 'granted';
  constructor(title: string) {
    shownNotifications.push(title);
  }
}

beforeEach(() => {
  subscribers.clear();
  interactionStore.reset();
  shownNotifications.length = 0;
  blocksGate = Promise.resolve();
  releaseBlocks = null;
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Before '/api/settings/me' — that prefix matches this path too.
      if (url.includes('/api/settings/me/blocks')) {
        await blocksGate;
        return Response.json({ blocks: [{ blockedUserId: BLOCKED }] });
      }
      if (url.includes('/api/settings/me')) {
        return Response.json({ settings: { notifications: { level: 'all', desktopEnabled: true, showPreview: true, sound: 'default' } } });
      }
      if (url.includes('/messages')) return Response.json({ messages: [] });
      if (url.includes('/typing')) return Response.json({ typers: [] });
      return Response.json({});
    })
  );
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderRoster() {
  const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
  const { BlockListProvider } = await import('../BlockListProvider');
  const utils = render(
    <I18nProvider {...providerPropsFor('en')}>
      <BlockListProvider>
        <LobbyLiveRoster
          data={{
            serverId: SERVER,
            channelId: CHANNEL,
            channelName: 'general',
            currentUserId: 'u-me',
            voiceChannelId: null,
            knownNames: { 'u-me': 'Ayşe', [BLOCKED]: 'Troll', [FRIEND]: 'Bora' },
            canManageMessages: false,
            initialMessages: [],
          }}
        />
      </BlockListProvider>
    </I18nProvider>
  );
  await waitFor(() => expect(subscribers.has(TOPIC)).toBe(true));
  // Let the settings and block-list fetches settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return utils;
}

function liveMessage(id: string, userId: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'message',
    message: { id, channelId: CHANNEL, userId, content, metadata: {}, createdAt: new Date().toISOString(), ...extra },
    at: new Date().toISOString(),
  };
}

function emit(envelope: unknown) {
  act(() => {
    subscribers.get(TOPIC)!(envelope);
  });
}

describe('live chat honours the block list (AUTHZ-009)', () => {
  it("shows the blocked placeholder instead of a blocked author's live message", async () => {
    await renderRoster();
    emit(liveMessage('m-1', BLOCKED, 'you will read this'));
    expect(await screen.findByText('This message is hidden because you blocked the sender.')).toBeInTheDocument();
    expect(screen.getByText('Blocked user')).toBeInTheDocument();
    expect(screen.queryByText('you will read this')).toBeNull();
    expect(screen.queryByText('Troll')).toBeNull();
  });

  it("drops a blocked author's poll from the live message", async () => {
    await renderRoster();
    const poll = {
      id: 'poll-1',
      messageId: 'm-poll',
      question: 'Secret poll?',
      options: [{ text: 'Yes', votes: null }, { text: 'No', votes: null }],
      allowMultiple: false,
      closesAt: new Date(Date.now() + 3_600_000).toISOString(),
      closedAt: null,
      closed: false,
      totalVoters: 0,
      myChoices: [],
      resultsVisible: false,
      version: 1,
    };
    emit(liveMessage('m-poll', BLOCKED, 'Secret poll?', { poll, metadata: { poll: { id: 'poll-1' } } }));
    expect(await screen.findByText('Blocked user')).toBeInTheDocument();
    expect(screen.queryByText('Secret poll?')).toBeNull();
    expect(screen.queryByText('Yes')).toBeNull();
  });

  it('raises no desktop notification for a blocked author, and still does for others', async () => {
    await renderRoster();
    emit(liveMessage('m-2', BLOCKED, 'ping'));
    expect(shownNotifications).toEqual([]);
    emit(liveMessage('m-3', FRIEND, 'hello'));
    expect(shownNotifications).toEqual(['Bora in #general']);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('masks a message that arrived before the block list loaded', async () => {
    blocksGate = new Promise<void>((resolve) => {
      releaseBlocks = resolve;
    });
    await renderRoster();
    emit(liveMessage('m-4', BLOCKED, 'too early'));
    expect(screen.getByText('too early')).toBeInTheDocument();
    await act(async () => {
      releaseBlocks?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.queryByText('too early')).toBeNull());
    expect(screen.getByText('Blocked user')).toBeInTheDocument();
  });

  it('applies the same rule to the local echo', async () => {
    await renderRoster();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('lf-message-sent', {
          detail: { channelId: CHANNEL, message: { id: 'm-5', content: 'echoed words', userId: BLOCKED, createdAt: new Date().toISOString() } },
        })
      );
    });
    expect(await screen.findByText('Blocked user')).toBeInTheDocument();
    expect(screen.queryByText('echoed words')).toBeNull();
  });
});
