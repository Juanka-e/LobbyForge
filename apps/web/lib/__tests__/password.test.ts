import { describe, expect, it } from 'vitest';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../password';

describe('password hashing', () => {
  it('round-trips a password without storing it in the encoded value', async () => {
    const password = 'Correct horse battery 42!';
    const encoded = await hashPassword(password);
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', encoded)).resolves.toBe(false);
  });

  it('uses a valid dummy hash for unknown-account timing parity', async () => {
    await expect(verifyPassword('anything', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });
});
