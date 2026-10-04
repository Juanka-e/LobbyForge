/**
 * The event stream protocol is defined once and shipped twice — the
 * gateway (`apps/ws-gateway/src/bot-protocol.ts`) and the SDK
 * (`src/gateway-protocol.ts`) must stay byte-identical, so a payload the
 * gateway sends is exactly the type a bot receives.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as sdk from '../index.js';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('gateway protocol pin', () => {
  it('the SDK copy is identical to the gateway file', () => {
    const gateway = read('../../../../apps/ws-gateway/src/bot-protocol.ts');
    const sdkCopy = read('../gateway-protocol.ts');
    expect(sdkCopy).toBe(gateway);
  });

  it('is exported from the package entry point', () => {
    expect(sdk.BOT_GATEWAY_PATH).toBe('/ws/bot');
    expect(sdk.BotCloseCode).toMatchObject({ UNAUTHORIZED: 4001, FORBIDDEN: 4003, REPLACED: 4009, RATE_LIMITED: 4029 });
    expect(sdk.BOT_EVENT_PERMISSIONS.interaction_create).toBe('slash_commands');
    // Every permission an event needs is a real BotPermission.
    for (const permission of Object.values(sdk.BOT_EVENT_PERMISSIONS)) {
      if (permission) expect(sdk.isBotPermission(permission)).toBe(true);
    }
  });
});
