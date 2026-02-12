import crypto from 'crypto';

const HASH_ITERATIONS = 120000;
const HASH_LENGTH = 64;
const HASH_DIGEST = 'sha512';

export const hashPassword = (password: string) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_LENGTH, HASH_DIGEST)
    .toString('hex');
  return `${HASH_ITERATIONS}:${salt}:${hash}`;
};

export const verifyPassword = (password: string, stored: string) => {
  const [iterRaw, salt, hash] = stored.split(':');
  const iterations = Number(iterRaw || HASH_ITERATIONS);
  if (!salt || !hash) {
    return false;
  }
  const derived = crypto
    .pbkdf2Sync(password, salt, iterations, HASH_LENGTH, HASH_DIGEST)
    .toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
};
