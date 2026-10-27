import { z } from "zod";

/**
 * Schema for a mailbox address on one of the given domains.
 * Domains come from configuration (the database), never hard-coded.
 * Output is trimmed and lowercased. Domains must match exactly: subdomains are rejected.
 */
export function mailboxAddress(allowedDomains: readonly string[]) {
  const domains = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  return z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email())
    .refine(
      (address) => domains.has(address.slice(address.lastIndexOf("@") + 1)),
      {
        message: "Domain is not configured",
      },
    );
}
