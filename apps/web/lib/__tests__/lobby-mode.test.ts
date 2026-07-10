import { describe, expect, it } from 'vitest';
import { isLobbyDemoAllowed } from '../lobby-mode';

describe('lobby demo boundary', () => {
  it('allows the official host to render its demo shell', () => {
    expect(isLobbyDemoAllowed({ official: true, nodeEnv: 'production', demoFlag: undefined })).toBe(true);
  });

  it('requires an explicit flag for local development', () => {
    expect(isLobbyDemoAllowed({ official: false, nodeEnv: 'development', demoFlag: undefined })).toBe(false);
    expect(isLobbyDemoAllowed({ official: false, nodeEnv: 'development', demoFlag: 'true' })).toBe(true);
  });

  it('never permits demo data on a production self-host', () => {
    expect(isLobbyDemoAllowed({ official: false, nodeEnv: 'production', demoFlag: 'true' })).toBe(false);
  });
});
