// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';

/**
 * Final-test finding (accessibility): offline member names measured
 * 3.22:1 and the "Guest" tag 3.79:1, because the offline list carried
 * `opacity-60` and each row `opacity-80` — the text faded with the row.
 * Now only the avatar and status dot fade, and the text uses a themed
 * token that clears 4.5:1 on the panel in every theme.
 */

vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({ subscribe: () => () => {} }),
}));
vi.mock('../LobbyVoiceProvider', () => ({
  useLobbyVoice: () => ({ getRemoteVolume: () => 1, setRemoteVolume: () => {} }),
}));

const ONLINE = '00000000-0000-0000-0000-0000000000a1';
const OFFLINE = '00000000-0000-0000-0000-0000000000b2';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/presence')) {
        return Response.json({ presences: [{ userId: ONLINE, channelId: 'text-1', status: 'online', lastSeen: Date.now() }] });
      }
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every class on `el` and its ancestors up to the panel. */
function classesUpToPanel(el: Element): string[] {
  const out: string[] = [];
  for (let node: Element | null = el; node && node.tagName !== 'ASIDE'; node = node.parentElement) {
    out.push(...Array.from(node.classList));
  }
  return out;
}

async function renderPanel() {
  const { LobbyMembersClient } = await import('../LobbyMembersClient');
  render(
    <I18nProvider {...providerPropsFor('en')}>
      <LobbyMembersClient
        serverId="srv-1"
        initialMembers={[
          { id: ONLINE, name: 'Alice', status: 'online' },
          { id: OFFLINE, name: 'Bob', status: 'offline', isGuest: true, grayscale: true },
        ]}
        voiceChannelIds={[]}
        currentUserId={ONLINE}
      />
    </I18nProvider>
  );
  // Let the first presence poll settle so the groups are final.
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText('Offline - 1')).toBeTruthy());
  await waitFor(() => expect(screen.getByText('Online - 1')).toBeTruthy());
}

describe('members panel contrast', () => {
  it('never fades an offline name or the Guest tag', async () => {
    await renderPanel();
    const name = screen.getByText('Bob');
    const guest = screen.getByText('Guest');
    for (const el of [name, guest]) {
      expect(classesUpToPanel(el).filter((c) => c.startsWith('opacity-'))).toEqual([]);
    }
    expect(name.className).toContain('text-text-secondary');
    expect(guest.className).toContain('text-text-secondary');
    expect(guest.className).not.toContain('text-text-muted');
  });

  it('does not fade the offline group heading either', async () => {
    await renderPanel();
    const heading = screen.getByText('Offline - 1').closest('h3')!;
    expect(classesUpToPanel(heading).filter((c) => c.startsWith('opacity-'))).toEqual([]);
  });

  it('fades the offline avatar and its status dot instead', async () => {
    await renderPanel();
    const offlineAvatar = screen.getByText('Bob').closest('button')!.querySelector('[data-member-avatar]')!;
    const onlineAvatar = screen.getByText('Alice').closest('button')!.querySelector('[data-member-avatar]')!;
    expect(offlineAvatar.className).toContain('opacity-50');
    // The status dot (the labelled marker) sits inside the faded wrapper.
    expect(offlineAvatar.querySelector('[aria-label]')).toBeTruthy();
    expect(onlineAvatar.className).not.toMatch(/opacity-/);
  });
});

describe('the server-rendered members fallback', () => {
  const source = readFileSync(join(process.cwd(), 'app', 'lobby', 'page.tsx'), 'utf8');
  const section = source.slice(source.indexOf('function MemberSection('));

  it('fades only the avatar, not the list, row or heading', () => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toContain('space-y-1 opacity-');
    expect(section).not.toContain('group opacity-');
    expect(section).not.toContain('gap-2 opacity-');
    expect(section).toContain('overflow-hidden opacity-50');
    expect(section).toContain('font-label-sm text-text-secondary');
  });
});

describe('the text token the panel uses', () => {
  const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');

  function block(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf('}', start));
  }
  function token(body: string, name: string): string {
    const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
    if (!match) throw new Error(`${name} missing`);
    return match[1]!;
  }
  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }
  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  it.each([
    ['dark', ':root'],
    ['dim', '.lf-theme-dim'],
    ['light', '.lf-theme-light'],
  ])('text-secondary reaches 4.5:1 on the panel background (%s)', (_theme, selector) => {
    const body = block(selector);
    expect(contrast(token(body, '--lf-text-secondary'), token(body, '--lf-surface-dim'))).toBeGreaterThanOrEqual(4.5);
  });
});
