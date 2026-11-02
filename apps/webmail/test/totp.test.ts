import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hotp,
  STEP_SECONDS,
  verifyTotp,
} from "../src/lib/server/totp.ts";

describe("base32 (RFC 4648, section 10)", () => {
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ];
  it.each(vectors)("%j <-> %s", (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
    expect(
      base32Decode(encoded.replace(/=/g, "").toLowerCase()).toString(),
    ).toBe(plain);
  });
  it("refuses characters outside the alphabet", () => {
    expect(() => base32Decode("MZXW1")).toThrow();
  });
});

describe("TOTP (RFC 6238, appendix B)", () => {
  const seeds = {
    sha1: Buffer.from("12345678901234567890"),
    sha256: Buffer.from("12345678901234567890123456789012"),
    sha512: Buffer.from(
      "1234567890123456789012345678901234567890123456789012345678901234",
    ),
  };
  const vectors: [number, string, keyof typeof seeds][] = [
    [59, "94287082", "sha1"],
    [59, "46119246", "sha256"],
    [59, "90693936", "sha512"],
    [1111111109, "07081804", "sha1"],
    [1111111109, "68084774", "sha256"],
    [1111111109, "25091201", "sha512"],
    [1111111111, "14050471", "sha1"],
    [1111111111, "67062674", "sha256"],
    [1111111111, "99943326", "sha512"],
    [1234567890, "89005924", "sha1"],
    [1234567890, "91819424", "sha256"],
    [1234567890, "93441116", "sha512"],
    [2000000000, "69279037", "sha1"],
    [2000000000, "90698825", "sha256"],
    [2000000000, "38618901", "sha512"],
    [20000000000, "65353130", "sha1"],
    [20000000000, "77737706", "sha256"],
    [20000000000, "47863826", "sha512"],
  ];
  it.each(vectors)("T=%i -> %s (%s)", (time, code, algorithm) => {
    expect(
      hotp(seeds[algorithm], Math.floor(time / STEP_SECONDS), 8, algorithm),
    ).toBe(code);
  });
});

describe("verifyTotp", () => {
  const secret = Buffer.from("12345678901234567890");
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / STEP_SECONDS);
  const code = (s: number) => hotp(secret, s);

  it("accepts the current, previous and next step", () => {
    expect(verifyTotp(secret, code(step), now)).toBe(step);
    expect(verifyTotp(secret, code(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, code(step + 1), now)).toBe(step + 1);
  });
  it("refuses two steps away", () => {
    expect(verifyTotp(secret, code(step - 2), now)).toBeNull();
    expect(verifyTotp(secret, code(step + 2), now)).toBeNull();
  });
  it("refuses a code at or before the last used step", () => {
    expect(verifyTotp(secret, code(step), now, step)).toBeNull();
    expect(verifyTotp(secret, code(step - 1), now, step - 1)).toBeNull();
    expect(verifyTotp(secret, code(step + 1), now, step)).toBe(step + 1);
  });
  it("refuses anything that is not 6 digits", () => {
    expect(verifyTotp(secret, `${code(step)}0`, now)).toBeNull();
    expect(verifyTotp(secret, "12345a", now)).toBeNull();
    expect(verifyTotp(secret, "", now)).toBeNull();
  });
});
