/**
 * Canonical language-tag validation for card packs (BCP-47-ish).
 * Shared by the admin card-pack route (pack creation) and
 * prepare-plugin-action (game start) so both enforce the same contract.
 */
export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

export function isValidLanguageTag(value: string): boolean {
  return LANGUAGE_TAG_PATTERN.test(value);
}
