import { type ApiConfig, checkApiUrl } from "./worker-api.ts";

export interface Config {
  production: boolean;
  api: ApiConfig;
  totpKey: Buffer;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value)
    throw new Error(`Missing ${name} (see apps/webmail/.env.example)`);
  return value;
}

/**
 * Values that were published in apps/webmail/.env.example (the current one and an older one
 * that was a valid 32-byte key). Anyone can read them, so they never encrypt real secrets.
 */
const EXAMPLE_TOTP_KEYS = new Set([
  "replace-with-openssl-rand-base64-32",
  "ZmFrZS1rZXktZmFrZS1rZXktZmFrZS1rZXktZmFrZSE=",
]);

/**
 * Read once at startup. Throws (so the app does not start) when something is missing or unsafe.
 * `production` is true in every build (`!dev`), never taken from NODE_ENV: a compose file that
 * forgets NODE_ENV must not turn the IP and HSTS checks off.
 */
export function loadConfig(
  production: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  // The real IP comes only from CF-Connecting-IP, safe because only cloudflared reaches the app.
  if (production && env.ADDRESS_HEADER?.toLowerCase() !== "cf-connecting-ip")
    throw new Error("In production ADDRESS_HEADER must be cf-connecting-ip");
  const keyText = required(env, "TOTP_ENCRYPTION_KEY");
  if (EXAMPLE_TOTP_KEYS.has(keyText.trim()))
    throw new Error(
      "TOTP_ENCRYPTION_KEY is the example value: generate one with openssl rand -base64 32",
    );
  const totpKey = Buffer.from(keyText, "base64");
  if (totpKey.length !== 32)
    throw new Error("TOTP_ENCRYPTION_KEY must be 32 bytes in base64");
  return {
    production,
    totpKey,
    api: {
      apiUrl: checkApiUrl(
        env.MAIL_API_URL || "https://mail-api.survivus.com.br",
      ),
      bearer: required(env, "INTERNAL_API_TOKEN"),
      accessClientId: required(env, "CF_ACCESS_CLIENT_ID"),
      accessClientSecret: required(env, "CF_ACCESS_CLIENT_SECRET"),
    },
  };
}
