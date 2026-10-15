// @vitest-environment happy-dom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { __resetNotificationPrefsForTests } from '@/lib/notification-prefs';

/**
 * App messages in the lobby chat: what a game plugin posts during an
 * activity (`chat.post`, docs/PLUGIN_SDK.md "Effects"). No user, no bot,
 * `metadata.app` names the plugin — shown with the plugin's name, an app
 * avatar and the APP badge (UYGULAMA in Turkish), never as a member, a bot,
 * a webhook or a deleted user. Forged app metadata on a member's message is
 * ignored.
 */

const subscribers = new Map<string, (envelope: unknown) => void>();
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({
    subscribe: (topic: string, handler: (envelope: unknown) => void) => {
      subscribers.set(topic, handler);
      return () => subscribers.delete(topic);
    },
    onReconnect: () => () => {},
  }),
}));

const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const APP = { pluginId: 'sandbox-buzzer', name: 'Sandbox Buzzer' };

let historyResponse: unknown = { messages: [] };

beforeEach(() => {
  // Settings are read once per page; every case is a fresh page.
  __resetNotificationPrefsForTests();
  subscribers.clear();
  historyResponse = { messages: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/messages')) return Response.json(historyResponse);
      if (url.includes('/typing')) return Response.json({ typers: [] });
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseData = {
  serverId: SERVER,
  channelId: CHANNEL,
  channelName: 'general',
  currentUserId: 'u1',
  voiceChannelId: null,
  knownNames: { u1: 'Ayşe', u2: 'Bora' },
  canManageMessages: false,
  initialMessages: [],
};

async function renderChannel(locale = 'en', data: Record<string, unknown> = {}) {
  const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyLiveRoster data={{ ...baseData, ...data } as typeof baseData} />
    </I18nProvider>
  );
}

const appMessage = (id: string, content: string) => ({
  id,
  userId: null,
  botId: null,
  bot: null,
  content,
  createdAt: new Date().toISOString(),
  metadata: { app: APP },
});

describe('app messages', () => {
  it('a post from the history shows the plugin, the app avatar and the APP badge — not a bot, a webhook or a deleted user', async () => {
    historyResponse = { messages: [appMessage('a1', 'Ayşe buzzed first (0.31 s)')] };
    const { container } = await renderChannel();
    const message = (await screen.findByText('Ayşe buzzed first (0.31 s)')).closest('[data-chat-message]') as HTMLElement;
    expect(message).toHaveAttribute('data-app-message', 'true');
    expect(message).toHaveTextContent('Sandbox Buzzer');
    const badge = within(message).getByText('APP');
    expect(badge).toHaveAttribute('data-app-badge');
    expect(badge).toHaveAttribute('title', 'Posted by the Sandbox Buzzer app during an activity, not by a member');
    expect(message.querySelector('[data-app-avatar]')).not.toBeNull();
    expect(within(message).queryByText('BOT')).toBeNull();
    expect(within(message).queryByText('WEBHOOK')).toBeNull();
    expect(message).not.toHaveTextContent('Deleted User');
    expect(container.querySelector('[data-bot-message]')).toBeNull();
  });

  it('says UYGULAMA in Turkish, for a post that arrives live', async () => {
    await renderChannel('tr');
    act(() => {
      subscribers.get(`chat:${SERVER}:${CHANNEL}`)!({
        type: 'message',
        message: { channelId: CHANNEL, ...appMessage('a2', 'Tur bitti') },
        at: new Date().toISOString(),
      });
    });
    const message = (await screen.findByText('Tur bitti')).closest('[data-chat-message]') as HTMLElement;
    const badge = within(message).getByText('UYGULAMA');
    expect(badge).toHaveAttribute('title', 'Bir etkinlik sırasında Sandbox Buzzer uygulaması gönderdi, bir üye değil');
    expect(message).not.toHaveTextContent('Silinmiş kullanıcı');
  });

  it('the server’s first paint carries the app the same way', async () => {
    // No history answer: what the server rendered stays.
    historyResponse = null;
    await renderChannel('en', {
      initialMessages: [
        {
          id: 'a3',
          authorId: null,
          author: 'Sandbox Buzzer',
          timestamp: '12:00',
          createdAt: new Date().toISOString(),
          body: 'Round 3 is over',
          app: APP,
        },
      ],
    });
    const message = (await screen.findByText('Round 3 is over')).closest('[data-chat-message]') as HTMLElement;
    expect(within(message).getByText('APP')).toBeInTheDocument();
  });

  it('ignores app metadata on a member’s message', async () => {
    historyResponse = {
      messages: [{ id: 'forged', userId: 'u2', botId: null, bot: null, content: 'I am the app', createdAt: new Date().toISOString(), metadata: { app: APP } }],
    };
    await renderChannel();
    const message = (await screen.findByText('I am the app')).closest('[data-chat-message]') as HTMLElement;
    expect(message).toHaveTextContent('Bora');
    expect(within(message).queryByText('APP')).toBeNull();
    expect(message).not.toHaveAttribute('data-app-message');
  });

  it('a desktop notification says it is an app (the badge cannot show there)', async () => {
    const shown: string[] = [];
    class FakeNotification {
      static permission = 'granted';
      constructor(title: string) {
        shown.push(title);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/settings/me')) {
        return Response.json({ settings: { notifications: { level: 'all', desktopEnabled: true, showPreview: true, sound: 'default' } } });
      }
      if (url.includes('/messages')) return Response.json({ messages: [] });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await renderChannel();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/me', expect.anything()));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      act(() => {
        subscribers.get(`chat:${SERVER}:${CHANNEL}`)!({
          type: 'message',
          message: { channelId: CHANNEL, ...appMessage('n-app', 'Round over') },
          at: new Date().toISOString(),
        });
      });
      expect(shown).toEqual(['Sandbox Buzzer (APP) in #general']);
    } finally {
      visibility.mockRestore();
    }
  });
});
