// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LobbyVoiceContext } from '../LobbyVoiceProvider';
import { makeVoice } from './voice-context';

const { subscribers, prefs } = vi.hoisted(() => ({
  subscribers: new Map<string, (data: unknown) => void>(),
  prefs: { current: { level: 'mentions', desktopEnabled: true, showPreview: true, sound: 'none', unreadBadge: true, suppressWhileInVoice: true } },
}));
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({
    subscribe: (topic: string, handler: (data: unknown) => void) => {
      subscribers.set(topic, handler);
      return () => subscribers.delete(topic);
    },
    onReconnect: () => () => {},
  }),
}));
vi.mock('@/lib/notification-prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notification-prefs')>();
  return { ...actual, loadNotificationPrefs: async () => prefs.current, playNotificationSound: vi.fn() };
});
vi.mock('../ProfileCardProvider', () => ({
  useProfileCard: () => ({ currentUserId: 'me', seedFor: (id: string) => (id === 'u2' ? { userId: 'u2', displayName: 'Bora' } : null) }),
}));

import { LobbyTextChannels } from '../LobbyTextChannels';

const CHANNELS = [
  { id: 'general', name: 'general', category: 'text' as const },
  { id: 'random', name: 'random', category: 'text' as const },
];

function renderList(voice = makeVoice({ serverId: 'srv-1', activeTextChannelId: 'general' })) {
  return render(
    <I18nProvider {...providerPropsFor('en')}>
      <LobbyVoiceContext.Provider value={voice}>
        <LobbyTextChannels channels={CHANNELS} />
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
}

function emit(data: unknown) {
  act(() => subscribers.get('user:me')!(data));
}

beforeEach(() => {
  subscribers.clear();
  prefs.current = { ...prefs.current, unreadBadge: true };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('channel mention badges (docs/PROFILES.md "Mentions")', () => {
  it('a mention in another channel of this community badges it, counting up', async () => {
    renderList();
    await waitFor(() => expect(subscribers.has('user:me')).toBe(true));
    emit({ type: 'mention', serverId: 'srv-1', channelId: 'random', messageId: 'm1', fromUserId: 'u2' });
    emit({ type: 'mention', serverId: 'srv-1', channelId: 'random', messageId: 'm2', fromUserId: 'u2' });
    const badge = await screen.findByTestId('channel-mention-badge');
    expect(badge).toHaveTextContent('2');
    expect(badge).toHaveTextContent('2 mentions');
  });

  it('not for the open channel, another community, or other event types', async () => {
    renderList();
    await waitFor(() => expect(subscribers.has('user:me')).toBe(true));
    emit({ type: 'mention', serverId: 'srv-1', channelId: 'general', messageId: 'm1', fromUserId: 'u2' });
    emit({ type: 'mention', serverId: 'srv-2', channelId: 'random', messageId: 'm1', fromUserId: 'u2' });
    emit({ type: 'dm_activity', channelId: 'random' });
    expect(screen.queryByTestId('channel-mention-badge')).toBeNull();
  });

  it('"Unread badge" off: no badge', async () => {
    prefs.current = { ...prefs.current, unreadBadge: false };
    renderList();
    await waitFor(() => expect(subscribers.has('user:me')).toBe(true));
    await act(async () => {});
    emit({ type: 'mention', serverId: 'srv-1', channelId: 'random', messageId: 'm1', fromUserId: 'u2' });
    expect(screen.queryByTestId('channel-mention-badge')).toBeNull();
  });

  it('a hidden tab gets a desktop notification naming the author and channel', async () => {
    const shown: Array<{ title: string }> = [];
    class FakeNotification {
      static permission = 'granted';
      constructor(title: string) {
        shown.push({ title });
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    renderList();
    await waitFor(() => expect(subscribers.has('user:me')).toBe(true));
    await act(async () => {});
    emit({ type: 'mention', serverId: 'srv-1', channelId: 'random', messageId: 'm1', fromUserId: 'u2' });
    expect(shown).toEqual([{ title: 'Bora mentioned you in #random' }]);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
});
