import { describe, expect, it } from "vitest";
import { parseAuthenticationResults } from "../src/auth-results";

const header = (value: string) => ({
  key: "authentication-results",
  originalKey: "Authentication-Results",
  value,
});
const trusted = ["mx.trusted.test"];

describe("parseAuthenticationResults", () => {
  it("is all unknown with the default (empty) trust list", () => {
    const result = parseAuthenticationResults([
      header("mx.trusted.test; spf=pass; dkim=pass; dmarc=pass"),
    ]);
    expect(result).toEqual({
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
    });
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
