import { describe, it, expect } from 'vitest';
import { BotClient, BotLifecycleState, BotManifest, BotPermission } from '../index.js';

class MockBot implements BotClient {
  manifest: BotManifest;
  state: BotLifecycleState = 'idle';
  sentMessages: { channelId: string; content: string }[] = [];

  constructor(manifest: BotManifest) {
    this.manifest = manifest;
  }

  async connect(_token: string) {
    this.state = 'connecting';
    this.state = 'active';
  }

  async disconnect() {
    this.state = 'disconnected';
  }

  async sendMessage(channelId: string, content: string) {
    if (this.state !== 'active') {
      throw new Error('Bot is not active');
    }
    this.sentMessages.push({ channelId, content });
  }
}

describe('bot-sdk and Bot class compliance', () => {
  it('should manage bot lifecycle state and simulate message sending', async () => {
    const manifest: BotManifest = {
      id: 'music-bot',
      name: 'Music Bot',
      version: '1.0.0',
      permissions: [BotPermission.JOIN_VOICE, BotPermission.PUBLISH_AUDIO],
    };

    const bot = new MockBot(manifest);
    expect(bot.state).toBe('idle');
    expect(bot.manifest.permissions).toContain(BotPermission.PUBLISH_AUDIO);

    await bot.connect('dummy-token');
    expect(bot.state).toBe('active');

    await bot.sendMessage('general-channel', 'Now playing: Ambient Beats');
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.sentMessages[0]).toEqual({
      channelId: 'general-channel',
      content: 'Now playing: Ambient Beats',
    });

    await bot.disconnect();
    expect(bot.state).toBe('disconnected');
  });

  it('should throw error when sending message if bot is not active', async () => {
    const bot = new MockBot({
      id: 'test-bot',
      name: 'Test Bot',
      version: '1.0.0',
      permissions: [BotPermission.SEND_MESSAGES],
    });

    await expect(bot.sendMessage('channel-1', 'hello')).rejects.toThrow('Bot is not active');
  });
});
