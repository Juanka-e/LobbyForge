// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';

/**
 * Bots in the lobby: the members panel lists them in their own group with
 * the BOT badge and a bot profile; the chat shows bot messages with the
 * badge and the robot avatar — from the first paint, the history fetch
 * and the realtime feed alike.
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
vi.mock('../LobbyVoiceProvider', () => ({
  useLobbyVoice: () => ({ getRemoteVolume: () => 1, setRemoteVolume: () => {} }),
}));

const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const BOT_META = { id: 'bot-1', name: 'Greeter', type: 'welcome' };

let historyResponse: unknown = { messages: [] };

beforeEach(() => {
  subscribers.clear();
  historyResponse = { messages: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/messages')) return Response.json(historyResponse);
      if (url.includes('/typing')) return Response.json({ typers: [] });
      if (url.includes('/api/presence')) return Response.json({ presences: [] });
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(ui: React.ReactElement, locale = 'en') {
  return render(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);
}

describe('members panel', () => {
  it('lists bots in their own group with the BOT badge and opens the bot profile', async () => {
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    wrap(
      <LobbyMembersClient
        serverId={SERVER}
        initialMembers={[{ id: 'u1', name: 'Ayşe', status: 'online' }]}
        voiceChannelIds={[]}
        currentUserId="u1"
        botSettingsHref="/admin/settings/bots"
        bots={[
          {
            id: 'bot-1',
            name: 'Greeter',
            type: 'welcome',
            builtIn: true,
            trustLevel: 'official',
            permissions: ['send_messages'],
            installedBy: 'Ayşe',
          },
        ]}
      />
    );
    const group = screen.getByTestId('members-bots');
    expect(group).toHaveTextContent('Bots - 1');
    const row = within(group).getByRole('button', { name: /Greeter/ });
    expect(within(row).getByText('BOT')).toBeInTheDocument();

    fireEvent.click(row);
    const profile = screen.getByRole('dialog', { name: 'Greeter bot profile' });
    expect(profile).toHaveTextContent('Official');
    expect(profile).toHaveTextContent('Send messages');
    expect(within(profile).getByRole('link', { name: /Bot settings/ })).toBeInTheDocument();
  });

  it('shows no bot group when the server has none', async () => {
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    wrap(<LobbyMembersClient serverId={SERVER} initialMembers={[]} voiceChannelIds={[]} currentUserId={null} />);
    expect(screen.queryByTestId('members-bots')).toBeNull();
  });
});

describe('chat', () => {
  const baseData = {
    serverId: SERVER,
    channelId: CHANNEL,
    channelName: 'general',
    currentUserId: 'u1',
    voiceChannelId: null,
    knownNames: { u1: 'Ayşe' },
    canManageMessages: false,
  };

  it('renders a bot message from the first paint with the badge and robot avatar', async () => {
    historyResponse = null;
    const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
    const { container } = wrap(
      <LobbyLiveRoster
        data={{
          ...baseData,
          initialMessages: [
            {
              id: 'm1',
              authorId: null,
              author: 'Greeter',
              timestamp: 'Today at 10:00',
              createdAt: new Date().toISOString(),
              body: 'Welcome to the server, Ayşe!',
              bot: BOT_META,
            },
          ],
        }}
      />
    );
    const message = container.querySelector('[data-bot-message="true"]') as HTMLElement;
    expect(message).not.toBeNull();
    expect(message).toHaveTextContent('Greeter');
    expect(within(message).getByText('BOT')).toBeInTheDocument();
    expect(message.querySelector('[data-bot-avatar]')).not.toBeNull();
    expect(message.querySelector('[data-chat-avatar]')).toBeNull();
  });

  it('renders bot messages from the history fetch', async () => {
    historyResponse = {
      messages: [
        { id: 'm2', userId: null, botId: 'bot-1', bot: BOT_META, content: 'Hello!', createdAt: new Date().toISOString(), metadata: {} },
        { id: 'm1', userId: 'u1', botId: null, bot: null, content: 'hi', createdAt: new Date().toISOString(), metadata: {} },
      ],
    };
    const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
    const { container } = wrap(<LobbyLiveRoster data={{ ...baseData, initialMessages: [] }} />);
    await screen.findByText('Hello!');
    const botMessages = container.querySelectorAll('[data-bot-message="true"]');
    expect(botMessages).toHaveLength(1);
    expect(botMessages[0]).toHaveTextContent('Greeter');
    // A member's message never gets the badge.
    const human = screen.getByText('hi').closest('[data-chat-message]') as HTMLElement;
    expect(within(human).queryByText('BOT')).toBeNull();
  });

  it('renders a realtime bot message with the badge', async () => {
    historyResponse = null;
    const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
    const { container } = wrap(<LobbyLiveRoster data={{ ...baseData, initialMessages: [] }} />);
    const handler = subscribers.get(`chat:${SERVER}:${CHANNEL}`);
    expect(handler).toBeDefined();
    act(() => {
      handler!({
        type: 'message',
        message: { id: 'rt1', channelId: CHANNEL, userId: null, bot: BOT_META, content: 'Beep!', createdAt: new Date().toISOString() },
        at: new Date().toISOString(),
      });
    });
    await screen.findByText('Beep!');
    const message = container.querySelector('[data-bot-message="true"]') as HTMLElement;
    expect(message).toHaveTextContent('Greeter');
    expect(within(message).getByText('BOT')).toBeInTheDocument();
  });

  it('falls back to a translated bot label when a bot has no name', async () => {
    historyResponse = {
      messages: [{ id: 'm3', userId: null, botId: null, bot: { id: null, name: '', type: 'custom' }, content: 'orphan', createdAt: new Date().toISOString(), metadata: {} }],
    };
    const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
    const { container } = wrap(<LobbyLiveRoster data={{ ...baseData, initialMessages: [] }} />, 'tr');
    await screen.findByText('orphan');
    const message = container.querySelector('[data-bot-message="true"]') as HTMLElement;
    expect(message).toHaveTextContent('Bot');
    expect(message).not.toHaveTextContent('Silinmiş kullanıcı');
  });
});
