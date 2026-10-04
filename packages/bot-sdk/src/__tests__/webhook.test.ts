/**
 * `postToWebhook` (BOT_API_V2 §5.1): JSON body, no redirects, `?wait=true`
 * returns the stored message, inputs checked before sending, typed errors.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BotNetworkError,
  BotNotFoundError,
  BotRateLimitError,
  BotValidationError,
  MAX_MESSAGE_LENGTH,
  postToWebhook,
} from '../index.js';

const URL_ = 'https://chat.example.com/api/webhooks/80000000-0000-4000-8000-000000000001/whtok_secret';

function fetchReturning(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
  );
}

describe('postToWebhook', () => {
  it('posts JSON and resolves null on 204', async () => {
    const fetch = fetchReturning(204);
    await expect(postToWebhook(URL_, { content: 'Deploy finished', username: 'CI' }, { fetch })).resolves.toBeNull();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(URL_);
    expect(init!.method).toBe('POST');
    expect(init!.redirect).toBe('error');
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init!.body))).toEqual({ content: 'Deploy finished', username: 'CI' });
  });

  it('wait: true asks for and returns the stored message', async () => {
    const message = { id: 'm1', channelId: 'c1', content: 'hi' };
    const fetch = fetchReturning(200, { message });
    await expect(postToWebhook(URL_, { content: 'hi' }, { fetch, wait: true })).resolves.toEqual(message);
    expect(String(fetch.mock.calls[0]![0])).toBe(`${URL_}?wait=true`);
  });

  it('refuses bad input before sending', async () => {
    const fetch = fetchReturning(204);
    await expect(postToWebhook('not a url', { content: 'x' }, { fetch })).rejects.toBeInstanceOf(BotValidationError);
    await expect(postToWebhook('ftp://x/y', { content: 'x' }, { fetch })).rejects.toBeInstanceOf(BotValidationError);
    await expect(postToWebhook('https://u:p@x/y', { content: 'x' }, { fetch })).rejects.toBeInstanceOf(BotValidationError);
    await expect(postToWebhook(URL_, { content: '  ' }, { fetch })).rejects.toBeInstanceOf(BotValidationError);
    await expect(postToWebhook(URL_, { content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }, { fetch })).rejects.toBeInstanceOf(
      BotValidationError
    );
    await expect(postToWebhook(URL_, { content: 'x', username: 'y'.repeat(33) }, { fetch })).rejects.toBeInstanceOf(
      BotValidationError
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps failures to typed errors', async () => {
    await expect(postToWebhook(URL_, { content: 'x' }, { fetch: fetchReturning(404, { error: 'Unknown webhook', code: 'not_found' }) }))
      .rejects.toBeInstanceOf(BotNotFoundError);
    const limited = (await postToWebhook(URL_, { content: 'x' }, {
      fetch: fetchReturning(429, { error: 'Rate limit exceeded', code: 'rate_limited', retryAfter: 9 }),
    }).catch((e: unknown) => e)) as BotRateLimitError;
    expect(limited).toBeInstanceOf(BotRateLimitError);
    expect(limited.retryAfter).toBe(9);
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(postToWebhook(URL_, { content: 'x' }, { fetch: down })).rejects.toBeInstanceOf(BotNetworkError);
  });
});
