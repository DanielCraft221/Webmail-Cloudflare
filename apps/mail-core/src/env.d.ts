// Set in Etapa 3 PR 2 (docs/cloudflare.md): vars in wrangler.jsonc, secrets with `wrangler secret put`.
// `wrangler types` cannot see secrets. While any is missing, every /v1 request answers 401.
interface Env {
  /** https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string | undefined;
  /** AUD tag of the Access application. */
  ACCESS_AUD?: string | undefined;
  /** Client ID of the webmail service token, checked against the JWT common_name. Secret. */
  ACCESS_CLIENT_ID?: string | undefined;
  /** Bearer token the webmail sends. Secret. */
  INTERNAL_API_TOKEN?: string | undefined;
}

declare namespace Cloudflare {
  interface Env {
    ACCESS_TEAM_DOMAIN?: string | undefined;
    ACCESS_AUD?: string | undefined;
    ACCESS_CLIENT_ID?: string | undefined;
    INTERNAL_API_TOKEN?: string | undefined;
  }
}
