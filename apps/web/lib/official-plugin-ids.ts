/**
 * The ids of the official (compiled-in) plugins — `PLUGINS` in
 * plugin-registry.ts. A marketplace bundle may never use one: it is refused
 * at submit, at install, by the dynamic registry, by the frame-src reader
 * and by the asset route, so a bundle named like an official plugin is never
 * installed, loaded, framed or served (security review, marketplace).
 *
 * A plain list, not an import of the registry: the middleware reads the
 * frame-src origins (plugin-frame-origins.ts) and must not pull every
 * official plugin's code into its bundle. A test pins this list to the
 * registry, so adding an official plugin without adding its id here fails.
 *
 * Compared case-insensitively: plugin ids accept upper case
 * (PLUGIN_ID_RE), and "Hushle" next to "hushle" would pass for the official
 * game in every list that shows names.
 */
export const OFFICIAL_PLUGIN_IDS: readonly string[] = [
  'hushle',
  'quiz',
  'poll',
  'dice-bot',
  'watch-party',
  'vampire-village',
];

const OFFICIAL = new Set(OFFICIAL_PLUGIN_IDS);

/** Is `pluginId` (in any case) the id of an official, compiled-in plugin? */
export function isOfficialPluginId(pluginId: string): boolean {
  return OFFICIAL.has(pluginId.toLowerCase());
}

/** The refusal every marketplace path gives for an official id. */
export function officialPluginIdError(pluginId: string): string {
  return `Plugin id "${pluginId.slice(0, 128)}" belongs to an official LobbyForge plugin; a marketplace plugin cannot use it.`;
}
