# zod 4 migration notes

Status: **deferred** (2026-10-07). zod stays on 3.25.76, and
`.github/dependabot.yml` ignores zod major versions until this migration
is done. These notes come from a trial upgrade to zod 4.6.5 on the deps
cleanup branch.

## Size

- **Imports:** 101 files import zod, including 86 of the 131 route handlers.
  Nothing imports `zod/v4` yet, and no third-party dependency uses zod.
- **Trial run:** 12 type errors in apps/web; core, config and ws-gateway
  type-check cleanly. 72 tests fail, 70 of them only because test fixtures
  use UUIDs that zod 4's stricter `.uuid()` rejects.

## Code changes needed (about half a day with the fixtures)

- `apps/web/lib/bots/admin.ts:151`: widen `invalidBody`'s issues parameter
  to zod 4's issue type.
- `apps/web/app/api/marketplace/submit/route.ts:23` and
  `apps/web/lib/captcha/altcha.ts:92`: `z.record(value)` needs an explicit
  key schema, `z.record(z.string(), value)`.
- `apps/web/lib/bots/commands.ts:142`: replace `invalid_type_error` with
  `error`. Otherwise the custom message is dropped silently.
- `apps/web/app/api/settings/me/route.ts:75`: change `z.record(z.enum(…), …)`
  to `z.partialRecord` (keybinds). zod 4 makes every enum key required.
- `apps/web/app/api/internal/plugin-storage/route.ts:32`: a `z.unknown()`
  key becomes required. Make it explicitly optional.
- Tests: fix the 39 invalid UUIDs (used about 220 times), or use `z.guid()`
  where any 8-4-4-4-12 hex shape is fine.

## Changes clients can see

- Default error messages are worded differently. About 22 places return
  them to clients as `issues` or `error`, including the Bot API.
- `.datetime()` rejects values without seconds.
- `.url()` trims its input.
- Email validation is unchanged.

None of these four are caught by the current tests: message wording,
datetime, url trimming, and the plugin-storage `value` rule.

## Suggested plan

1. Stay on 3.25.76 and switch imports to `zod/v4` (bundled in 3.25.x) one
   package at a time:
   1. `packages/config`;
   2. `apps/ws-gateway`;
   3. `packages/core`, together with the 8 web routes that embed its
      schemas;
   4. the rest of `apps/web`.
2. Bump to zod 4 with no further code change, and delete the Dependabot
   ignore rule.
3. Optionally clean up deprecations (`.strict()` and similar, about 160
   lines).
