/**
 * The list of official plugin ids every marketplace path refuses must be the
 * compiled-in registry's: an official plugin added to PLUGINS without its id
 * here would leave its id open to a marketplace bundle.
 */
import { describe, expect, it } from 'vitest';
import { OFFICIAL_PLUGIN_IDS, isOfficialPluginId, officialPluginIdError } from '../official-plugin-ids';
import { PLUGINS } from '../plugin-registry';

describe('OFFICIAL_PLUGIN_IDS', () => {
  it('is exactly the compiled-in registry’s ids', () => {
    expect([...OFFICIAL_PLUGIN_IDS].sort()).toEqual(PLUGINS.map((p) => p.manifest.id).sort());
  });

  it('matches in any case, and nothing else', () => {
    for (const id of OFFICIAL_PLUGIN_IDS) {
      expect(isOfficialPluginId(id)).toBe(true);
      expect(isOfficialPluginId(id.toUpperCase())).toBe(true);
    }
    for (const id of ['hushle2', 'my-quiz', 'sandbox-buzzer', 'dice', '']) expect(isOfficialPluginId(id)).toBe(false);
  });

  it('says why, in one line', () => {
    expect(officialPluginIdError('Hushle')).toMatch(/^Plugin id "Hushle" belongs to an official LobbyForge plugin/);
  });
});
