import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ipKey } from "./ip.ts";
import { banUntil, ipFailure, prune, setupHit } from "./limits.ts";
import { log } from "./log.ts";
import { passwordProblem } from "./password.ts";
import { encryptSecret } from "./secret-box.ts";
import { deleteUserSessions, useTotpStep } from "./sessions.ts";
import { base32Decode, newTotpSecret, verifyTotp } from "./totp.ts";
import type { WebmailApi } from "./worker-api.ts";

/** The secret waits here, never in D1, until the person confirms a code. */
export const PENDING_LIFETIME = 10 * 60_000;
export const INVALID_LINK =
  "Este link de configuração não vale mais. Peça um novo ao administrador.";
export const SETUP_LIMITED = "Muitas tentativas. Tente de novo mais tarde.";

export interface SetupDeps {
  db: DatabaseSync;
  api: WebmailApi;
  totpKey: Buffer;
  hashPassword: (password: string) => Promise<string>;
  now: () => number;
}

export function setupTokenHash(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

/** Rate limit and ban for every /setup request. False: answer 429. */
export function setupAllowed(
  deps: Pick<SetupDeps, "db" | "now">,
  ip: string,
): boolean {
  const now = deps.now();
  prune(deps.db, now);
  const key = ipKey(ip);
  return banUntil(deps.db, key, now) === null && setupHit(deps.db, key, now);
}

async function validUser(deps: SetupDeps, ip: string, token: string) {
  const hash = setupTokenHash(token);
  const user = hash ? await deps.api.setupLookup(hash) : null;
  if (!user || !hash) {
    ipFailure(deps.db, ipKey(ip), deps.now());
    return null;
  }
  return { ...user, hash };
}

/** The page data: who the link is for and the pending secret (made once per 10 minutes). */
export async function loadSetup(deps: SetupDeps, ip: string, token: string) {
  const user = await validUser(deps, ip, token);
  if (!user) return null;
  const now = deps.now();
  const row = deps.db
    .prepare(
      "SELECT secret FROM setup_pending WHERE token_hash = ? AND user_id = ? AND expires_at > ?",
    )
    .get(user.hash, user.id, now);
  let secret = row ? String(row.secret) : null;
  if (!secret) {
    secret = newTotpSecret();
    deps.db
      .prepare(
        "INSERT OR REPLACE INTO setup_pending (token_hash, user_id, secret, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(user.hash, user.id, secret, now + PENDING_LIFETIME);
  }
  return { username: user.username, secret };
}

export type SetupResult =
  | { ok: true }
  | { ok: false; message: string; invalidLink?: boolean };

/**
 * Password and code arrive together, so the password is never stored, not even for 10 minutes.
 * Throws Argon2Busy (503) and ApiError (502) to the caller.
 */
export async function completeSetup(
  deps: SetupDeps,
  ip: string,
  token: string,
  input: { password: string; confirm: string; code: string },
): Promise<SetupResult> {
  const user = await validUser(deps, ip, token);
  if (!user) return { ok: false, message: INVALID_LINK, invalidLink: true };
  const now = deps.now();
  const row = deps.db
    .prepare(
      "SELECT secret FROM setup_pending WHERE token_hash = ? AND user_id = ? AND expires_at > ?",
    )
    .get(user.hash, user.id, now);
  if (!row)
    return {
      ok: false,
      message:
        "O tempo para confirmar acabou. Leia o novo QR code e tente de novo.",
    };
  const secret = String(row.secret);

  const problem = passwordProblem(input.password, user.username);
  if (problem) return { ok: false, message: problem };
  if (input.password !== input.confirm)
    return { ok: false, message: "As duas senhas não são iguais." };
  const step = verifyTotp(
    base32Decode(secret),
    input.code.replace(/\s/g, ""),
    now,
  );
  if (step === null) {
    ipFailure(deps.db, ipKey(ip), now);
    return {
      ok: false,
      message: "Código inválido. Confira o horário do celular e tente de novo.",
    };
  }

  const done = await deps.api.setupComplete({
    tokenHash: user.hash,
    passwordHash: await deps.hashPassword(input.password),
    totpSecretEnc: encryptSecret(deps.totpKey, user.id, secret),
  });
  if (!done) return { ok: false, message: INVALID_LINK, invalidLink: true };
  deps.db
    .prepare("DELETE FROM setup_pending WHERE token_hash = ?")
    .run(user.hash);
  // The confirmation code cannot be reused to log in.
  useTotpStep(deps.db, user.id, step);
  deleteUserSessions(deps.db, user.id);
  deps.api
    .audit({
      action: "setup_complete",
      actorUserId: user.id,
      target: user.username,
      ip,
    })
    .catch(() => log("error", "audit_failed", { action: "setup_complete" }));
  return { ok: true };
}
