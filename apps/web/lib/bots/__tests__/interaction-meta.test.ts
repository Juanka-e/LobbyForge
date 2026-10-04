import { describe, expect, it } from 'vitest';
import { readMessageInteraction, readMessageWebhook } from '../interaction-meta';

const botMeta = { bot: { id: 'b1', name: 'Dice', type: 'custom' } };

describe('readMessageInteraction', () => {
  it('reads the header of a bot answer', () => {
    expect(
      readMessageInteraction({
        userId: null,
        botId: 'b1',
        metadata: { ...botMeta, interaction: { id: 'i1', commandName: 'roll', invokedBy: { id: 'u1', displayName: 'Ayşe' } } },
      })
    ).toEqual({ id: 'i1', commandName: 'roll', invokedBy: { id: 'u1', name: 'Ayşe' } });
    expect(
      readMessageInteraction({ userId: null, botId: 'b1', metadata: { interaction: { id: 'i1', commandName: 'roll', invokedBy: 'u1' } } })
    ).toEqual({ id: 'i1', commandName: 'roll', invokedBy: { id: 'u1', name: null } });
  });

  it('never puts the header on a member or webhook message', () => {
    const interaction = { id: 'i1', commandName: 'roll', invokedBy: 'u1' };
    expect(readMessageInteraction({ userId: 'u2', metadata: { ...botMeta, interaction } })).toBeNull();
    expect(readMessageInteraction({ userId: null, botId: null, metadata: { webhook: { name: 'CI' }, interaction } })).toBeNull();
    expect(readMessageInteraction({ userId: null, botId: 'b1', metadata: { interaction: { id: 'i1' } } })).toBeNull();
  });
});

describe('readMessageWebhook', () => {
  it('prefers the username override', () => {
    expect(readMessageWebhook({ userId: null, botId: null, metadata: { webhook: { id: 'w1', name: 'CI', username: 'Deploys' } } })).toEqual({
      id: 'w1',
      name: 'CI',
      displayName: 'Deploys',
    });
    expect(readMessageWebhook({ userId: null, metadata: { webhook: { id: 'w1', name: 'CI', username: '  ' } } })?.displayName).toBe('CI');
  });

  it('refuses a member or bot message that claims to be a webhook', () => {
    const webhook = { id: 'w1', name: 'CI' };
    expect(readMessageWebhook({ userId: 'u1', metadata: { webhook } })).toBeNull();
    expect(readMessageWebhook({ userId: null, botId: 'b1', metadata: { webhook } })).toBeNull();
    expect(readMessageWebhook({ userId: null, metadata: { ...botMeta, webhook } })).toBeNull();
    expect(readMessageWebhook({ userId: null, metadata: {} })).toBeNull();
  });
});
