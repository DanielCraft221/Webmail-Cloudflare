import { error, fail, redirect } from "@sveltejs/kit";
import { ctx } from "#lib/server/context.ts";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "#lib/server/cookie.ts";
import { log } from "#lib/server/log.ts";
import { attemptLogin, BANNED_ERROR, isBanned } from "#lib/server/login.ts";
import { Argon2Busy, verifyPassword } from "#lib/server/password.ts";
import { ApiError } from "#lib/server/worker-api.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) redirect(303, "/");
  return { setupDone: url.searchParams.has("configurado") };
};

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, 1024) : "";
};

export const actions: Actions = {
  default: async ({ request, locals, cookies }) => {
    const { db, api, config, dummyHash } = ctx();
    const deps = {
      db,
      api,
      totpKey: config.totpKey,
      verifyPassword,
      dummyHash,
      now: Date.now,
    };
    // The ban is checked before the body is even read.
    if (isBanned(deps, locals.ip))
      return fail(429, { message: BANNED_ERROR, username: "" });
    const form = await request.formData();
    const username = text(form, "username");
    try {
      const result = await attemptLogin(deps, locals.ip, {
        username,
        password: text(form, "password"),
        code: text(form, "code"),
      });
      if (!result.ok)
        return fail(result.status, { message: result.message, username });
      cookies.set(SESSION_COOKIE, result.token, SESSION_COOKIE_OPTIONS);
    } catch (err) {
      if (err instanceof Argon2Busy)
        error(503, "Servidor ocupado. Tente de novo em alguns segundos.");
      log("error", "login_error", {
        status: err instanceof ApiError ? err.status : null,
      });
      error(502, "Serviço indisponível. Tente de novo em instantes.");
    }
    redirect(303, "/");
  },
};
