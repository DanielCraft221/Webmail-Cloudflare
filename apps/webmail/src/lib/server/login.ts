import type { DatabaseSync } from "node:sqlite";
import { api as schema } from "@webmail/shared";
import { audit, recordIpFailure } from "./audit.ts";
import { ipKey, lockBlockKey } from "./ip.ts";
import {
  banUntil,
  clearUserFailures,
  lockUntil,
  prune,
  userFailure,
} from "./limits.ts";
import { MAX_PASSWORD } from "./password.ts";
import { decryptSecret } from "./secret-box.ts";
import {
  createSession,
  lastTotpStep,
  type SessionUser,
  useTotpStep,
} from "./sessions.ts";
import { base32Decode, verifyTotp } from "./totp.ts";
import type { WebmailApi } from "./worker-api.ts";

export const GENERIC_ERROR = "Usuário, senha ou código inválidos.";
export const BANNED_ERROR = "Muitas tentativas. Tente de novo mais tarde.";

export interface LoginDeps {
  db: DatabaseSync;
  api: WebmailApi;
  totpKey: Buffer;
  verifyPassword: (hash: string, password: string) => Promise<boolean>;
  /** Same parameters as real hashes, made at startup: an unknown user costs the same time. */
  dummyHash: string;
  now: () => number;
}

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; status: 400 | 429; message: string };

/** Ban check that runs before the body is read and before argon2. */
export function isBanned(
  deps: Pick<LoginDeps, "db" | "now">,
  ip: string,
): boolean {
  return banUntil(deps.db, ipKey(ip), deps.now()) !== null;
}

/**
 * One form, one answer: every failure returns GENERIC_ERROR, so nobody learns whether the
 * password was right. Throws Argon2Busy (503) and ApiError (502) to the caller.
 */
export async function attemptLogin(
  deps: LoginDeps,
  ip: string,
  input: { username: string; password: string; code: string },
): Promise<LoginResult> {
  const now = deps.now();
  const ipk = ipKey(ip);
  prune(deps.db, now);
  if (banUntil(deps.db, ipk, now) !== null)
    return { ok: false, status: 429, message: BANNED_ERROR };

  const username = input.username.trim().toLowerCase();
  const code = input.code.replace(/\s/g, "");
  const validName = schema.username.safeParse(username).success;
  // Bans count IPv6 by /64; username locks by /48 (ip.ts).
  const lockBlock = lockBlockKey(ip);
  const locked =
    validName && lockUntil(deps.db, username, lockBlock, now) !== null;

  const fail = (reason: string, user: { id: string } | null): LoginResult => {
    recordIpFailure(deps.db, deps.api, ip, now);
    // While a lock is active, failures are not counted: they would only extend it.
    const lock =
      validName && !locked
        ? userFailure(deps.db, username, lockBlock, now)
        : null;
    // The typed username is sent only when it exists: it might be a password typed in the wrong field.
    audit(deps.api, {
      action: "login_failure",
      actorUserId: user?.id ?? null,
      ...(user ? { target: username } : {}),
      ip,
      detail: { reason },
    });
    if (lock)
      audit(deps.api, {
        action: "username_lock",
        actorUserId: user?.id ?? null,
        ...(user ? { target: username } : {}),
        ip,
        detail: { scope: lock },
      });
    return { ok: false, status: 400, message: GENERIC_ERROR };
  };

  if (locked) return fail("username_locked", null);

  const user = validName ? await deps.api.authLookup(username) : null;
  const usable =
    user?.active && user.passwordHash && user.totpSecretEnc ? user : null;
  // argon2 always runs, against the dummy hash when there is no usable user.
  const passwordOk = await deps.verifyPassword(
    usable?.passwordHash ?? deps.dummyHash,
    input.password.slice(0, MAX_PASSWORD * 4),
  );
  if (!user) return fail("unknown_user", null);
  if (!user.active) return fail("inactive", user);
  if (!usable?.totpSecretEnc) return fail("not_configured", user);
  if (!passwordOk || [...input.password].length > MAX_PASSWORD)
    return fail("bad_password", user);

  let secret: Buffer;
  try {
    secret = base32Decode(
      decryptSecret(deps.totpKey, user.id, usable.totpSecretEnc),
    );
  } catch {
    return fail("decrypt_failed", user);
  }
  const step = verifyTotp(secret, code, now);
  if (step === null) return fail("bad_code", user);
  // A code at or before the last accepted step never works again.
  if (
    step <= lastTotpStep(deps.db, user.id) ||
    !useTotpStep(deps.db, user.id, step)
  )
    return fail("code_reused", user);

  clearUserFailures(deps.db, username, lockBlock);
  const me = { id: user.id, username, displayName: null, role: user.role };
  const token = createSession(deps.db, me, ip, now);
  audit(deps.api, {
    action: "login_success",
    actorUserId: user.id,
    target: username,
    ip,
  });
  return { ok: true, token, user: me };
}
