import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

export const DUMMY_PASSWORD_HASH = `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEY_LENGTH).toString('base64')}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY },
      (error, key) => error ? reject(error) : resolve(key as Buffer)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, rawCost, rawBlockSize, rawParallelization, rawSalt, rawKey] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    Number(rawCost) !== COST ||
    Number(rawBlockSize) !== BLOCK_SIZE ||
    Number(rawParallelization) !== PARALLELIZATION ||
    !rawSalt ||
    !rawKey
  ) return false;

  const salt = Buffer.from(rawSalt, 'base64');
  const expected = Buffer.from(rawKey, 'base64');
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}
