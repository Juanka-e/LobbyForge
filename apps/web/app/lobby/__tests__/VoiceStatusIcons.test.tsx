// @vitest-environment happy-dom
/**
 * The voice roster's icon-only statuses have names. The A-to-Z run found
 * the mute icon read out as "mic_off": a Material Symbols icon is a
 * ligature, so its text is the icon's name. Each status — muted, deafened
 * (your own row: deafen is a local setting), server muted, camera on,
 * sharing a screen — is now one image with a translated name, and the
 * ligature is hidden from assistive technology.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ConnectionState } from 'livekit-client';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LobbyVoiceChannels } from '../LobbyVoiceChannels';
import { LobbyVoiceContext } from '../LobbyVoiceProvider';
import { VoiceStatusIcon } from '../VoiceStatusIcon';
import { makeVoice, participant } from './voice-context';
import { __resetEmailStatusStoreForTests } from '@/components/email-verification/email-status-store';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const LOUNGE = 'ch-lounge';

function renderRoster(locale = 'en', deafenEnabled = false) {
  const voice = makeVoice({
    activeChannelId: LOUNGE,
    connectionState: ConnectionState.Connected,
    deafenEnabled,
    participants: [
      participant('u-me', 'Me', { isLocal: true, micEnabled: false }),
      participant('u-ada', 'Ada', { micEnabled: false }),
      participant('u-ben', 'Ben', { serverMuted: true, micEnabled: false }),
      participant('u-cem', 'Cem', { cameraEnabled: true, hasScreenShare: true }),
    ],
  });
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyVoiceContext.Provider value={voice}>
        <LobbyVoiceChannels channels={[{ id: LOUNGE, name: 'Main Lounge', category: 'voice' }]} currentUserId="u-me" />
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
}

/** A roster row, by the member's name. */
function row(name: string): HTMLElement {
  return screen.getByText(name, { selector: 'span' }).closest('li')!;
}

beforeEach(() => {
  __resetEmailStatusStoreForTests();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ presences: [] }), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VoiceStatusIcon', () => {
  it('is one named image; the ligature is hidden', () => {
    render(<VoiceStatusIcon icon="mic_off" label="Muted" className="text-danger" />);
    const icon = screen.getByRole('img', { name: 'Muted' });
    expect(icon).toHaveAttribute('title', 'Muted');
    const glyph = within(icon).getByText('mic_off');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveClass('material-symbols-outlined', 'text-danger');
  });
});

describe('the voice roster’s statuses', () => {
  it('names every icon-only status', () => {
    renderRoster();
    expect(within(row('Ada')).getByRole('img', { name: 'Muted' })).toBeInTheDocument();
    expect(within(row('Ben')).getByRole('img', { name: 'Server muted' })).toBeInTheDocument();
    // Server mute says it all: no second "Muted" beside it.
    expect(within(row('Ben')).queryByRole('img', { name: 'Muted' })).toBeNull();
    expect(within(row('Cem')).getByRole('img', { name: 'Camera on' })).toBeInTheDocument();
    expect(within(row('Cem')).getByRole('img', { name: 'Sharing screen' })).toBeInTheDocument();
  });

  it('shows your own row as Deafened while you are deafened', () => {
    renderRoster('en', true);
    expect(within(row('Me')).getByRole('img', { name: 'Deafened' })).toBeInTheDocument();
    expect(within(row('Me')).queryByRole('img', { name: 'Muted' })).toBeNull();
    // Someone else's deafen is not known to this client.
    expect(within(row('Ada')).getByRole('img', { name: 'Muted' })).toBeInTheDocument();
  });

  it('never exposes a ligature as text', () => {
    renderRoster('en', true);
    for (const ligature of ['mic_off', 'headphones_off', 'block', 'videocam', 'present_to_all']) {
      for (const glyph of screen.queryAllByText(ligature)) {
        expect(glyph.closest('[aria-hidden="true"]'), ligature).not.toBeNull();
      }
    }
  });

  it('says them in Turkish', () => {
    renderRoster('tr', true);
    expect(within(row('Me')).getByRole('img', { name: 'Sağırlaştırıldı' })).toBeInTheDocument();
    expect(within(row('Ada')).getByRole('img', { name: 'Mikrofon kapalı' })).toBeInTheDocument();
    expect(within(row('Ben')).getByRole('img', { name: 'Sunucuda susturuldu' })).toBeInTheDocument();
    expect(within(row('Cem')).getByRole('img', { name: 'Kamera açık' })).toBeInTheDocument();
    expect(within(row('Cem')).getByRole('img', { name: 'Ekran paylaşıyor' })).toBeInTheDocument();
  });
});
