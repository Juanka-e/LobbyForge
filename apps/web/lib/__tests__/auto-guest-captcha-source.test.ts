import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The lobby's voice provider and the voice room create a guest on their
 * own. With bot protection on, that request can be refused with a captcha
 * code (docs/CAPTCHA.md §6): both must then ask the person once, in the
 * guest dialog — no silent retry loop — and keep a way to reopen it.
 * (Both pull in livekit-client, so this checks their source; the dialog
 * itself is tested in components/captcha/__tests__.)
 */
const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

describe('automatic guest creation under bot protection', () => {
  const lobby = read('app', 'lobby', 'LobbyVoiceProvider.tsx');
  const room = read('app', 'room', '[roomName]', 'page.tsx');

  for (const [name, source] of [
    ['lobby voice provider', lobby],
    ['voice room', room],
  ] as const) {
    it(`${name}: a captcha refusal opens the guest dialog instead of failing or retrying`, () => {
      expect(source).toContain("from '@/components/captcha/GuestVerificationDialog'");
      expect(source).toMatch(/if \(await readCaptchaRefusal\(res\)\) \{[\s\S]{0,120}setGuestCheck\('open'\)/);
      expect(source).toContain("open={guestCheck === 'open'}");
      expect(source).toMatch(/onDismiss=\{\(\) => \{?\s*setGuestCheck\('dismissed'\)/);
    });
  }

  it('lobby: joining voice after closing the dialog opens it again (never a dead control)', () => {
    // Read from a live ref: connectToChannel can check it after awaiting
    // the session lookup (behaviour: LobbyVoiceSessionWait.test.tsx).
    expect(lobby).toMatch(/if \(guestCheck(?:Ref\.current)? === 'dismissed'\) \{\s*setGuestCheck\('open'\);\s*return;/);
    expect(lobby).toContain("setError({ key: 'captcha.guest.dismissed' })");
    // The guest keeps the name the lobby would have given it.
    expect(lobby).toContain('body={{ displayNameSeed: localDisplayName || undefined }}');
  });

  it('room: a closed dialog leaves a button to verify and continue', () => {
    expect(room).toMatch(/guestCheck === 'dismissed' && !guest[\s\S]{0,600}onClick=\{\(\) => setGuestCheck\('open'\)\}/);
    expect(room).toContain("t('captcha.guest.verify')");
  });
});
