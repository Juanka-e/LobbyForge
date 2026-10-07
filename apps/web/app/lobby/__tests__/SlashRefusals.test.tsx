// @vitest-environment happy-dom
/**
 * Slash command refusals carry a machine `code` (shared with the activity
 * routes). The composer says each one in the member's language, at once,
 * in the command form — never the server's English — and offers to open
 * an activity that is already running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { invalidateChannelCommands, invokeErrorKey } from '@/lib/bots/client-api';
import { interactionStore } from '@/lib/bots/interaction-store';
import { LobbyComposer } from '../LobbyComposer';
import { LobbyVoiceContext, type LobbyVoiceContextValue } from '../LobbyVoiceProvider';
import { makeVoice } from './voice-context';

const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const COMMANDS_URL = `/api/servers/${SERVER}/commands?channelId=${CHANNEL}`;
const COMMANDS = {
  commands: [{ id: 'c-quiz', name: 'quiz', description: 'Start a quiz', bot: { id: 'b-quiz', name: 'Quizzer' }, options: [] }],
};

let invokeResponse: () => Response;

beforeEach(() => {
  invalidateChannelCommands();
  interactionStore.reset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === COMMANDS_URL) return Response.json(COMMANDS);
      if (url.endsWith('/invoke')) return invokeResponse();
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  interactionStore.reset();
});

function renderComposer(locale = 'en', voice: LobbyVoiceContextValue | null = null) {
  const composer = (
    <LobbyComposer
      channelName="general"
      serverId={SERVER}
      channelId={CHANNEL}
      live
      members={[]}
      channels={[
        { id: CHANNEL, name: 'general', category: 'text' },
        { id: 'v-1', name: 'Lounge', category: 'voice' },
      ]}
    />
  );
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      {voice ? <LobbyVoiceContext.Provider value={voice}>{composer}</LobbyVoiceContext.Provider> : composer}
    </I18nProvider>
  );
}

async function runQuiz() {
  const user = userEvent.setup();
  await user.type(screen.getByRole('combobox'), '/quiz');
  await within(await screen.findByRole('listbox', {}, { timeout: 5000 })).findByRole('option', { name: /\/quiz/ });
  await user.keyboard('{Enter}');
  const form = screen.getByRole('form', { name: '/quiz' });
  await user.click(within(form).getByRole('button', { name: 'Run /quiz' }));
  return { user, form };
}

describe('slash command refusals', () => {
  it('says "This bot is offline right now" at once, with no pending row', async () => {
    invokeResponse = () => Response.json({ error: 'Bot is offline', code: 'bot_offline' }, { status: 503 });
    renderComposer();
    const { form } = await runQuiz();
    const alert = await within(form).findByRole('alert', {}, { timeout: 5000 });
    expect(alert).toHaveTextContent('This bot is offline right now.');
    expect(form).not.toHaveTextContent('Bot is offline');
    expect(interactionStore.getSnapshot().interactions).toEqual([]);
  });

  it('says it in Turkish', async () => {
    invokeResponse = () => Response.json({ error: 'Bot is offline', code: 'bot_offline' }, { status: 503 });
    renderComposer('tr');
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox'), '/quiz');
    await within(await screen.findByRole('listbox', {}, { timeout: 5000 })).findByRole('option', { name: /\/quiz/ });
    await user.keyboard('{Enter}');
    const form = screen.getByRole('form', { name: '/quiz' });
    await user.click(within(form).getByRole('button', { name: '/quiz çalıştır' }));
    expect(await within(form).findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Bu bot şu anda çevrimdışı.');
  });

  it('asks the member to join voice for voice_required', async () => {
    invokeResponse = () => Response.json({ error: 'Join voice', code: 'voice_required' }, { status: 403 });
    renderComposer();
    const { form } = await runQuiz();
    expect(await within(form).findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Join the voice channel to play.');
  });

  it('offers to open the activity that is already running', async () => {
    invokeResponse = () =>
      Response.json({ error: 'Already running', code: 'activity_exists', sessionId: 's-9', channelId: 'v-1' }, { status: 409 });
    const voice = makeVoice({ activeChannelId: 'v-1' });
    renderComposer('en', voice);
    const { user, form } = await runQuiz();
    const alert = await within(form).findByRole('alert', {}, { timeout: 5000 });
    expect(alert).toHaveTextContent('An activity is already running in this channel.');
    await user.click(within(alert).getByRole('button', { name: 'Open the activity' }));
    expect(voice.openActivities).toHaveBeenCalledWith({ channelId: 'v-1', channelName: 'Lounge' });
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('shows no open button without a voice room to open', async () => {
    invokeResponse = () => Response.json({ error: 'Already running', code: 'activity_exists' }, { status: 409 });
    renderComposer();
    const { form } = await runQuiz();
    const alert = await within(form).findByRole('alert', {}, { timeout: 5000 });
    expect(within(alert).queryByRole('button')).toBeNull();
  });
});

describe('invokeErrorKey', () => {
  it('maps the shared codes', () => {
    expect(invokeErrorKey({ status: 503, code: 'bot_offline' })).toBe('interactions.error.botOffline');
    expect(invokeErrorKey({ status: 403, code: 'voice_required' })).toBe('room.activity.error.voiceRequired');
    expect(invokeErrorKey({ status: 403, code: 'not_host' })).toBe('room.activity.error.notHost');
    expect(invokeErrorKey({ status: 409, code: 'session_ended' })).toBe('room.activity.error.sessionEnded');
    expect(invokeErrorKey({ status: 409, code: 'activity_exists' })).toBe('room.activity.error.activityExists');
    expect(invokeErrorKey({ status: 429, code: 'rate_limited' })).toBe('interactions.error.rateLimited');
    expect(invokeErrorKey({ status: 500, code: 'brand_new' })).toBe('interactions.error.generic');
  });
});
