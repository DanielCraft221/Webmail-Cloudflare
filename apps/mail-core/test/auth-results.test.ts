import { describe, expect, it } from "vitest";
import { parseAuthenticationResults } from "../src/auth-results";

const header = (value: string) => ({
  key: "authentication-results",
  originalKey: "Authentication-Results",
  value,
});
const trusted = ["mx.trusted.test"];

describe("parseAuthenticationResults", () => {
  it("trusts only Cloudflare's authserv-id by default", () => {
    expect(
      parseAuthenticationResults([
        header("mx.trusted.test; spf=pass; dkim=pass; dmarc=pass"),
      ]),
    ).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
    expect(
      parseAuthenticationResults([
        header("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"),
      ]).dmarc,
    ).toBe("pass");
  });

  // Invented values in the format Cloudflare writes: SPF for HELO first, then for MAIL FROM.
  it("prefers the smtp.mailfrom SPF result over smtp.helo", () => {
    const result = parseAuthenticationResults([
      header(
        "mx.cloudflare.net; dkim=pass header.d=example.net header.s=sel1 header.b=AbCdEf12; dmarc=pass header.from=example.net policy.dmarc=quarantine; spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-out.example.net) smtp.helo=mail-out.example.net; spf=pass (mx.cloudflare.net: domain of bounce@example.net designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@example.net; arc=pass smtp.remote-ip=192.0.2.10",
      ),
    ]);
    expect(result).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  it("falls back to the first SPF result without smtp.mailfrom", () => {
    const result = parseAuthenticationResults(
      [header("mx.trusted.test; spf=none smtp.helo=mail.example.net")],
      trusted,
    );
    expect(result.spf).toBe("none");
  });

  it("is all unknown without any Authentication-Results", () => {
    expect(parseAuthenticationResults([], trusted)).toEqual({
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });

  it("reads a trusted header, ignoring comments and properties", () => {
    const result = parseAuthenticationResults(
      [
        header(
          "mx.trusted.test 1; spf=pass (sender allowed) smtp.mailfrom=a.example; dkim=fail header.d=a.example; dmarc=pass",
        ),
      ],
      trusted,
    );
    expect(result).toEqual({ spf: "pass", dkim: "fail", dmarc: "pass" });
  });

  it("ignores an untrusted topmost header claiming dmarc=pass", () => {
    const result = parseAuthenticationResults(
      [header("evil.example; dmarc=pass")],
      trusted,
    );
    expect(result.dmarc).toBe("unknown");
  });

  it("uses only the topmost header: a forged one below is ignored", () => {
    const result = parseAuthenticationResults(
      [
        header("mx.trusted.test; dmarc=fail"),
        header("mx.trusted.test; dmarc=pass"),
      ],
      trusted,
    );
    expect(result.dmarc).toBe("fail");
  });

  it("does not trust an authserv-id hidden in a comment", () => {
    const result = parseAuthenticationResults(
      [header("(mx.trusted.test) evil.example; dmarc=pass")],
      trusted,
    );
    expect(result.dmarc).toBe("unknown");
  });

  it("keeps unknown values out", () => {
    expect(
      parseAuthenticationResults(
        [header("mx.trusted.test; dmarc=bogus")],
        trusted,
      ).dmarc,
    ).toBe("unknown");
  });

  // Workers freeze Date.now() during synchronous code, so the test timeout is the guard here.
  it("handles deeply nested comments in linear time", () => {
    const nested = `${"(".repeat(200_000)}x${")".repeat(200_000)}`;
    const result = parseAuthenticationResults(
      [header(`mx.trusted.test ${nested}; dmarc=pass`)],
      trusted,
    );
    expect(result.dmarc).toBe("pass");
  });
});
