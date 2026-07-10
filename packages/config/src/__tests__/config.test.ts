import { describe, it, expect } from 'vitest';
import { loadConfig } from '../index.js';

describe('AppConfig', () => {
  it('should successfully parse valid environment variables', () => {
    const validEnv = {
      NODE_ENV: 'test' as const,
      PORT: '4000',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/lobbyforge',
      REDIS_URL: 'redis://localhost:6379',
      LIVEKIT_URL: 'https://livekit.example.com',
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret',
    };

    const config = loadConfig(validEnv);

    expect(config.env).toBe('test');
    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.livekit.apiKey).toBe('test-key');
  });

  it('should throw validation error when required variables are missing', () => {
    const invalidEnv = {
      NODE_ENV: 'test',
    };

    expect(() => loadConfig(invalidEnv)).toThrow();
  });
});
