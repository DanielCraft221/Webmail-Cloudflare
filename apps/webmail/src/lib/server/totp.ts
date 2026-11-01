import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

/** RFC 4648 base32. otpauth URIs use it without padding. */
export function base32Encode(data: Uint8Array, padding = true): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return padding ? out.padEnd(Math.ceil(out.length / 8) * 8, "=") : out;
}

/** Accepts upper or lower case, spaces and optional padding. Throws on anything else. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/\s/g, "").toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP. SHA-1 with 6 digits is what the authenticator apps use (docs/webmail-auth.md). */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits = 6,
  algorithm = "sha1",
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = (mac.at(-1) ?? 0) & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * The step a 6-digit code matches, within ±1 step of now, never at or before lastStep
 * (a code used once never works again). Null when it matches nothing.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastStep = -1,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = stepAt(nowMs);
  let match: number | null = null;
  // All three candidates are always compared, so the time does not depend on which one matches.
  for (const step of [now - 1, now, now + 1]) {
    const equal = timingSafeEqual(Buffer.from(hotp(secret, step)), given);
    if (equal && step > lastStep && match === null) match = step;
  }
  return match;
}

/** 160-bit secret, the size RFC 4226 recommends. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20), false);
}

export function otpauthUri(secret: string, username: string): string {
  const issuer = "Survivus Webmail";
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
