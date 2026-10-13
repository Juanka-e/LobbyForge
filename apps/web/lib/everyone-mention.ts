/**
 * Does a member's text mention `@everyone` or `@here`? The Mention
 * Everyone gate of the message routes (post AND edit) and the chat-poll
 * route. As in Discord, the one permission covers both: `@here` pings
 * everyone online — the same mass ping for the people it reaches — and
 * used to need no permission at all.
 *
 * Every mention a reader sees counts, not only one after a space:
 * `(@everyone)` or `hi,@here` used to pass without the permission. No
 * letter, digit or `_` may sit right before the `@` or right after the
 * word, so an address like `ada@everyone.example` or `ops@here.dev` is not
 * a mention. NFKC first: a full-width `＠everyone` is still @everyone to a
 * reader. The bots' mass-mention rule (`containsMassMention` in
 * lib/bots/settings.ts) is this same function. Client-safe.
 */
export function mentionsEveryoneOrHere(text: string): boolean {
  return /(^|[^\p{L}\p{N}_])@(everyone|here)(?![\p{L}\p{N}_])/iu.test(text.normalize('NFKC'));
}
