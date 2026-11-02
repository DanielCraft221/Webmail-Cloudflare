import type { SessionUser } from "#lib/server/sessions.ts";

declare global {
  namespace App {
    interface Locals {
      ip: string;
      user: SessionUser | null;
      sessionHash: string | null;
    }
  }
}
