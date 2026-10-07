/**
 * Browser test finding: a Welcome Bot greeting with @everyone was refused,
 * but the page said only "Some of these values are not valid". The route
 * names the reason in `issues`; the page now says it in the admin's
 * language (never the English issue text).
 */
import { describe, expect, it } from 'vitest';
import { translatorFor } from '@/lib/i18n/catalogue';
import { MASS_MENTION_ISSUE } from '@/lib/bots/settings';
import { describeFailure, describeInvalidRequest } from '../api-client';

const en = translatorFor('en');
const tr = translatorFor('tr');

describe('describeFailure for invalid_request', () => {
  it('names a template that pings @everyone, in English and Turkish', () => {
    const body = { error: 'Invalid request body', code: 'invalid_request', issues: [`settings.template: ${MASS_MENTION_ISSUE}`] };
    expect(describeFailure(en, 400, body)).toBe("Bot messages can't mention @everyone or @here. Remove it and save again.");
    expect(describeFailure(tr, 400, body)).toBe('Bot mesajları @everyone veya @here içeremez. Bunu kaldırıp tekrar kaydet.');
  });

  it('names the moderation notice template too', () => {
    const body = { code: 'invalid_request', issues: [`settings.noticeTemplate: ${MASS_MENTION_ISSUE}`] };
    expect(describeFailure(en, 400, body)).toMatch(/@everyone or @here/);
  });

  it('lists allow-list entries that are not domains', () => {
    const body = { code: 'invalid_request', issues: ['settings.allowedDomains.0: Not a domain: nope', 'settings.allowedDomains.2: Not a domain: also bad'] };
    expect(describeFailure(en, 400, body)).toBe('These are not site addresses: nope, also bad');
  });

  it('keeps the generic sentence for anything else', () => {
    expect(describeFailure(en, 400, { code: 'invalid_request', issues: ['name: Too big'] })).toBe(
      'Some of these values are not valid. Check the fields and try again.'
    );
    expect(describeFailure(en, 400, { code: 'invalid_request' })).toBe(
      'Some of these values are not valid. Check the fields and try again.'
    );
    expect(describeInvalidRequest(en, 'not a list')).toBeNull();
  });
});
