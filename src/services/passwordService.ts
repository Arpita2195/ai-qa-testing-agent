import crypto from "node:crypto";

/**
 * Scrypt-based password hashing using recommended OWASP parameters:
 * N: 16384 (cost), r: 8 (block size), p: 1 (parallelization), keyLen: 64 bytes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:N=16384,r=8,p=1$${salt}$${derivedKey.toString("hex")}`);
    });
  });
}

/**
 * Constant-time password verification against stored scrypt hash.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || typeof storedHash !== "string") return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || !parts[0].startsWith("scrypt:")) return false;

  const salt = parts[1];
  const expectedKey = Buffer.from(parts[2], "hex");

  return new Promise((resolve) => {
    crypto.scrypt(
      password,
      salt,
      expectedKey.length,
      { N: 16384, r: 8, p: 1 },
      (err, derivedKey) => {
        if (err) return resolve(false);
        try {
          resolve(crypto.timingSafeEqual(expectedKey, derivedKey));
        } catch {
          resolve(false);
        }
      },
    );
  });
}
