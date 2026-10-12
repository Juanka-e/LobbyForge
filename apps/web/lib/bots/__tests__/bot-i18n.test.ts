import { beforeEach, describe, expect, it } from 'vitest';
import { translatorFor } from '@/lib/i18n/catalogue';
import { botDisplayName, localizeBotMessage, readBotMessageI18n } from '../bot-i18n';
import {
  __resetBotI18nCache,
  botMessageForViewer,
  customBotText,
  isDefaultBuiltInBotName,
  isShippedDefaultText,
  messageBotJson,
  normalizeBuiltInSettings,
} from '../bot-i18n-server';

/**
 * Built-in bots speak each viewer's language: a default greeting / notice
 * is stored once (`content` in the instance language) with
 * `metadata.i18n = { key, params }`, and every viewer reads `t(key,
 * params)`; an admin's own text is shown as written; a default name is
 * shown in the viewer's language, a renamed bot keeps its name.
 */

const BOT_ID = '55555555-5555-4555-8555-555555555555';
const en = translatorFor('en');
const tr = translatorFor('tr');

function welcomeRow(overrides: { metadata?: Record<string, unknown>; content?: string; name?: string; userId?: string | null } = {}) {
  return {
    userId: overrides.userId ?? null,
    botId: BOT_ID,
    content: overrides.content ?? 'Welcome to Oyun Gecesi, Ayşe! Glad you are here.',
    metadata: {
      bot: { id: BOT_ID, name: overrides.name ?? 'Welcome Bot', type: 'welcome' },
      i18n: { key: 'bots.welcome.defaultTemplate', params: { user: 'Ayşe', server: 'Oyun Gecesi' } },
      ...overrides.metadata,
    },
  };
}

beforeEach(() => {
  __resetBotI18nCache();
});

describe('readBotMessageI18n', () => {
  it('reads the key and string params of a bot message', () => {
    expect(readBotMessageI18n(welcomeRow())).toEqual({
      key: 'bots.welcome.defaultTemplate',
      params: { user: 'Ayşe', server: 'Oyun Gecesi' },
    });
  });

  it('is never honoured on a member’s message — `i18n` cannot be forged into one', () => {
    expect(readBotMessageI18n({ ...welcomeRow(), userId: 'u1' })).toBeNull();
    expect(readBotMessageI18n({ userId: null, botId: null, metadata: { i18n: { key: 'bots.welcome.defaultTemplate' } } })).toBeNull();
  });

  it('only the built-in bots’ default-text keys count', () => {
    for (const key of ['lobbyMain.chat.blockedBody', 'bots.welcome.defaultName', 'bots.unknown', 42, null]) {
      expect(readBotMessageI18n(welcomeRow({ metadata: { i18n: { key, params: {} } } }))).toBeNull();
    }
  });

  it('keeps string params only, capped', () => {
    const params: Record<string, unknown> = { user: 'x'.repeat(500), n: 3, nested: { a: 1 } };
    for (let i = 0; i < 20; i += 1) params[`p${i}`] = 'v';
    const read = readBotMessageI18n(welcomeRow({ metadata: { i18n: { key: 'bots.welcome.defaultTemplate', params } } }));
    expect(read!.params.user).toHaveLength(200);
    expect(read!.params).not.toHaveProperty('n');
    expect(read!.params).not.toHaveProperty('nested');
    expect(Object.keys(read!.params).length).toBeLessThanOrEqual(8);
  });
});

describe('localizeBotMessage — the same row, each viewer’s language', () => {
  it('renders the welcome greeting for an English and a Turkish viewer', () => {
    const row = welcomeRow();
    expect(localizeBotMessage(row, en)).toBe('Welcome to Oyun Gecesi, Ayşe! Glad you are here.');
    expect(localizeBotMessage(row, tr)).toBe('Ayşe, Oyun Gecesi sunucusuna hoş geldin! Seni aramızda görmek güzel.');
  });

  it('renders the moderation notice for each viewer', () => {
    const row = {
      userId: null,
      botId: BOT_ID,
      content: 'A message from Mallory was blocked by the moderation filter.',
      metadata: {
        bot: { id: BOT_ID, name: 'Moderation Bot', type: 'moderation' },
        i18n: { key: 'bots.moderation.defaultNotice', params: { user: 'Mallory' } },
      },
    };
    expect(localizeBotMessage(row, en)).toBe('A message from Mallory was blocked by the moderation filter.');
    expect(localizeBotMessage(row, tr)).toBe('Mallory kullanıcısının bir mesajı moderasyon filtresine takıldı.');
  });

  it('shows an admin’s own text exactly as written (no i18n stored)', () => {
    const row = { userId: null, botId: BOT_ID, content: 'Selam {user}!', metadata: { bot: { id: BOT_ID, name: 'Greeter', type: 'welcome' } } };
    expect(localizeBotMessage(row, tr)).toBe('Selam {user}!');
    expect(localizeBotMessage(row, en)).toBe('Selam {user}!');
  });

  it('falls back to content for an unknown key, or a catalogue without the key', () => {
    const unknown = welcomeRow({ metadata: { i18n: { key: 'bots.welcome.gone', params: {} } } });
    expect(localizeBotMessage(unknown, tr)).toBe(unknown.content);
    const noCatalogue = (key: string) => key;
    expect(localizeBotMessage(welcomeRow(), noCatalogue)).toBe('Welcome to Oyun Gecesi, Ayşe! Glad you are here.');
  });

  it('a member’s message is never rewritten, whatever its metadata says', () => {
    const forged = welcomeRow({ userId: 'u1', content: 'hi' });
    expect(localizeBotMessage(forged, tr)).toBe('hi');
  });
});

describe('default names', () => {
  it('a built-in bot still named its default (in any installed language) is the default', () => {
    expect(isDefaultBuiltInBotName('welcome', 'Welcome Bot')).toBe(true);
    expect(isDefaultBuiltInBotName('welcome', 'Karşılama Botu')).toBe(true);
    expect(isDefaultBuiltInBotName('moderation', 'Moderasyon Botu')).toBe(true);
    // Renamed, the other built-in's name, or not a built-in bot at all.
    expect(isDefaultBuiltInBotName('welcome', 'Greeter')).toBe(false);
    expect(isDefaultBuiltInBotName('welcome', 'Moderation Bot')).toBe(false);
    expect(isDefaultBuiltInBotName('custom', 'Welcome Bot')).toBe(false);
  });

  it('is shown in the viewer’s language; a renamed bot keeps its name', () => {
    const flagged = messageBotJson(welcomeRow({ name: 'Karşılama Botu' }))!;
    expect(flagged).toEqual({ id: BOT_ID, name: 'Karşılama Botu', type: 'welcome', defaultName: true });
    expect(botDisplayName(flagged, en)).toBe('Welcome Bot');
    expect(botDisplayName(flagged, tr)).toBe('Karşılama Botu');
    const renamed = messageBotJson(welcomeRow({ name: 'Greeter' }))!;
    expect(renamed).not.toHaveProperty('defaultName');
    expect(botDisplayName(renamed, tr)).toBe('Greeter');
  });

  it('only a built-in type can be shown as a default name, and an empty name gets the fallback', () => {
    expect(botDisplayName({ name: 'Welcome Bot', type: 'custom', defaultName: true }, tr)).toBe('Welcome Bot');
    expect(botDisplayName({ name: '', type: 'custom' }, tr, 'Bot')).toBe('Bot');
  });
});

describe('botMessageForViewer — the lobby’s first server render', () => {
  it('gives each viewer the default name and greeting in their language', () => {
    const row = welcomeRow();
    expect(botMessageForViewer(row, en)).toMatchObject({
      author: 'Welcome Bot',
      body: 'Welcome to Oyun Gecesi, Ayşe! Glad you are here.',
      bot: { id: BOT_ID, type: 'welcome', defaultName: true },
    });
    expect(botMessageForViewer(row, tr)).toMatchObject({
      author: 'Karşılama Botu',
      body: 'Ayşe, Oyun Gecesi sunucusuna hoş geldin! Seni aramızda görmek güzel.',
    });
  });

  it('leaves a renamed bot and an admin’s text alone, and ignores members’ messages', () => {
    const custom = { userId: null, botId: BOT_ID, content: 'Hoş geldin, dostum.', metadata: { bot: { id: BOT_ID, name: 'Kapıcı', type: 'welcome' } } };
    expect(botMessageForViewer(custom, en)).toMatchObject({ author: 'Kapıcı', body: 'Hoş geldin, dostum.' });
    expect(botMessageForViewer({ userId: 'u1', botId: null, content: 'hi', metadata: {} }, en)).toBeNull();
  });
});

describe('templates that are shipped defaults', () => {
  it('a template equal to a default in any installed language is "none written"', () => {
    expect(isShippedDefaultText('bots.welcome.defaultTemplate', 'Welcome to {server}, {user}! Glad you are here.')).toBe(true);
    expect(isShippedDefaultText('bots.welcome.defaultTemplate', '  {user}, {server} sunucusuna hoş geldin! Seni aramızda görmek güzel. ')).toBe(true);
    expect(customBotText('bots.welcome.defaultTemplate', 'Welcome to {server}, {user}! Glad you are here.')).toBeNull();
    expect(customBotText('bots.welcome.defaultTemplate', 'Hi {user}!')).toBe('Hi {user}!');
    expect(customBotText('bots.moderation.defaultNotice', null)).toBeNull();
    // A default of another field is an admin's own text here.
    expect(customBotText('bots.moderation.defaultNotice', 'Welcome to {server}, {user}! Glad you are here.')).not.toBeNull();
  });

  it('stored settings read with such a template as null', () => {
    expect(normalizeBuiltInSettings('welcome', { channelId: null, template: 'Welcome to {server}, {user}! Glad you are here.' })).toEqual({
      channelId: null,
      template: null,
    });
    expect(
      normalizeBuiltInSettings('moderation', { postNotice: true, noticeTemplate: '{user} kullanıcısının bir mesajı moderasyon filtresine takıldı.' })
    ).toEqual({ postNotice: true, noticeTemplate: null });
    expect(normalizeBuiltInSettings('welcome', { template: 'Hi {user}!' })).toEqual({ template: 'Hi {user}!' });
    expect(normalizeBuiltInSettings('welcome', { channelId: 'x' })).toEqual({ channelId: 'x' });
  });
});
