import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/** 64 MiB, t=3, p=1: about 170 ms on the server (docs/webmail-auth.md). */
export const ARGON2_PARAMS = {
  memory: 65536,
  passes: 3,
  parallelism: 1,
} as const;
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;
const TAG_LENGTH = 32;
/** Each run takes 64 MiB: more than two at once is refused, not queued. */
const MAX_CONCURRENT = 2;

export class Argon2Busy extends Error {}

let running = 0;

function derive(
  password: string,
  salt: Buffer,
  params: { memory: number; passes: number; parallelism: number },
): Promise<Buffer> {
  if (running >= MAX_CONCURRENT) return Promise.reject(new Argon2Busy());
  running++;
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      "argon2id",
      { message: password, nonce: salt, tagLength: TAG_LENGTH, ...params },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  }).finally(() => {
    running--;
  });
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

/** PHC string: $argon2id$v=19$m=…,t=…,p=…$salt$hash (base64 without padding). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, ARGON2_PARAMS);
  const { memory: m, passes: t, parallelism: p } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(key)}`;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** False for a wrong password or a malformed hash. Throws Argon2Busy when two runs are already going. */
export async function verifyPassword(
  phc: string,
  password: string,
): Promise<boolean> {
  const m = PHC.exec(phc);
  if (!m) return false;
  const [memory, passes, parallelism] = [m[1], m[2], m[3]].map(Number) as [
    number,
    number,
    number,
  ];
  // Parameters come from our own D1, but a huge value must still not exhaust the container.
  if (memory > 262144 || passes > 10 || parallelism > 4) return false;
  const expected = Buffer.from(m[5] ?? "", "base64");
  const key = await derive(password, Buffer.from(m[4] ?? "", "base64"), {
    memory,
    passes,
    parallelism,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Length counts characters, not bytes. No composition rules (docs/etapas/etapa-5.md). */
export function passwordProblem(
  password: string,
  username: string,
): string | null {
  const length = [...password].length;
  if (length < MIN_PASSWORD)
    return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (length > MAX_PASSWORD)
    return `A senha pode ter no máximo ${MAX_PASSWORD} caracteres.`;
  if (password.trim().toLowerCase() === username.toLowerCase())
    return "A senha não pode ser igual ao usuário.";
  return null;
}
