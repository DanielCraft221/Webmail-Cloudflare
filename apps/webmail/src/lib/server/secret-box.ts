import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * AES-256-GCM, "v1.<iv>.<ciphertext+tag>" in base64url. The user id is the associated data:
 * a secret copied into another user's row in D1 fails to decrypt.
 */
export function encryptSecret(
  key: Buffer,
  userId: string,
  plaintext: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `v1.${b64url(iv)}.${b64url(body)}`;
}

/** Throws when the format, key, user id or content does not match. */
export function decryptSecret(
  key: Buffer,
  userId: string,
  value: string,
): string {
  const [version, ivText, bodyText, extra] = value.split(".");
  if (version !== "v1" || !ivText || !bodyText || extra !== undefined)
    throw new Error("bad format");
  const iv = Buffer.from(ivText, "base64url");
  const body = Buffer.from(bodyText, "base64url");
  if (iv.length !== 12 || body.length < 17) throw new Error("bad format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(body.subarray(-16));
  return Buffer.concat([
    decipher.update(body.subarray(0, -16)),
    decipher.final(),
  ]).toString("utf8");
}
