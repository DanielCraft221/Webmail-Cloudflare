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

/** Read once at startup. Throws (so the app does not start) when something is missing or unsafe. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  // The real IP comes only from CF-Connecting-IP, safe because only cloudflared reaches the app.
  if (production && env.ADDRESS_HEADER?.toLowerCase() !== "cf-connecting-ip")
    throw new Error("In production ADDRESS_HEADER must be cf-connecting-ip");
  const totpKey = Buffer.from(required(env, "TOTP_ENCRYPTION_KEY"), "base64");
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
