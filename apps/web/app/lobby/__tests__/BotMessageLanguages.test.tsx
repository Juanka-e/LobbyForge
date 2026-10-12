// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';

/**
 * A built-in bot's default greeting / notice and default name reach every
 * viewer in their OWN language — from the history fetch and the realtime
 * feed alike (the first server render is covered in
 * lib/bots/__tests__/bot-i18n.test.ts). An admin's own text and a renamed
 * bot are shown exactly as stored; an unknown key falls back to `content`.
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
const WELCOME = { id: 'bot-w', name: 'Welcome Bot', type: 'welcome', defaultName: true };
const MODERATION = { id: 'bot-m', name: 'Moderation Bot', type: 'moderation', defaultName: true };

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

const baseData = {
  serverId: SERVER,
  channelId: CHANNEL,
  channelName: 'general',
  currentUserId: 'u1',
  voiceChannelId: null,
  knownNames: { u1: 'Ayşe' },
  canManageMessages: false,
  initialMessages: [],
};

function greeting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-welcome',
    userId: null,
    botId: WELCOME.id,
    bot: WELCOME,
    content: 'Welcome to Oyun Gecesi, Mert! Glad you are here.',
    createdAt: new Date().toISOString(),
    metadata: {
      bot: { id: WELCOME.id, name: WELCOME.name, type: 'welcome' },
      i18n: { key: 'bots.welcome.defaultTemplate', params: { user: 'Mert', server: 'Oyun Gecesi' } },
    },
    ...overrides,
  };
}

const notice = {
  id: 'm-notice',
  userId: null,
  botId: MODERATION.id,
  bot: MODERATION,
  content: 'A message from Mallory was blocked by the moderation filter.',
  createdAt: new Date().toISOString(),
  metadata: {
    bot: { id: MODERATION.id, name: MODERATION.name, type: 'moderation' },
    i18n: { key: 'bots.moderation.defaultNotice', params: { user: 'Mallory' } },
  },
};

async function renderRoster(locale: 'en' | 'tr') {
  const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyLiveRoster data={baseData} />
    </I18nProvider>
  );
}

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('[data-chat-message]') as HTMLElement;
}

describe('built-in bot messages from the history fetch', () => {
  it('an English viewer reads the default texts and names in English', async () => {
    historyResponse = { messages: [greeting(), notice] };
    await renderRoster('en');
    await screen.findByText('Welcome to Oyun Gecesi, Mert! Glad you are here.');
    expect(rowOf('Welcome to Oyun Gecesi, Mert! Glad you are here.')).toHaveTextContent('Welcome Bot');
    expect(rowOf('A message from Mallory was blocked by the moderation filter.')).toHaveTextContent('Moderation Bot');
  });

  it('a Turkish viewer reads the SAME rows in Turkish', async () => {
    historyResponse = { messages: [greeting(), notice] };
    await renderRoster('tr');
    await screen.findByText('Mert, Oyun Gecesi sunucusuna hoş geldin! Seni aramızda görmek güzel.');
    expect(rowOf('Mert, Oyun Gecesi sunucusuna hoş geldin! Seni aramızda görmek güzel.')).toHaveTextContent('Karşılama Botu');
    expect(rowOf('Mallory kullanıcısının bir mesajı moderasyon filtresine takıldı.')).toHaveTextContent('Moderasyon Botu');
    expect(screen.queryByText('Welcome to Oyun Gecesi, Mert! Glad you are here.')).toBeNull();
  });

  it('an admin’s own text and a renamed bot are shown exactly as stored', async () => {
    historyResponse = {
      messages: [
        greeting({
          bot: { id: WELCOME.id, name: 'Kapıcı', type: 'welcome' },
          content: 'Hoş geldin Mert, kuralları oku!',
          metadata: { bot: { id: WELCOME.id, name: 'Kapıcı', type: 'welcome' } },
        }),
      ],
    };
    await renderRoster('en');
    await screen.findByText('Hoş geldin Mert, kuralları oku!');
    expect(rowOf('Hoş geldin Mert, kuralları oku!')).toHaveTextContent('Kapıcı');
  });

  it('an unknown key falls back to the stored content', async () => {
    historyResponse = {
      messages: [
        greeting({
          content: 'Stored fallback text',
          metadata: { bot: { id: WELCOME.id, name: WELCOME.name, type: 'welcome' }, i18n: { key: 'bots.welcome.someFutureKey', params: {} } },
        }),
      ],
    };
    await renderRoster('tr');
    expect(await screen.findByText('Stored fallback text')).toBeInTheDocument();
  });

  it('a member’s message carrying `i18n` is not rewritten', async () => {
    historyResponse = {
      messages: [
        {
          id: 'm-forged',
          userId: 'u1',
          botId: null,
          bot: null,
          content: 'just text',
          createdAt: new Date().toISOString(),
          metadata: { i18n: { key: 'bots.welcome.defaultTemplate', params: { user: 'x', server: 'y' } } },
        },
      ],
    };
    await renderRoster('en');
    expect(await screen.findByText('just text')).toBeInTheDocument();
  });
});

describe('built-in bot messages from the realtime feed', () => {
  it('the live row is rendered in the viewer’s language too', async () => {
    historyResponse = null;
    await renderRoster('tr');
    const handler = subscribers.get(`chat:${SERVER}:${CHANNEL}`);
    expect(handler).toBeDefined();
    act(() => {
      handler!({ type: 'message', message: { ...greeting(), channelId: CHANNEL }, at: new Date().toISOString() });
    });
    await screen.findByText('Mert, Oyun Gecesi sunucusuna hoş geldin! Seni aramızda görmek güzel.');
    expect(rowOf('Mert, Oyun Gecesi sunucusuna hoş geldin! Seni aramızda görmek güzel.')).toHaveTextContent('Karşılama Botu');
  });
});
