import { MESSAGES_ROOT, getDiscovery, loadEnglishPlurals, loadMessages } from '@/lib/i18n/catalogue';
import type { Messages } from '@/lib/i18n/core';
import type { SetupLanguage } from './SetupWizard';

/** Every string the wizard renders starts with this; nothing else goes to the page. */
export const SETUP_MESSAGE_PREFIX = 'auth.setup.';

function setupOnly(messages: Messages): Messages {
  const picked: Messages = {};
  for (const [key, value] of Object.entries(messages)) if (key.startsWith(SETUP_MESSAGE_PREFIX)) picked[key] = value;
  return picked;
}

/**
 * Every language on disk, with its setup strings merged over English —
 * what the wizard's language step lists and switches between without a
 * round trip. Discovered, not listed: a language added later is on the
 * setup screen with no code change. Server only (reads the catalogues).
 */
export function setupLanguages(root: string = MESSAGES_ROOT): SetupLanguage[] {
  return getDiscovery(root).locales.map((info) => ({
    info,
    messages: setupOnly(loadMessages(info.code, root)),
    englishPlurals: loadEnglishPlurals(info.code, root).filter((key) => key.startsWith(SETUP_MESSAGE_PREFIX)),
  }));
}
