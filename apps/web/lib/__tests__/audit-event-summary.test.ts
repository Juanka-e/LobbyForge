/**
 * The audit log's human summaries for the voice anti-cheat and the
 * moderator voice disconnect — whole sentences in English and Turkish,
 * with the channel named only when the page resolved it for the viewer.
 */
import { describe, expect, it } from 'vitest';
import { translatorFor } from '@/lib/i18n/catalogue';
import {
  VOICE_SECURITY_ACTIONS,
  auditEventSummary,
  auditEventSummaryText,
  auditTargetLabel,
  shortId,
  type AuditEntryView,
} from '@/lib/audit-event-summary';

const en = translatorFor('en');
const tr = translatorFor('tr');

const TARGET = '0a1b2c3d-0000-4000-8000-0000000000aa';
const CHANNEL = '0a1b2c3d-0000-4000-8000-000000000002';

function entry(overrides: Partial<AuditEntryView>): AuditEntryView {
  return {
    id: 'a1',
    action: 'voice.track_rejected',
    targetType: 'user',
    targetId: TARGET,
    metadata: {},
    actorName: null,
    targetName: 'Mallory',
    channelName: 'Main Lounge',
    createdAt: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('auditEventSummaryText — voice.track_rejected', () => {
  const rejected = entry({
    metadata: { channelId: CHANNEL, room: 'r', source: 'camera', type: 'audio', blockedSeconds: 600 },
  });

  it('names who, where, what and for how long', () => {
    expect(auditEventSummaryText(en, rejected)).toBe(
      'System removed Mallory (0a1b2c3d…) from #Main Lounge: audio published as camera — voice blocked on this server for 10 minutes.'
    );
    expect(auditEventSummaryText(tr, rejected)).toBe(
      'Sistem, Mallory (0a1b2c3d…) kullanıcısını #Main Lounge kanalından çıkardı: kamera olarak yayınlanan ses. Bu sunucuda ses erişimi 10 dakika engellendi.'
    );
  });

  it('rounds the block up to whole minutes and uses the plural form', () => {
    const oneMinute = entry({ metadata: { source: 'screen_share', type: 'audio', blockedSeconds: 45 } });
    expect(auditEventSummaryText(en, oneMinute)).toContain('screen share — voice blocked on this server for 1 minute.');
    const longer = entry({ metadata: { source: 'microphone', type: 'video', blockedSeconds: 7_200 } });
    expect(auditEventSummaryText(en, longer)).toContain('video published as microphone — voice blocked on this server for 120 minutes.');
  });

  it('says a channel the viewer cannot see (or that is gone) is "a voice channel"', () => {
    const hidden = entry({ channelName: null, metadata: { source: 'camera', type: 'audio', blockedSeconds: 600 } });
    expect(auditEventSummaryText(en, hidden)).toContain('from a voice channel: audio published as camera');
    expect(auditEventSummaryText(tr, hidden)).toContain('kullanıcısını bir sesli kanaldan çıkardı');
  });

  it('is honest when no block could be recorded', () => {
    const noBlock = entry({ metadata: { source: 'camera', type: 'audio' } });
    expect(auditEventSummaryText(en, noBlock)).toBe(
      'System removed Mallory (0a1b2c3d…) from #Main Lounge: audio published as camera. No voice block could be recorded.'
    );
  });

  it('describes a media mismatch instead of a pairing that reads as allowed', () => {
    const mime = entry({ metadata: { source: 'camera', type: 'video', mimeType: 'audio/opus', blockedSeconds: 600 } });
    expect(auditEventSummaryText(en, mime)).toContain(': a video track carrying audio/opus media — voice blocked');
    expect(auditEventSummaryText(tr, mime)).toContain(': audio/opus medyası taşıyan bir görüntü akışı.');
  });

  it('falls back to "unknown" words for values it does not know', () => {
    const odd = entry({ metadata: { source: 'hologram', type: 'smell', blockedSeconds: 600 } });
    expect(auditEventSummaryText(en, odd)).toContain(': a track of unknown type published as an unknown source —');
  });

  it('uses the short id when the target has no resolved name', () => {
    const unnamed = entry({ targetName: null, metadata: { source: 'camera', type: 'audio', blockedSeconds: 600 } });
    expect(auditEventSummaryText(en, unnamed)).toMatch(/^System removed 0a1b2c3d… from #Main Lounge/);
  });
});

describe('auditEventSummaryText — voice.block_enforced and voice.disconnect', () => {
  it('voice.block_enforced: removed again, with the time left on the block', () => {
    const enforced = entry({ action: 'voice.block_enforced', metadata: { channelId: CHANNEL, retryAfterSeconds: 421 } });
    expect(auditEventSummaryText(en, enforced)).toBe(
      'System removed Mallory (0a1b2c3d…) from #Main Lounge again: they rejoined while blocked from voice (8 minutes left).'
    );
    expect(auditEventSummaryText(tr, enforced)).toBe(
      'Sistem, Mallory (0a1b2c3d…) kullanıcısını #Main Lounge kanalından yeniden çıkardı: ses engeli sürerken tekrar katıldı (8 dakika kaldı).'
    );
  });

  it('voice.disconnect: the moderator, and that there is no block', () => {
    const disconnect = entry({ action: 'voice.disconnect', actorName: 'Ayşe', metadata: { channelId: CHANNEL } });
    expect(auditEventSummaryText(en, disconnect)).toBe(
      'Ayşe disconnected Mallory (0a1b2c3d…) from #Main Lounge. No block: they can rejoin at any time.'
    );
    expect(auditEventSummaryText(tr, disconnect)).toBe(
      'Ayşe, Mallory (0a1b2c3d…) kullanıcısının #Main Lounge kanalındaki ses bağlantısını kesti. Engel yok: istediği zaman yeniden katılabilir.'
    );
  });

  it('has no summary for other actions', () => {
    expect(auditEventSummary(en, entry({ action: 'voice.mute' }))).toBeNull();
    expect(auditEventSummaryText(en, entry({ action: 'member.kick' }))).toBe('');
  });
});

describe('auditEventSummary — data stays out of the marker text', () => {
  it('returns the channel and the offence as slots, never formatted into the sentence', () => {
    const tricky = entry({
      channelName: '{target}',
      metadata: { source: 'camera', type: 'video', mimeType: '{actor}', blockedSeconds: 600 },
    });
    const summary = auditEventSummary(en, tricky)!;
    expect(summary.slots).toEqual({ channel: '{target}', offence: 'a video track carrying {actor} media' });
    // The sentence itself only has the markers the caller fills in.
    const text = en(summary.key, summary.params);
    expect(text.match(/\{\w+\}/g)).toEqual(['{target}', '{channel}', '{offence}']);
  });
});

describe('labels', () => {
  it('"Name (id…)" for a named target, the short id otherwise', () => {
    expect(auditTargetLabel(en, { targetId: TARGET, targetName: 'Mallory' })).toBe('Mallory (0a1b2c3d…)');
    expect(auditTargetLabel(en, { targetId: TARGET, targetName: null })).toBe('0a1b2c3d…');
    expect(shortId('short')).toBe('short');
  });

  it('the Voice security filter covers exactly the anti-cheat and the moderator disconnect', () => {
    expect([...VOICE_SECURITY_ACTIONS].sort()).toEqual(['voice.block_enforced', 'voice.disconnect', 'voice.track_rejected']);
  });
});

// Bot protection (docs/CAPTCHA.md §6.1): the instance-wide settings entry
// names the fields that changed — never their values.
describe('auditEventSummaryText — instance.captcha_updated', () => {
  const updated = (metadata: Record<string, unknown>) =>
    entry({ action: 'instance.captcha_updated', targetType: 'instance', targetId: 'self-host', targetName: null, actorName: 'Owner', channelName: null, metadata });

  it('lists the changed fields in a fixed order, in English and Turkish', () => {
    const e = updated({ fields: ['secretKey', 'provider', 'attackMode'] });
    // Joined the reader's way (Intl.ListFormat), not with a hard-coded ", ".
    expect(auditEventSummaryText(en, e)).toBe('Owner changed the bot protection settings: provider, secret key, and attack mode.');
    expect(auditEventSummaryText(tr, e)).toBe('Owner, bot koruması ayarlarını değiştirdi: sağlayıcı, gizli anahtar ve saldırı modu.');
    expect(auditEventSummaryText(en, updated({ fields: ['provider', 'siteKey'] }))).toBe('Owner changed the bot protection settings: provider and site key.');
  });

  it('ignores anything that is not a known field name', () => {
    expect(auditEventSummaryText(en, updated({ fields: ['surfaces', 'secret: abc', 42] }))).toBe(
      'Owner changed the bot protection settings: protected pages.'
    );
    expect(auditEventSummaryText(en, updated({}))).toBe('Owner changed the bot protection settings.');
  });

  it('has a label', async () => {
    const { auditActionLabelKey } = await import('@/lib/audit-action-labels');
    expect(en(auditActionLabelKey('instance.captcha_updated')!)).toBe('changed the bot protection settings');
    expect(tr(auditActionLabelKey('instance.captcha_updated')!)).toBe('bot koruması ayarlarını değiştirdi');
  });
});
