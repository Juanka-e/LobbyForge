/**
 * Does a member's text mention `@everyone`? The Mention Everyone gate of
 * the message routes (post AND edit) and the chat-poll route.
 *
 * Every `@everyone` a reader sees counts, not only one after a space:
 * `(@everyone)` or `hi,@everyone` used to pass without the permission. The
 * boundaries are the bots' mass-mention rule (`containsMassMention` in
 * lib/bots/settings.ts): no letter, digit or `_` right before the `@` or
 * right after the word — so an address like `ada@everyone.example` is not a
 * mention. NFKC first: a full-width `＠everyone` is still @everyone to a
 * reader.
 */
export function mentionsEveryone(text: string): boolean {
  return /(^|[^\p{L}\p{N}_])@everyone(?![\p{L}\p{N}_])/iu.test(text.normalize('NFKC'));
}
