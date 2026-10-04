// @vitest-environment happy-dom
/**
 * The audit log as moderators read it: resolved target names next to the
 * id, a summary line for the voice anti-cheat and voice disconnects, the
 * "Voice security" filter, and a CSV export that carries the names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import AuditClient, { type AuditEntryView } from '../AuditClient';

const MALLORY = '0a1b2c3d-0000-4000-8000-0000000000aa';
const BOB = '0b0b0b0b-0000-4000-8000-0000000000bb';

const ENTRIES: AuditEntryView[] = [
  {
    id: 'e1',
    action: 'voice.track_rejected',
    targetType: 'user',
    targetId: MALLORY,
    metadata: { channelId: 'c1', room: 'r', source: 'camera', type: 'audio', blockedSeconds: 600 },
    actorName: null,
    targetName: 'Mallory',
    channelName: 'Main Lounge',
    createdAt: '2026-10-04T10:00:00.000Z',
  },
  {
    id: 'e2',
    action: 'voice.block_enforced',
    targetType: 'user',
    targetId: MALLORY,
    metadata: { channelId: 'c1', retryAfterSeconds: 300 },
    actorName: null,
    targetName: 'Mallory',
    channelName: 'Main Lounge',
    createdAt: '2026-10-04T10:01:00.000Z',
  },
  {
    id: 'e3',
    action: 'voice.disconnect',
    targetType: 'user',
    targetId: BOB,
    metadata: { channelId: 'c2' },
    actorName: 'Ayşe',
    targetName: 'Bob',
    channelName: null,
    createdAt: '2026-10-04T10:02:00.000Z',
  },
  {
    id: 'e4',
    action: 'member.kick',
    targetType: 'user',
    targetId: BOB,
    metadata: {},
    actorName: 'Ayşe',
    targetName: null,
    channelName: null,
    createdAt: '2026-10-04T10:03:00.000Z',
  },
];

function renderAudit(locale = 'en', entries = ENTRIES) {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <AuditClient entries={entries} loadError={null} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T10:05:00.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AuditClient — names and summaries', () => {
  it('shows the target as "Name (id…)" with the full id in the tooltip', () => {
    renderAudit();
    const targets = screen.getAllByText('Target: user: Mallory (0a1b2c3d…)');
    expect(targets).toHaveLength(2);
    expect(targets[0]!.getAttribute('title')).toBe(MALLORY);
    // A target whose name is unknown still shows its id.
    expect(screen.getByText(`Target: user: ${BOB.slice(0, 23)}...`)).toBeTruthy();
  });

  it('summarises the anti-cheat removal, the re-removal and the moderator disconnect, names emphasised', () => {
    renderAudit();
    const summaries = screen.getAllByTestId('audit-summary').map((node) => node.textContent);
    expect(summaries).toEqual([
      // Newest first.
      'Ayşe disconnected Bob (0b0b0b0b…) from a voice channel. No block: they can rejoin at any time.',
      'System removed Mallory (0a1b2c3d…) from #Main Lounge again: they rejoined while blocked from voice (5 minutes left).',
      'System removed Mallory (0a1b2c3d…) from #Main Lounge: audio published as camera — voice blocked on this server for 10 minutes.',
    ]);
    const disconnect = screen.getAllByTestId('audit-summary')[0]!;
    expect(within(disconnect).getByText('Ayşe').tagName).toBe('STRONG');
    expect(within(disconnect).getByText('Bob (0b0b0b0b…)').tagName).toBe('STRONG');
  });

  it('labels the new actions', () => {
    renderAudit();
    expect(screen.getByText('removed a member who rejoined voice while blocked')).toBeTruthy();
    expect(screen.getByText('disconnected a member from voice')).toBeTruthy();
  });

  it('speaks Turkish', () => {
    renderAudit('tr');
    expect(screen.getByRole('button', { name: 'Ses güvenliği (3)' })).toBeTruthy();
    expect(screen.getAllByTestId('audit-summary')[2]!.textContent).toBe(
      'Sistem, Mallory (0a1b2c3d…) kullanıcısını #Main Lounge kanalından çıkardı: kamera olarak yayınlanan ses. Bu sunucuda ses erişimi 10 dakika engellendi.'
    );
  });
});

describe('AuditClient — Voice security filter and search', () => {
  it('collects the anti-cheat rows and voice disconnects, and nothing else', () => {
    renderAudit();
    fireEvent.click(screen.getByRole('button', { name: 'Voice security (3)' }));
    expect(screen.getAllByTestId('audit-summary')).toHaveLength(3);
    expect(screen.queryByText('kicked a member')).toBeNull();
    expect(screen.getAllByText('Voice security').length).toBeGreaterThanOrEqual(3);
  });

  it('finds rows by the resolved target name and by the summary text', () => {
    renderAudit();
    fireEvent.change(screen.getByLabelText('Search the audit log'), { target: { value: 'mallory' } });
    expect(screen.getAllByTestId('audit-summary')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search the audit log'), { target: { value: 'published as camera' } });
    expect(screen.getAllByTestId('audit-summary')).toHaveLength(1);
  });
});

describe('AuditClient — CSV export', () => {
  async function exportedCsv(): Promise<string> {
    let blob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value: Blob | MediaSource) => {
      blob = value as Blob;
      return 'blob:audit';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(blob).not.toBeNull();
    return (blob as unknown as Blob).text();
  }

  it('includes the target name and the summary next to the raw ids', async () => {
    renderAudit();
    fireEvent.click(screen.getByRole('button', { name: 'Voice security (3)' }));
    const lines = (await exportedCsv()).split('\r\n');
    expect(lines[0]).toBe(
      '"created_at","actor","action","category","target_type","target_id","target_name","summary","metadata"'
    );
    expect(lines).toHaveLength(1 + 3);
    const disconnect = lines[1]!;
    expect(disconnect).toContain(`"Ayşe","voice.disconnect","Voice security","user","${BOB}","Bob","Ayşe disconnected Bob (0b0b0b0b…) from a voice channel.`);
    const rejected = lines[3]!;
    expect(rejected).toContain(`"System","voice.track_rejected","Voice security","user","${MALLORY}","Mallory","System removed Mallory`);
  });
});
