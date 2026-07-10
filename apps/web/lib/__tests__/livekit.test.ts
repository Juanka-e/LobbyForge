import { describe, it, expect } from 'vitest';
import { jwtVerify } from 'jose';
import {
  issueLiveKitToken,
  LIVEKIT_TOKEN_TTL_SECONDS,
  requireLiveKitCredentials,
  type LiveKitGrants,
} from '../livekit.js';

const API_KEY = 'APIabc123';
const API_SECRET = 'this-is-a-test-secret-32chars-long';
const NOW = 1_700_000_000;
const SECRET_BYTES = new TextEncoder().encode(API_SECRET);

describe('issueLiveKitToken', () => {
  it('produces a JWT signed with the API secret', async () => {
    const token = await issueLiveKitToken({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: 'g_0123456789abcdef0123456789abcdef',
      name: 'Guest aaaa',
      grants: { room: 'lobby' },
      now: NOW,
    });

    const { payload, protectedHeader } = await jwtVerify(token, SECRET_BYTES, { currentDate: new Date(NOW * 1000) });
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.iss).toBe(API_KEY);
    expect(payload.sub).toBe('g_0123456789abcdef0123456789abcdef');
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + LIVEKIT_TOKEN_TTL_SECONDS);

    const video = payload.video as LiveKitGrants;
    expect(video.room).toBe('lobby');
    expect(video.roomJoin).toBe(true);
    expect(video.canPublish).toBe(true);
    expect(video.canSubscribe).toBe(true);
    expect(video.canPublishData).toBe(true);
  });

  it('respects the canPublishSources narrowing', async () => {
    const token = await issueLiveKitToken({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: 'g_1',
      name: 'x',
      grants: { room: 'r', canPublishSources: ['microphone'] },
      now: NOW,
    });
    const { payload } = await jwtVerify(token, SECRET_BYTES, { currentDate: new Date(NOW * 1000) });
    expect((payload.video as LiveKitGrants).canPublishSources).toEqual(['microphone']);
  });

  it('includes metadata when provided', async () => {
    const token = await issueLiveKitToken({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: 'g_1',
      name: 'x',
      grants: { room: 'r' },
      metadata: '{"role":"host"}',
      now: NOW,
    });
    const { payload } = await jwtVerify(token, SECRET_BYTES, { currentDate: new Date(NOW * 1000) });
    expect(payload.metadata).toBe('{"role":"host"}');
  });

  it('throws when apiKey is missing', async () => {
    await expect(
      issueLiveKitToken({
        apiKey: '',
        apiSecret: API_SECRET,
        identity: 'g_1',
        name: 'x',
        grants: { room: 'r' },
        now: NOW,
      })
    ).rejects.toThrow(/apiKey/);
  });

  it('throws when apiSecret is missing', async () => {
    await expect(
      issueLiveKitToken({
        apiKey: API_KEY,
        apiSecret: '',
        identity: 'g_1',
        name: 'x',
        grants: { room: 'r' },
        now: NOW,
      })
    ).rejects.toThrow(/apiSecret/);
  });

  it('throws when identity is missing', async () => {
    await expect(
      issueLiveKitToken({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        identity: '',
        name: 'x',
        grants: { room: 'r' },
        now: NOW,
      })
    ).rejects.toThrow(/identity/);
  });

  it('throws when room is missing', async () => {
    await expect(
      issueLiveKitToken({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        identity: 'g_1',
        name: 'x',
        grants: { room: '' },
        now: NOW,
      })
    ).rejects.toThrow(/grants\.room/);
  });

  it('uses a custom ttlSeconds', async () => {
    const token = await issueLiveKitToken({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: 'g_1',
      name: 'x',
      grants: { room: 'r' },
      ttlSeconds: 60,
      now: NOW,
    });
    const { payload } = await jwtVerify(token, SECRET_BYTES, { currentDate: new Date(NOW * 1000) });
    expect(payload.exp).toBe(NOW + 60);
  });

  it('emits the recorder flag when requested', async () => {
    const token = await issueLiveKitToken({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: 'g_1',
      name: 'x',
      grants: { room: 'r', recorder: true },
      now: NOW,
    });
    const { payload } = await jwtVerify(token, SECRET_BYTES, { currentDate: new Date(NOW * 1000) });
    expect((payload.video as LiveKitGrants).recorder).toBe(true);
  });
});

describe('requireLiveKitCredentials', () => {
  it('returns key/secret when both env vars are set', () => {
    const got = requireLiveKitCredentials({ LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' });
    expect(got).toEqual({ apiKey: 'k', apiSecret: 's' });
  });

  it('throws when either is missing', () => {
    expect(() => requireLiveKitCredentials({ LIVEKIT_API_KEY: 'k' })).toThrow();
    expect(() => requireLiveKitCredentials({ LIVEKIT_API_SECRET: 's' })).toThrow();
    expect(() => requireLiveKitCredentials({})).toThrow();
  });
});
