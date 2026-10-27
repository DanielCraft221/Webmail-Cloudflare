// Secrets are set with `wrangler secret put`, so `wrangler types` cannot see them.
interface Env {
  /** Verified Email Routing destination used when storing a message fails. */
  FALLBACK_FORWARD_TO?: string;
}

declare namespace Cloudflare {
  interface Env {
    FALLBACK_FORWARD_TO?: string;
  }
}
