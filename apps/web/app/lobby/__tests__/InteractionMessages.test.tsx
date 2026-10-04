// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { interactionStore } from '@/lib/bots/interaction-store';

/**
 * What slash commands and webhooks add to the message list: the invoker's
 * pending row ("<bot> is thinking…" → answered / "did not respond"),
 * ephemeral answers from `user:{uid}` ("Only you can see this · Dismiss"),
 * the "↳ <user> used /<command>" header and the WEBHOOK badge.
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
const DICE = { id: 'b-dice', name: 'Dice', type: 'custom' };

let historyResponse: unknown = { messages: [] };

beforeEach(() => {
  subscribers.clear();
  interactionStore.reset();
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
  interactionStore.reset();
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

async function renderChannel(locale = 'en') {
  const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
  const { useUserInteractionFeed } = await import('../slash/useUserInteractionFeed');
  const { InteractionAnnouncer } = await import('../slash/InteractionRows');
  function Harness() {
    useUserInteractionFeed('u1');
    return (
      <>
        <LobbyLiveRoster data={baseData} />
        <InteractionAnnouncer />
      </>
    );
  }
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <Harness />
    </I18nProvider>
  );
}

function pending(id = 'int-1', extra: Partial<Parameters<typeof interactionStore.addPending>[0]> = {}) {
  act(() => {
    interactionStore.addPending({ id, serverId: SERVER, channelId: CHANNEL, botId: 'b-dice', botName: 'Dice', commandName: 'roll', ...extra });
  });
}

describe('pending row', () => {
  it('shows "<bot> is thinking…" to the invoker and announces it', async () => {
    const { container } = await renderChannel();
    pending();
    const row = container.querySelector('[data-interaction-pending]') as HTMLElement;
    expect(row).toHaveTextContent('Dice is thinking…');
    expect(row).toHaveTextContent('Ayşe used /roll');
    expect(within(row).getByText('BOT')).toBeInTheDocument();
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Dice is thinking…');
  });

  it('resolves when the public answer arrives, matched by metadata.interaction.id', async () => {
    const { container } = await renderChannel();
    pending();
    act(() => {
      subscribers.get(`chat:${SERVER}:${CHANNEL}`)!({
        type: 'message',
        message: {
          id: 'm-answer',
          channelId: CHANNEL,
          userId: null,
          botId: 'b-dice',
          bot: DICE,
          content: '🎲 17',
          metadata: { bot: DICE, interaction: { id: 'int-1', commandName: 'roll', invokedBy: 'u1' } },
          createdAt: new Date().toISOString(),
        },
        at: new Date().toISOString(),
      });
    });
    await screen.findByText('🎲 17');
    expect(container.querySelector('[data-interaction-pending]')).toBeNull();
    const answer = screen.getByText('🎲 17').closest('[data-chat-message]') as HTMLElement;
    expect(answer.querySelector('[data-interaction-header]')).toHaveTextContent('Ayşe used /roll');
    expect(screen.getByRole('status')).toHaveTextContent('Dice answered');
  });

  it('turns into "<bot> did not respond" at expiry, and can be dismissed', async () => {
    const user = userEvent.setup();
    const { container } = await renderChannel();
    pending('int-2', { expiresAt: new Date(Date.now() + 30).toISOString() });
    await screen.findByText('Dice did not respond', { selector: 'p' }, { timeout: 2000 });
    const row = container.querySelector('[data-interaction-pending]') as HTMLElement;
    expect(row).toHaveAttribute('data-status', 'expired');
    expect(row).toHaveTextContent('Only you can see this');
    await user.click(within(row).getByRole('button', { name: 'Dismiss: Dice did not respond' }));
    expect(container.querySelector('[data-interaction-pending]')).toBeNull();
  });

  it('only shows rows for this channel', async () => {
    const { container } = await renderChannel();
    pending('int-3', { channelId: 'other' });
    expect(container.querySelector('[data-interaction-pending]')).toBeNull();
  });
});

describe('ephemeral answers', () => {
  it('render inline from user:{uid}, marked "Only you can see this", until dismissed', async () => {
    const user = userEvent.setup();
    const { container } = await renderChannel();
    pending();
    const feed = subscribers.get('user:u1');
    expect(feed).toBeDefined();
    act(() => {
      feed!({
        type: 'interaction_response',
        interaction: { id: 'int-1', serverId: SERVER, channelId: CHANNEL, commandName: 'roll', bot: { id: 'b-dice', name: 'Dice' } },
        response: { content: 'Only you rolled a 4', ephemeral: true },
        at: new Date().toISOString(),
      });
    });
    const row = container.querySelector('[data-ephemeral-answer]') as HTMLElement;
    expect(row).toHaveTextContent('Only you rolled a 4');
    expect(row).toHaveTextContent('Only you can see this');
    expect(row).toHaveTextContent('Ayşe used /roll');
    expect(container.querySelector('[data-interaction-pending]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Dice answered. Only you can see it.');

    await user.click(within(row).getByRole('button', { name: 'Dismiss the answer from Dice' }));
    expect(container.querySelector('[data-ephemeral-answer]')).toBeNull();
  });

  it('stays out of other channels and is translated', async () => {
    const { container } = await renderChannel('tr');
    act(() => {
      subscribers.get('user:u1')!({ interactionId: 'int-9', channelId: CHANNEL, content: 'Gizli', botName: 'Dice' });
      subscribers.get('user:u1')!({ interactionId: 'int-8', channelId: 'other', content: 'Elsewhere', botName: 'Dice' });
    });
    const rows = container.querySelectorAll('[data-ephemeral-answer]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Bunu yalnızca sen görebilirsin');
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: 'Dice botunun yanıtını kapat' })).toHaveTextContent('Kapat');
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });
});

describe('message rendering', () => {
  it('shows the interaction header on a bot answer from the history', async () => {
    historyResponse = {
      messages: [
        {
          id: 'm1',
          userId: null,
          botId: 'b-dice',
          bot: DICE,
          content: 'Heads',
          createdAt: new Date().toISOString(),
          metadata: { bot: DICE, interaction: { id: 'int-5', commandName: 'flip', invokedBy: { id: 'u9', displayName: 'Cem' } } },
        },
        {
          id: 'm0',
          userId: null,
          botId: 'b-dice',
          bot: DICE,
          content: 'Tails',
          createdAt: new Date().toISOString(),
          metadata: { bot: DICE, interaction: { id: 'int-4', commandName: 'flip', invokedBy: 'u2' } },
        },
      ],
    };
    await renderChannel();
    const heads = (await screen.findByText('Heads')).closest('[data-chat-message]') as HTMLElement;
    expect(heads.querySelector('[data-interaction-header]')).toHaveTextContent('↳Cem used /flip');
    // Only the id: the name comes from the members the lobby knows.
    const tails = screen.getByText('Tails').closest('[data-chat-message]') as HTMLElement;
    expect(tails.querySelector('[data-interaction-header]')).toHaveTextContent('Bora used /flip');
  });

  it('renders a webhook post with its name and the WEBHOOK badge — never as a bot or a person', async () => {
    historyResponse = {
      messages: [
        {
          id: 'w-msg',
          userId: null,
          botId: null,
          bot: null,
          content: 'Build #42 passed',
          createdAt: new Date().toISOString(),
          metadata: { webhook: { id: 'w1', name: 'CI', username: 'Deploy bot' } },
        },
      ],
    };
    const { container } = await renderChannel();
    const message = (await screen.findByText('Build #42 passed')).closest('[data-chat-message]') as HTMLElement;
    expect(message).toHaveAttribute('data-webhook-message', 'true');
    expect(message).toHaveTextContent('Deploy bot');
    expect(within(message).getByText('WEBHOOK')).toBeInTheDocument();
    expect(within(message).queryByText('BOT')).toBeNull();
    expect(message.querySelector('[data-webhook-avatar]')).not.toBeNull();
    expect(message).not.toHaveTextContent('Deleted User');
    expect(container.querySelector('[data-bot-message]')).toBeNull();
  });

  it('ignores webhook or interaction metadata on a member’s message', async () => {
    historyResponse = {
      messages: [
        {
          id: 'forged',
          userId: 'u2',
          botId: null,
          bot: null,
          content: 'trust me',
          createdAt: new Date().toISOString(),
          metadata: { webhook: { id: 'w1', name: 'CI' }, interaction: { id: 'x', commandName: 'admin', invokedBy: 'u1' } },
        },
      ],
    };
    await renderChannel();
    const message = (await screen.findByText('trust me')).closest('[data-chat-message]') as HTMLElement;
    expect(message).toHaveTextContent('Bora');
    expect(within(message).queryByText('WEBHOOK')).toBeNull();
    expect(message.querySelector('[data-interaction-header]')).toBeNull();
  });

  it('settles a pending row whose answer is already in the history', async () => {
    pending('int-7');
    historyResponse = {
      messages: [
        {
          id: 'm7',
          userId: null,
          botId: 'b-dice',
          bot: DICE,
          content: 'done',
          createdAt: new Date().toISOString(),
          metadata: { bot: DICE, interaction: { id: 'int-7', commandName: 'roll', invokedBy: 'u1' } },
        },
      ],
    };
    const { container } = await renderChannel();
    await screen.findByText('done');
    await waitFor(() => expect(container.querySelector('[data-interaction-pending]')).toBeNull());
  });
});

describe('desktop notifications', () => {
  it('a webhook or bot message says so in the title (the badge cannot show there); a member’s does not', async () => {
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
      const publish = (message: Record<string, unknown>) =>
        act(() => {
          subscribers.get(`chat:${SERVER}:${CHANNEL}`)!({
            type: 'message',
            message: { channelId: CHANNEL, createdAt: new Date().toISOString(), ...message },
            at: new Date().toISOString(),
          });
        });
      publish({ id: 'n-hook', userId: null, botId: null, content: 'Deployed', metadata: { webhook: { id: 'w1', name: 'CI', username: 'GitHub' } } });
      publish({ id: 'n-bot', userId: null, botId: 'b-dice', bot: DICE, content: '🎲 4', metadata: { bot: DICE } });
      publish({ id: 'n-member', userId: 'u2', content: 'hi', metadata: {} });
      expect(shown).toEqual(['GitHub (WEBHOOK) in #general', 'Dice (BOT) in #general', 'Bora in #general']);
    } finally {
      visibility.mockRestore();
    }
  });
});
