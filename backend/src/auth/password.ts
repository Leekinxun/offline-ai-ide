import crypto from "node:crypto";

// The existing users.json format stores a password string. Prefixing the KDF
// output lets existing plaintext records be upgraded without a schema change.
const PREFIX = "scrypt";
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const HASH_PATTERN = /^scrypt\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const DUMMY_SALT = Buffer.alloc(16, 0x43);

function deriveAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELISM,
      maxmem: 32 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export function isPasswordHash(value: string): boolean {
  return value.startsWith(`${PREFIX}$`);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: 32 * 1024 * 1024,
  });
  return `${PREFIX}$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await deriveAsync(password, salt);
  return `${PREFIX}$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!isPasswordHash(stored)) {
    const candidate = Buffer.from(password);
    const legacy = Buffer.from(stored);
    return candidate.length === legacy.length && crypto.timingSafeEqual(candidate, legacy);
  }
  const match = HASH_PATTERN.exec(stored);
  if (!match) return false;
  const salt = Buffer.from(match[1], "hex");
  const expected = Buffer.from(match[2], "hex");
  const candidate = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: 32 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(candidate, expected);
}

/** Always performs one asynchronous KDF, including for unknown users and
 * legacy plaintext records, so account existence cannot be inferred from a
 * fast failure and unauthenticated HTTP requests do not block the event loop. */
export async function verifyPasswordAsync(password: string, stored?: string): Promise<boolean> {
  const match = stored && HASH_PATTERN.exec(stored);
  const salt = match ? Buffer.from(match[1], "hex") : DUMMY_SALT;
  const candidate = await deriveAsync(password, salt);
  if (!stored) return false;
  if (!isPasswordHash(stored)) {
    const offered = Buffer.from(password);
    const legacy = Buffer.from(stored);
    return offered.length === legacy.length && crypto.timingSafeEqual(offered, legacy);
  }
  return match ? crypto.timingSafeEqual(candidate, Buffer.from(match[2], "hex")) : false;
}
