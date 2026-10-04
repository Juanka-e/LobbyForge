/**
 * Heading anchors that match GitHub's, so a link written for the repo
 * (`BOTS.md#built-in-bots`, `#32-the-contract-packagesplugin-sdksrcindexts`)
 * lands on the same heading when the document is rendered on the site.
 *
 * The rule is github-slugger's: lower-case the heading's text, drop every
 * character that is not a letter, mark, number, connector (`_`), hyphen or
 * space, then turn each space into a hyphen — no trimming, no collapsing,
 * so "Bot API v2 — design contract" becomes `bot-api-v2--design-contract`.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

export type Slugger = (text: string) => string;

/**
 * A slugger for one document: a repeated heading gets `-1`, `-2`, … the
 * way GitHub numbers them. `reserved` ids are treated as already taken,
 * so a heading can never collide with an id the page itself uses.
 */
export function createSlugger(reserved: Iterable<string> = []): Slugger {
  const occurrences = new Map<string, number>();
  for (const id of reserved) occurrences.set(id, 0);
  return (text: string) => {
    const original = slugify(text) || 'section';
    let slug = original;
    while (occurrences.has(slug)) {
      const next = (occurrences.get(original) ?? 0) + 1;
      occurrences.set(original, next);
      slug = `${original}-${next}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}
