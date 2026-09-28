# @lobbyforge/bot-sdk

The bot contract for LobbyForge:

- `createBotClient({ baseUrl, token })` — a dependency-free client for the
  Bot API v1 (`getMe`, `listChannels`, `readMessages`, `sendMessage`) with
  typed errors (`BotAuthError`, `BotForbiddenError`, `BotNotFoundError`,
  `BotRateLimitError`, `BotValidationError`, `BotServerError`,
  `BotNetworkError`, all `BotApiError`s);
- `BotPermission` / `BOT_PERMISSIONS` — every permission a bot can hold;
- the shared locale helpers (`tFor`, `loadBotLocale`, `formatMessage`, …),
  also at `@lobbyforge/bot-sdk/locale`.

How bots, tokens, permissions and the Bot API work — with curl examples and a
complete example bot — is in [`docs/BOTS.md`](../../docs/BOTS.md).
