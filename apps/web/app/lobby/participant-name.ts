/**
 * The name a voice participant is shown under.
 *
 * A LiveKit identity is the member's user id. Its name comes from the
 * participant's own token (the server resolves the community nickname,
 * else the display name, when it signs it), so it is right even for
 * someone who joined after this page loaded. Failing that, the names the
 * page loaded with. Never the identity: a raw user id on the voice list or
 * on a game's bench is meaningless to people. `null` means "not known",
 * and the caller shows a translated "Unknown member".
 */
export function resolveParticipantName(
  identity: string,
  liveKitName: string | null | undefined,
  knownNames: Readonly<Record<string, string>>
): string | null {
  const own = liveKitName?.trim();
  if (own && own !== identity) return own;
  const known = knownNames[identity]?.trim();
  if (known && known !== identity) return known;
  return null;
}
