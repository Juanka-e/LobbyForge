import { describe, expect, it, vi } from 'vitest';
import {
  BOT_PERMISSIONS,
  BotApiError,
  BotAuthError,
  BotForbiddenError,
  BotNetworkError,
  BotNotFoundError,
  BotPermission,
  BotRateLimitError,
  BotServerError,
  BotValidationError,
  createBotClient,
  isBotPermission,
  isBotTokenFormat,
  MAX_MESSAGE_LENGTH,
} from '../index.js';

const TOKEN = `lfb_${'a1'.repeat(16)}_${'Zz9-_'.repeat(8)}abc`;
const CHANNEL = '11111111-2222-4333-8444-555555555555';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function clientWith(response: Response | (() => Promise<Response>)) {
  const fetch = vi.fn(async () => (typeof response === 'function' ? response() : response));
  const client = createBotClient({ baseUrl: 'https://chat.example.com/', token: TOKEN, fetch });
  return { client, fetch };
}

function lastCall(fetch: ReturnType<typeof vi.fn>) {
  const [url, init] = fetch.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

describe('token format', () => {
  it('matches the server format and nothing looser', () => {
    expect(TOKEN).toHaveLength(4 + 32 + 1 + 43);
    expect(isBotTokenFormat(TOKEN)).toBe(true);
    expect(isBotTokenFormat(TOKEN.toUpperCase())).toBe(false);
    expect(isBotTokenFormat(`${TOKEN}x`)).toBe(false);
    expect(isBotTokenFormat(`Bot ${TOKEN}`)).toBe(false);
    expect(isBotTokenFormat(undefined)).toBe(false);
  });
});

describe('permissions', () => {
  it('lists every BotPermission once', () => {
    expect(new Set(BOT_PERMISSIONS).size).toBe(Object.keys(BotPermission).length);
    expect(isBotPermission('send_messages')).toBe(true);
    expect(isBotPermission('administrator')).toBe(false);
  });
});

describe('createBotClient', () => {
  it('refuses a bad base URL or token before any request', () => {
    const fetch = vi.fn();
    expect(() => createBotClient({ baseUrl: 'chat.example.com', token: TOKEN, fetch })).toThrow(BotValidationError);
    expect(() => createBotClient({ baseUrl: 'ftp://chat.example.com', token: TOKEN, fetch })).toThrow(
      BotValidationError
    );
    expect(() => createBotClient({ baseUrl: 'https://u:p@chat.example.com', token: TOKEN, fetch })).toThrow(
      BotValidationError
    );
    expect(() => createBotClient({ baseUrl: 'https://chat.example.com', token: 'not-a-token', fetch })).toThrow(
      BotValidationError
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the token as a Bot authorization header, never in the URL', async () => {
    const { client, fetch } = clientWith(jsonResponse(200, { bot: { id: 'b', name: 'Helper' } }));
    const me = await client.getMe();
    expect(me.name).toBe('Helper');
    const { url, init, headers } = lastCall(fetch);
    expect(url).toBe('https://chat.example.com/api/bot/v1/me');
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe('GET');
    expect(headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(init.redirect).toBe('error');
  });

  it('lists channels', async () => {
    const channels = [{ id: CHANNEL, name: 'general', type: 'text', position: 0, topic: null }];
    const { client, fetch } = clientWith(jsonResponse(200, { channels }));
    await expect(client.listChannels()).resolves.toEqual(channels);
    expect(lastCall(fetch).url).toBe('https://chat.example.com/api/bot/v1/channels');
  });

  it('reads messages with limit and before', async () => {
    const { client, fetch } = clientWith(jsonResponse(200, { messages: [] }));
    await client.readMessages(CHANNEL, { limit: 20, before: new Date('2026-09-01T00:00:00Z') });
    const { url } = lastCall(fetch);
    expect(url).toBe(
      `https://chat.example.com/api/bot/v1/channels/${CHANNEL}/messages?limit=20&before=2026-09-01T00%3A00%3A00.000Z`
    );
  });

  it('posts a message as JSON', async () => {
    const message = { id: 'm1', channelId: CHANNEL, content: 'hi', author: { type: 'bot', id: 'b', name: 'Helper' } };
    const { client, fetch } = clientWith(jsonResponse(201, { message }));
    await expect(client.sendMessage(CHANNEL, 'hi')).resolves.toEqual(message);
    const { url, init, headers } = lastCall(fetch);
    expect(url).toBe(`https://chat.example.com/api/bot/v1/channels/${CHANNEL}/messages`);
    expect(init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ content: 'hi' });
  });

  it('validates inputs before sending', async () => {
    const { client, fetch } = clientWith(jsonResponse(201, {}));
    await expect(client.sendMessage('../../admin', 'hi')).rejects.toBeInstanceOf(BotValidationError);
    await expect(client.sendMessage(CHANNEL, '   ')).rejects.toBeInstanceOf(BotValidationError);
    await expect(client.sendMessage(CHANNEL, 'x'.repeat(MAX_MESSAGE_LENGTH + 1))).rejects.toBeInstanceOf(
      BotValidationError
    );
    await expect(client.readMessages(CHANNEL, { limit: 0 })).rejects.toBeInstanceOf(BotValidationError);
    await expect(client.readMessages(CHANNEL, { limit: 101 })).rejects.toBeInstanceOf(BotValidationError);
    await expect(client.readMessages(CHANNEL, { before: 'not a date' })).rejects.toBeInstanceOf(BotValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('typed errors', () => {
  it('maps 401 to BotAuthError', async () => {
    const { client } = clientWith(jsonResponse(401, { error: 'Invalid bot token', code: 'unauthorized' }));
    const error = await client.getMe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotAuthError);
    expect(error).toBeInstanceOf(BotApiError);
    expect((error as BotAuthError).code).toBe('unauthorized');
    expect((error as BotAuthError).message).toBe('Invalid bot token');
  });

  it('maps 403 to BotForbiddenError with the missing permission', async () => {
    const { client } = clientWith(
      jsonResponse(403, { error: 'Missing permission', code: 'missing_permission', permission: 'send_messages' })
    );
    const error = (await client.sendMessage(CHANNEL, 'hi').catch((e: unknown) => e)) as BotForbiddenError;
    expect(error).toBeInstanceOf(BotForbiddenError);
    expect(error.permission).toBe('send_messages');
    expect(error.code).toBe('missing_permission');
  });

  it('maps 404 to BotNotFoundError', async () => {
    const { client } = clientWith(jsonResponse(404, { error: 'Channel not found', code: 'not_found' }));
    await expect(client.readMessages(CHANNEL)).rejects.toBeInstanceOf(BotNotFoundError);
  });

  it('maps 429 to BotRateLimitError with retryAfter from the body or header', async () => {
    const fromBody = clientWith(jsonResponse(429, { error: 'Rate limit exceeded', code: 'rate_limited', retryAfter: 7 }));
    const a = (await fromBody.client.listChannels().catch((e: unknown) => e)) as BotRateLimitError;
    expect(a).toBeInstanceOf(BotRateLimitError);
    expect(a.retryAfter).toBe(7);

    const fromHeader = clientWith(jsonResponse(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '12' }));
    const b = (await fromHeader.client.listChannels().catch((e: unknown) => e)) as BotRateLimitError;
    expect(b.retryAfter).toBe(12);
  });

  it('maps 400/413/422 to BotValidationError with issues', async () => {
    const { client } = clientWith(
      jsonResponse(400, { error: 'Invalid request', code: 'invalid_request', issues: ['content: Required'] })
    );
    const error = (await client.sendMessage(CHANNEL, 'hi').catch((e: unknown) => e)) as BotValidationError;
    expect(error).toBeInstanceOf(BotValidationError);
    expect(error.issues).toEqual(['content: Required']);

    const tooBig = clientWith(jsonResponse(413, { error: 'Request body too large', code: 'payload_too_large' }));
    await expect(tooBig.client.sendMessage(CHANNEL, 'hi')).rejects.toBeInstanceOf(BotValidationError);
  });

  it('maps 5xx to BotServerError, keeping the maintenance code', async () => {
    const { client } = clientWith(jsonResponse(503, { error: 'Maintenance mode', code: 'maintenance' }));
    const error = (await client.getMe().catch((e: unknown) => e)) as BotServerError;
    expect(error).toBeInstanceOf(BotServerError);
    expect(error.status).toBe(503);
    expect(error.code).toBe('maintenance');
  });

  it('turns a failed fetch or a non-JSON success into BotNetworkError', async () => {
    const failing = createBotClient({
      baseUrl: 'https://chat.example.com',
      token: TOKEN,
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    const error = (await failing.getMe().catch((e: unknown) => e)) as BotNetworkError;
    expect(error).toBeInstanceOf(BotNetworkError);
    expect(error.status).toBe(0);

    const garbled = clientWith(new Response('<html>proxy error</html>', { status: 200 }));
    await expect(garbled.client.getMe()).rejects.toBeInstanceOf(BotNetworkError);
  });

  it('times out a request that never answers', async () => {
    const hanging = createBotClient({
      baseUrl: 'https://chat.example.com',
      token: TOKEN,
      timeoutMs: 20,
      fetch: vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      ),
    });
    const error = (await hanging.getMe().catch((e: unknown) => e)) as BotNetworkError;
    expect(error).toBeInstanceOf(BotNetworkError);
    expect(error.code).toBe('timeout');
  });
});
