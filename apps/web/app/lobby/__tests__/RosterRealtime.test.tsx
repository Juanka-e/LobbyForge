// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { interactionStore } from '@/lib/bots/interaction-store';
import type { ChatPollView } from '@/lib/chat-polls';

/**
 * The chat topic beyond new messages: an edit (`message_update`, ids only)
 * is refetched and shown without a reload, a delete (`message_delete`)
 * disappears at once, and a `poll_update` moves a poll card — counts for a
 * member who voted, only the voter total for one who has not.
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
const HOUR = 60 * 60_000;

let history: unknown[] = [];
let single: Record<string, { status: number; body: unknown }> = {};
const fetchCalls: string[] = [];

function apiMessage(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, userId: 'u2', content, createdAt: new Date('2026-10-10T10:00:00Z').toISOString(), metadata: {}, blocked: false, ...extra };
}

function pollView(overrides: Partial<ChatPollView> = {}): ChatPollView {
  return {
    id: 'poll-1',
    messageId: 'msg-poll',
    question: 'Pizza?',
    options: [
      { text: 'Yes', votes: null },
      { text: 'No', votes: null },
    ],
    allowMultiple: false,
    closesAt: new Date(Date.now() + 5 * HOUR).toISOString(),
    closedAt: null,
    closed: false,
    totalVoters: 1,
    myChoices: [],
    resultsVisible: false,
    ...overrides,
  };
}

beforeEach(() => {
  subscribers.clear();
  interactionStore.reset();
  history = [];
  single = {};
  fetchCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(url);
      const one = /\/messages\/([^/?]+)$/.exec(url);
      if (one) {
        const entry = single[decodeURIComponent(one[1]!)];
        return entry ? Response.json(entry.body, { status: entry.status }) : Response.json({ error: 'Message not found' }, { status: 404 });
      }
      if (url.includes('/messages')) return Response.json({ messages: history });
      if (url.includes('/typing')) return Response.json({ typers: [] });
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderRoster() {
  const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
  const utils = render(
    <I18nProvider {...providerPropsFor('en')}>
      <LobbyLiveRoster
        data={{
          serverId: SERVER,
          channelId: CHANNEL,
          channelName: 'general',
          currentUserId: 'u1',
          voiceChannelId: null,
          knownNames: { u1: 'Ayşe', u2: 'Bora' },
          canManageMessages: false,
          initialMessages: [],
        }}
      />
    </I18nProvider>
  );
  await waitFor(() => expect(subscribers.has(TOPIC)).toBe(true));
  return utils;
}

function emit(envelope: unknown) {
  act(() => {
    subscribers.get(TOPIC)!(envelope);
  });
}

describe('edits and deletes arrive live (no reload)', () => {
  it('message_update refetches that one message and shows the new text', async () => {
    history = [apiMessage('m1', 'first take')];
    await renderRoster();
    await screen.findByText('first take');
    single.m1 = { status: 200, body: { message: apiMessage('m1', 'second take', { editedAt: new Date().toISOString() }) } };
    emit({ type: 'message_update', message: { id: 'm1' }, at: new Date().toISOString() });
    expect(await screen.findByText('second take')).toBeInTheDocument();
    expect(screen.queryByText('first take')).toBeNull();
    expect(fetchCalls.some((u) => u.endsWith(`/channels/${CHANNEL}/messages/m1`))).toBe(true);
  });

  it('an edited message the viewer can no longer see (404) is dropped', async () => {
    history = [apiMessage('m1', 'hello')];
    await renderRoster();
    await screen.findByText('hello');
    emit({ type: 'message_update', message: { id: 'm1' } });
    await waitFor(() => expect(screen.queryByText('hello')).toBeNull());
  });

  it('message_delete removes the message at once', async () => {
    history = [apiMessage('m1', 'keep me'), apiMessage('m2', 'delete me')];
    await renderRoster();
    await screen.findByText('delete me');
    emit({ type: 'message_delete', id: 'm2', at: new Date().toISOString() });
    expect(screen.queryByText('delete me')).toBeNull();
    expect(screen.getByText('keep me')).toBeInTheDocument();
  });

  it('ignores malformed envelopes', async () => {
    history = [apiMessage('m1', 'steady')];
    await renderRoster();
    await screen.findByText('steady');
    emit({ type: 'message_delete' });
    emit({ type: 'message_update', message: {} });
    emit({ type: 'poll_update', poll: { id: 'x' } });
    emit(null);
    expect(screen.getByText('steady')).toBeInTheDocument();
  });
});

describe('poll messages in the roster', () => {
  it('a poll from the history renders as a card, without the edit control', async () => {
    history = [apiMessage('msg-poll', 'Pizza?', { userId: 'u1', metadata: { poll: { id: 'poll-1' } }, poll: pollView() })];
    const { container } = await renderRoster();
    const card = await waitFor(() => {
      const el = container.querySelector('[data-chat-poll="poll-1"]');
      if (!el) throw new Error('no card yet');
      return el as HTMLElement;
    });
    expect(within(card).getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByTitle('Edit')).toBeNull();
  });

  it('a new poll arriving live renders as a card', async () => {
    const { container } = await renderRoster();
    emit({
      type: 'message',
      message: { id: 'msg-poll', channelId: CHANNEL, userId: 'u2', content: 'Pizza?', metadata: { poll: { id: 'poll-1' } }, createdAt: new Date().toISOString(), poll: pollView({ totalVoters: 0 }) },
      at: new Date().toISOString(),
    });
    expect(container.querySelector('[data-chat-poll="poll-1"]')).not.toBeNull();
    expect(screen.getByText('No votes yet')).toBeInTheDocument();
  });

  it('the composer’s own poll shows at once (local echo)', async () => {
    const { container } = await renderRoster();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('lf-message-sent', {
          detail: { channelId: CHANNEL, message: { id: 'msg-poll', content: 'Pizza?', userId: 'u1', createdAt: new Date().toISOString() }, poll: pollView() },
        })
      );
    });
    expect(container.querySelector('[data-chat-poll="poll-1"]')).not.toBeNull();
  });

  it('poll_update moves only the voter total for a member who has not voted', async () => {
    history = [apiMessage('msg-poll', 'Pizza?', { metadata: { poll: { id: 'poll-1' } }, poll: pollView() })];
    await renderRoster();
    await screen.findByText('1 person voted');
    emit({ type: 'poll_update', poll: { id: 'poll-1', messageId: 'msg-poll', counts: [2, 1], totalVoters: 3, closesAt: pollView().closesAt, closedAt: null, closed: false } });
    expect(await screen.findByText('3 people voted')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('poll_update moves the counts for a member who voted, and closes the card for everyone', async () => {
    history = [
      apiMessage('msg-poll', 'Pizza?', {
        metadata: { poll: { id: 'poll-1' } },
        poll: pollView({ myChoices: [0], resultsVisible: true, options: [{ text: 'Yes', votes: 1 }, { text: 'No', votes: 0 }] }),
      }),
    ];
    await renderRoster();
    await screen.findByText('100%');
    emit({ type: 'poll_update', poll: { id: 'poll-1', messageId: 'msg-poll', counts: [1, 3], totalVoters: 4, closesAt: pollView().closesAt, closedAt: null, closed: false } });
    expect(await screen.findByText('75%')).toBeInTheDocument();
    emit({ type: 'poll_update', poll: { id: 'poll-1', messageId: 'msg-poll', counts: [1, 3], totalVoters: 4, closesAt: pollView().closesAt, closedAt: new Date().toISOString(), closed: true } });
    expect(await screen.findByText('Closed')).toBeInTheDocument();
  });
});
