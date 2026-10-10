// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import type { ChatPollView } from '@/lib/chat-polls';
import { ChatPollCard } from '../ChatPollCard';
import { CreatePollDialog } from '../CreatePollDialog';
import { LobbyComposer } from '../LobbyComposer';

/**
 * Polls in text channels (docs/CHAT_POLLS.md) in the lobby: the poll card
 * (vote, results, change and remove a vote, close), the create dialog and
 * the composer's "Create poll" menu.
 */

const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const BASE = `/api/servers/${SERVER}/channels/${CHANNEL}/polls/poll-1`;
const HOUR = 60 * 60_000;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let respond: (call: Call) => Response;

function view(overrides: Partial<ChatPollView> = {}): ChatPollView {
  return {
    id: 'poll-1',
    messageId: 'msg-1',
    question: 'What should we play?',
    options: [
      { text: 'Hushle', votes: null },
      { text: 'Quiz', votes: null },
      { text: 'Vampire Village', votes: null },
    ],
    allowMultiple: false,
    closesAt: new Date(Date.now() + 3 * HOUR - 60_000).toISOString(),
    closedAt: null,
    closed: false,
    totalVoters: 4,
    myChoices: [],
    resultsVisible: false,
    version: 1,
    ...overrides,
  };
}

const counted = (votes: number[], extra: Partial<ChatPollView> = {}) =>
  view({ options: view().options.map((o, i) => ({ ...o, votes: votes[i] ?? 0 })), resultsVisible: true, ...extra });

beforeEach(() => {
  calls = [];
  respond = () => Response.json({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return respond(call);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness({ initial, canClose = false, locale = 'en' }: { initial: ChatPollView; canClose?: boolean; locale?: string }) {
  return (
    <I18nProvider {...providerPropsFor(locale)}>
      <Stateful initial={initial} canClose={canClose} />
    </I18nProvider>
  );
}

function Stateful({ initial, canClose }: { initial: ChatPollView; canClose: boolean }) {
  // A tiny stand-in for the roster: keeps the latest view the card reports.
  const [poll, setPoll] = useState(initial);
  return <ChatPollCard poll={poll} serverId={SERVER} channelId={CHANNEL} canClose={canClose} onChange={setPoll} />;
}

describe('ChatPollCard — before voting', () => {
  it('offers the options as a radio group with the question as its name, the voter total and no counts', () => {
    render(<Harness initial={view()} />);
    const group = screen.getByRole('group', { name: 'What should we play?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByText('4 people voted')).toBeInTheDocument();
    expect(screen.getByText('Closes in 3 hours')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Vote' })).toBeDisabled();
  });

  it('uses checkboxes when several answers are allowed', () => {
    render(<Harness initial={view({ allowMultiple: true })} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText(/Pick one or more/)).toBeInTheDocument();
  });

  it('votes from the keyboard, then shows bars with shares and counts and marks the viewer’s choice', async () => {
    const user = userEvent.setup();
    respond = (call) => (call.method === 'PUT' ? Response.json({ poll: counted([1, 3, 1], { myChoices: [1], totalVoters: 5 }) }) : Response.json({}));
    render(<Harness initial={view()} />);
    await user.tab();
    expect(screen.getAllByRole('radio')[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('radio')[1]).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Vote' }));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: `${BASE}/vote`, body: { choices: [1] } });

    const results = await screen.findByRole('list', { name: 'Results' });
    const rows = within(results).getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('Quiz');
    expect(rows[1]).toHaveTextContent('Your vote');
    expect(rows[1]).toHaveTextContent('60%');
    expect(rows[1]).toHaveTextContent('3 votes');
    expect(rows[0]).toHaveTextContent('20%');
    expect(rows[0]).toHaveTextContent('1 vote');
    expect(rows[1]).toHaveAttribute('data-poll-mine', 'true');
    expect(screen.getByText('5 people voted')).toHaveAttribute('aria-live', 'polite');
    // Keyboard focus moves to the results that replaced the form.
    expect(results).toHaveFocus();
  });
});

describe('ChatPollCard — after voting', () => {
  it('changes a vote and removes it', async () => {
    const user = userEvent.setup();
    respond = (call) => {
      if (call.method === 'PUT') return Response.json({ poll: counted([2, 2, 0], { myChoices: [0] }) });
      if (call.method === 'DELETE') return Response.json({ poll: view({ totalVoters: 3 }) });
      return Response.json({});
    };
    render(<Harness initial={counted([1, 3, 0], { myChoices: [1] })} />);
    await user.click(screen.getByRole('button', { name: 'Change vote' }));
    expect(screen.getAllByRole('radio')[1]).toBeChecked();
    expect(screen.getAllByRole('radio')[1]).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: 'Hushle' }));
    await user.click(screen.getByRole('button', { name: 'Vote' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('data-poll-mine', 'true'));

    await user.click(screen.getByRole('button', { name: 'Remove vote' }));
    expect(calls.at(-1)).toMatchObject({ url: `${BASE}/vote`, method: 'DELETE' });
    await screen.findByRole('button', { name: 'Vote' });
    expect(screen.getByText('3 people voted')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('radio')[0]).toHaveFocus());
  });

  it('says so when the poll closed in the meantime', async () => {
    const user = userEvent.setup();
    respond = (call) =>
      call.method === 'PUT'
        ? Response.json({ error: 'This poll is closed', code: 'poll_closed' }, { status: 409 })
        : Response.json({ poll: counted([2, 1, 1], { closed: true, closedAt: new Date().toISOString() }) });
    render(<Harness initial={view()} />);
    await user.click(screen.getByRole('radio', { name: 'Quiz' }));
    await user.click(screen.getByRole('button', { name: 'Vote' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This poll has closed.');
    // It fetches the final results it never had.
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url === BASE)).toBe(true));
    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('50%');
  });
});

describe('ChatPollCard — closed', () => {
  it('stays read-only with the final results and a Closed badge', () => {
    render(<Harness initial={counted([2, 1, 1], { closed: true, closedAt: new Date().toISOString(), myChoices: [2] })} canClose />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change vote' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove vote' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close poll' })).toBeNull();
    expect(screen.getAllByRole('listitem')[2]).toHaveTextContent('Your vote');
  });

  it('the creator (or a moderator) closes it after confirming', async () => {
    const user = userEvent.setup();
    respond = (call) =>
      call.method === 'POST' ? Response.json({ poll: counted([2, 1, 1], { closed: true, closedAt: new Date().toISOString() }) }) : Response.json({});
    render(<Harness initial={view()} canClose />);
    await user.click(screen.getByRole('button', { name: 'Close poll' }));
    expect(screen.getByText('Close the poll now? Nobody can vote after that.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close now' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Close poll' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close poll' }));
    await user.click(screen.getByRole('button', { name: 'Close now' }));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: `${BASE}/close` });
    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('this browser’s clock says closed but the server does not yet: no fake zeros, it asks again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let gets = 0;
      respond = (call) => {
        if (call.method !== 'GET') return Response.json({});
        gets += 1;
        return gets === 1
          ? Response.json({ poll: view({ closesAt: new Date(Date.now() + 30_000).toISOString() }) })
          : Response.json({ poll: counted([2, 1, 1], { closed: true, closedAt: new Date().toISOString() }) });
      };
      render(<Harness initial={view({ closesAt: new Date(Date.now() - 1000).toISOString() })} />);
      expect(screen.getByText('Closed')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Loading the final results…');
      expect(screen.queryByText(/%/)).toBeNull();
      expect(screen.queryByText(/0 votes/)).toBeNull();
      await waitFor(() => expect(gets).toBe(1));
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => expect(gets).toBe(2));
      expect(await screen.findByText('50%')).toBeInTheDocument();
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no close control for other members', () => {
    render(<Harness initial={view()} />);
    expect(screen.queryByRole('button', { name: 'Close poll' })).toBeNull();
  });
});

describe('ChatPollCard — Turkish', () => {
  it('speaks Turkish, with plurals', () => {
    render(<Harness initial={counted([1, 0, 0], { myChoices: [0], totalVoters: 1 })} locale="tr" />);
    expect(screen.getByText('1 kişi oy verdi')).toBeInTheDocument();
    expect(screen.getByText('Senin seçimin')).toBeInTheDocument();
    expect(screen.getByText('3 saat sonra kapanıyor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Oyumu geri çek' })).toBeInTheDocument();
  });
});

function renderDialog(onCreated = vi.fn(), onClose = vi.fn()) {
  render(
    <I18nProvider {...providerPropsFor('en')}>
      <CreatePollDialog open onClose={onClose} serverId={SERVER} channelId={CHANNEL} channelName="general" onCreated={onCreated} />
    </I18nProvider>
  );
  return { onCreated, onClose };
}

describe('CreatePollDialog', () => {
  it('posts a question, answers, multiple choice and a duration', async () => {
    const user = userEvent.setup();
    respond = () =>
      Response.json(
        { message: { id: 'msg-9', content: 'Pizza?', userId: 'u1', createdAt: new Date().toISOString() }, poll: view({ id: 'poll-9', messageId: 'msg-9', question: 'Pizza?' }) },
        { status: 201 }
      );
    const { onCreated, onClose } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Create a poll' });
    await user.type(within(dialog).getByLabelText('Question'), '  Pizza?  ');
    await user.type(within(dialog).getByLabelText('Answer 1'), 'Yes');
    await user.type(within(dialog).getByLabelText('Answer 2'), 'No');
    await user.click(within(dialog).getByRole('button', { name: 'Add answer' }));
    await user.type(within(dialog).getByLabelText('Answer 3'), 'Maybe');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Allow multiple answers' }));
    expect(within(dialog).getByRole('combobox', { name: 'Duration' })).toHaveValue('24');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Duration' }), '72');
    await user.click(within(dialog).getByRole('button', { name: 'Post poll' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: `/api/servers/${SERVER}/channels/${CHANNEL}/polls`,
      method: 'POST',
      body: { question: 'Pizza?', options: ['Yes', 'No', 'Maybe'], allowMultiple: true, durationHours: 72 },
    });
    expect(onCreated.mock.calls[0]![0]).toMatchObject({ message: { id: 'msg-9' }, poll: { id: 'poll-9' } });
    expect(onClose).toHaveBeenCalled();
  });

  it('offers the six durations, 24 hours by default', () => {
    renderDialog();
    const select = screen.getByRole('combobox', { name: 'Duration' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['1 hour', '4 hours', '8 hours', '24 hours', '3 days', '7 days']);
  });

  it('checks the draft before sending: a question, two answers, no repeats', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Post poll' }));
    expect(screen.getByText('Write a question first.')).toBeInTheDocument();
    expect(screen.getByText('Fill in at least 2 answers.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Question'), 'Pizza?');
    await user.type(screen.getByLabelText('Answer 1'), 'Yes');
    await user.type(screen.getByLabelText('Answer 2'), ' YES ');
    expect(screen.getByText('This answer repeats an earlier one.')).toBeInTheDocument();
    expect(screen.getByLabelText('Answer 2')).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Post poll' }));
    expect(calls).toHaveLength(0);
  });

  it('caps the answers at ten and keeps at least two', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByRole('button', { name: /Remove answer/ })).toBeNull();
    for (let i = 0; i < 8; i += 1) await user.click(screen.getByRole('button', { name: 'Add answer' }));
    expect(screen.getByLabelText('Answer 10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add answer' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove answer 10' }));
    expect(screen.queryByLabelText('Answer 10')).toBeNull();
  });

  it('explains a Moderation Bot refusal in words and keeps the draft', async () => {
    const user = userEvent.setup();
    respond = () => Response.json({ code: 'blocked_by_moderation', rule: 'blocked_word' }, { status: 422 });
    const { onCreated } = renderDialog();
    await user.type(screen.getByLabelText('Question'), 'Pizza?');
    await user.type(screen.getByLabelText('Answer 1'), 'Yes');
    await user.type(screen.getByLabelText('Answer 2'), 'No');
    await user.click(screen.getByRole('button', { name: 'Post poll' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toBe('');
    expect(alert.textContent).not.toContain('blocked_word');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Question')).toHaveValue('Pizza?');
  });
});

describe('the composer’s Create poll menu', () => {
  function renderComposer(canCreatePolls: boolean) {
    return render(
      <I18nProvider {...providerPropsFor('en')}>
        <LobbyComposer channelName="general" serverId={SERVER} channelId={CHANNEL} live members={[]} canCreatePolls={canCreatePolls} />
      </I18nProvider>
    );
  }

  it('opens a menu with Create poll, which opens the dialog; Escape closes the menu', async () => {
    const user = userEvent.setup();
    renderComposer(true);
    const button = screen.getByRole('button', { name: 'More actions' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const item = screen.getByRole('menuitem', { name: 'Create poll' });
    expect(item).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();

    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Create poll' }));
    expect(screen.getByRole('dialog', { name: 'Create a poll' })).toBeInTheDocument();
  });

  it('keeps the old disabled placeholder for a member who may not post polls', () => {
    renderComposer(false);
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.getByTitle('Attachments are not enabled yet')).toBeDisabled();
  });
});
