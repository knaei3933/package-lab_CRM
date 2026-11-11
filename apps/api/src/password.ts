import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return `scrypt:${salt.toString('base64')}:${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, encodedSalt, encodedKey] = stored.split(':');
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedKey) return false;
  const salt = Buffer.from(encodedSalt, 'base64');
  const expected = Buffer.from(encodedKey, 'base64');
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
