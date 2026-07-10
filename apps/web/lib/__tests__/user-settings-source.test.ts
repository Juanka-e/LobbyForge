import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_FILES = [
  'app/settings/page.tsx',
  'app/settings/accessibility/page.tsx',
  'app/settings/active-sessions/page.tsx',
  'app/settings/appearance/page.tsx',
  'app/settings/keybinds/page.tsx',
  'app/settings/my-account/MyAccountBody.tsx',
  'app/settings/my-account/page.tsx',
  'app/settings/notifications/page.tsx',
  'app/settings/profile/ProfileBody.tsx',
  'app/settings/profile/page.tsx',
  'app/settings/SettingsStickyFooter.tsx',
  'app/settings/voice-video/page.tsx',
  'lib/keybind-preferences.ts',
  'lib/voice-video-preferences.ts',
  'app/api/settings/me/route.ts',
  'app/api/settings/me/blocks/route.ts',
  'app/api/settings/me/blocks/[userId]/route.ts',
  'app/api/settings/me/sessions/route.ts',
  'app/api/users/me/banner/route.ts',
  'app/api/users/me/profile/route.ts',
];

const MOJIBAKE_PATTERNS = [
  /\u00e2[\u0080-\u20ff]/,
  /\u00c2[\u0080-\u00bf]/,
  /\u00c3[\u0080-\u00bf]/,
  /\u00c5[\u0080-\u20ff]/,
  /ƒ|€|¦|Ÿ/,
];

describe('user settings source hygiene', () => {
  it('does not contain common mojibake sequences', () => {
    for (const file of SETTINGS_FILES) {
      const absolute = join(process.cwd(), file);
      const source = readFileSync(absolute, 'utf8');
      for (const pattern of MOJIBAKE_PATTERNS) {
        expect(source, `${file} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
