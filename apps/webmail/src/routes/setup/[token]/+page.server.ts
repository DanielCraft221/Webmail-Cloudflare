import { error, fail, redirect } from "@sveltejs/kit";
import { ctx } from "#lib/server/context.ts";
import { log } from "#lib/server/log.ts";
import {
  Argon2Busy,
  hashPassword,
  MAX_PASSWORD,
  MIN_PASSWORD,
} from "#lib/server/password.ts";
import { qrDataUri } from "#lib/server/qr.ts";
import {
  completeSetup,
  loadSetup,
  SETUP_LIMITED,
  setupAllowed,
} from "#lib/server/setup.ts";
import { otpauthUri } from "#lib/server/totp.ts";
import { ApiError } from "#lib/server/worker-api.ts";
import type { Actions, PageServerLoad } from "./$types";

function deps() {
  const { db, api, config } = ctx();
  return { db, api, totpKey: config.totpKey, hashPassword, now: Date.now };
}

function unavailable(err: unknown): never {
  if (err instanceof Argon2Busy)
    error(503, "Servidor ocupado. Tente de novo em alguns segundos.");
  log("error", "setup_error", {
    status: err instanceof ApiError ? err.status : null,
  });
  error(502, "Serviço indisponível. Tente de novo em instantes.");
}

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!setupAllowed(deps(), locals.ip)) error(429, SETUP_LIMITED);
  let setup: Awaited<ReturnType<typeof loadSetup>>;
  try {
    setup = await loadSetup(deps(), locals.ip, params.token);
  } catch (err) {
    unavailable(err);
  }
  if (!setup) return { valid: false as const };
  // Grouped in fours, for typing by hand. The secret never goes to a log.
  const grouped = setup.secret.match(/.{1,4}/g)?.join(" ") ?? setup.secret;
  return {
    valid: true as const,
    username: setup.username,
    secret: grouped,
    qr: qrDataUri(otpauthUri(setup.secret, setup.username)),
    minPassword: MIN_PASSWORD,
    maxPassword: MAX_PASSWORD,
  };
};

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, 1024) : "";
};

export const actions: Actions = {
  default: async ({ params, locals, request }) => {
    if (!setupAllowed(deps(), locals.ip))
      return fail(429, { message: SETUP_LIMITED });
    const form = await request.formData();
    let result: Awaited<ReturnType<typeof completeSetup>>;
    try {
      result = await completeSetup(deps(), locals.ip, params.token, {
        password: text(form, "password"),
        confirm: text(form, "confirm"),
        code: text(form, "code"),
      });
    } catch (err) {
      unavailable(err);
    }
    if (!result.ok) return fail(400, { message: result.message });
    redirect(303, "/login?configurado");
  },
};
