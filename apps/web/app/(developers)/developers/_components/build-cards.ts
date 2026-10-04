/**
 * The overview's "What you can build" cards, each linking to the document
 * (or the section of it) that explains it. `tag` is the API or SDK the
 * card belongs to — a product name, so it is not translated; the title
 * and body are `developers.overview.card.<id>.*`.
 *
 * A fragment must be a heading id in that document. A test holds every
 * one to it, so a renamed heading fails the suite instead of shipping a
 * dead anchor.
 */
export const BUILD_CARDS = [
  { id: 'bots', icon: 'smart_toy', tag: 'Bot API v1', href: '/developers/bots' },
  { id: 'commands', icon: 'terminal', tag: 'Bot API v2', href: '/developers/bot-api-v2#3-slash-commands-and-interactions' },
  { id: 'events', icon: 'bolt', tag: 'Bot API v2', href: '/developers/bot-api-v2#4-event-stream-websocket-gateway' },
  { id: 'webhooks', icon: 'webhook', tag: 'Bot API v2', href: '/developers/bot-api-v2#5-webhooks' },
  { id: 'marketplace', icon: 'storefront', tag: 'Plugin SDK', href: '/developers/publishing' },
  { id: 'compiled', icon: 'extension', tag: 'Plugin SDK', href: '/developers/plugins' },
] as const;
