// Secrets set with `wrangler secret put` (docs/cloudflare.md), which `wrangler types` cannot see.
// While any is missing, every /v1 request answers 401.
interface Env {
  /** AUD tag of the Access application. Not truly secret, kept out of the repo (docs/decisoes.md). */
  ACCESS_AUD?: string | undefined;
  /** Client ID of the webmail service token, checked against the JWT common_name. */
  ACCESS_CLIENT_ID?: string | undefined;
  /** Bearer token the webmail sends. Never opens /v1/admin/*. */
  INTERNAL_API_TOKEN?: string | undefined;
  /** Bearer token only the admin CLI holds. Opens /v1/admin/* and nothing else. */
  ADMIN_API_TOKEN?: string | undefined;
}

declare namespace Cloudflare {
  interface Env {
    ACCESS_AUD?: string | undefined;
    ACCESS_CLIENT_ID?: string | undefined;
    INTERNAL_API_TOKEN?: string | undefined;
    ADMIN_API_TOKEN?: string | undefined;
  }
}
