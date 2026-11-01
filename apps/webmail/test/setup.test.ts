import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/lib/server/db.ts";
import { decryptSecret } from "../src/lib/server/secret-box.ts";
import { lastTotpStep } from "../src/lib/server/sessions.ts";
import {
  completeSetup,
  INVALID_LINK,
  loadSetup,
  PENDING_LIFETIME,
  type SetupDeps,
} from "../src/lib/server/setup.ts";
import { base32Decode, hotp, stepAt } from "../src/lib/server/totp.ts";
import type { WebmailApi } from "../src/lib/server/worker-api.ts";

const ANA = "11111111-1111-4111-8111-111111111111";
const TOKEN = randomBytes(32).toString("base64url");
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function make(now = 1_700_000_000_000) {
  let clock = now;
  const api = {
    setupLookup: vi.fn(async (h: string) =>
      h === HASH ? { id: ANA, username: "ana" } : null,
    ),
    setupComplete: vi.fn(async () => ({ id: ANA, username: "ana" })),
    audit: vi.fn(async () => {}),
  } as unknown as WebmailApi;
  const deps: SetupDeps = {
    db: openDb(":memory:"),
    api,
    totpKey: randomBytes(32),
    hashPassword: vi.fn(
      async () => "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA",
    ),
    now: () => clock,
  };
  return { deps, api, tick: (ms: number) => (clock += ms), now: () => clock };
}

describe("setup link", () => {
  it("refuses an unknown or malformed token", async () => {
    const t = make();
    expect(await loadSetup(t.deps, "203.0.113.7", "x".repeat(43))).toBeNull();
    expect(await loadSetup(t.deps, "203.0.113.7", "../etc")).toBeNull();
    expect(t.api.setupLookup).toHaveBeenCalledTimes(1); // the malformed one never reaches the API
  });

  it("keeps the same pending secret for 10 minutes, then a new one", async () => {
    const t = make();
    const first = await loadSetup(t.deps, "203.0.113.7", TOKEN);
    expect(first?.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect((await loadSetup(t.deps, "203.0.113.7", TOKEN))?.secret).toBe(
      first?.secret,
    );
    t.tick(PENDING_LIFETIME);
    expect((await loadSetup(t.deps, "203.0.113.7", TOKEN))?.secret).not.toBe(
      first?.secret,
    );
  });

  it("completes with a valid code and stores only hash and encrypted secret", async () => {
    const t = make();
    const setup = await loadSetup(t.deps, "203.0.113.7", TOKEN);
    const secret = setup?.secret ?? "";
    const code = hotp(base32Decode(secret), stepAt(t.now()));
    const result = await completeSetup(t.deps, "203.0.113.7", TOKEN, {
      password: "a long enough password",
      confirm: "a long enough password",
      code,
    });
    expect(result).toEqual({ ok: true });
    const body = (t.api.setupComplete as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(body.tokenHash).toBe(HASH);
    expect(JSON.stringify(body)).not.toContain("a long enough password");
    expect(decryptSecret(t.deps.totpKey, ANA, body.totpSecretEnc)).toBe(secret);
    // The confirmation code cannot be used again to log in.
    expect(lastTotpStep(t.deps.db, ANA)).toBe(stepAt(t.now()));
    expect(
      t.deps.db.prepare("SELECT count(*) AS n FROM setup_pending").get()?.n,
    ).toBe(0);
  });

  it("refuses a short password, different confirmation and wrong code", async () => {
    const t = make();
    const secret =
      (await loadSetup(t.deps, "203.0.113.7", TOKEN))?.secret ?? "";
    const code = hotp(base32Decode(secret), stepAt(t.now()));
    const tries = [
      { password: "short", confirm: "short", code },
      {
        password: "a long enough password",
        confirm: "another long password",
        code,
      },
      {
        password: "a long enough password",
        confirm: "a long enough password",
        code: "000000",
      },
      { password: "ana", confirm: "ana", code },
    ];
    for (const input of tries)
      expect(
        (await completeSetup(t.deps, "203.0.113.7", TOKEN, input)).ok,
      ).toBe(false);
    expect(t.api.setupComplete).not.toHaveBeenCalled();
  });

  it("reports the link as invalid when the API says 404 (already used)", async () => {
    const t = make();
    (t.api.setupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const secret =
      (await loadSetup(t.deps, "203.0.113.7", TOKEN))?.secret ?? "";
    const code = hotp(base32Decode(secret), stepAt(t.now()));
    const result = await completeSetup(t.deps, "203.0.113.7", TOKEN, {
      password: "a long enough password",
      confirm: "a long enough password",
      code,
    });
    expect(result).toEqual({
      ok: false,
      message: INVALID_LINK,
      invalidLink: true,
    });
  });
});
