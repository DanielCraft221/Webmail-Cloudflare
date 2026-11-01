import { describe, expect, it } from "vitest";
import { ipKey, parseIp } from "../src/lib/server/ip.ts";

describe("parseIp", () => {
  it("accepts IPv4 and IPv6, maps ::ffff:a.b.c.d to IPv4", () => {
    expect(parseIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(parseIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(parseIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
  it("refuses anything else", () => {
    for (const bad of [
      null,
      "",
      "unknown",
      "203.0.113.7, 10.0.0.1",
      "999.1.1.1",
      "x".repeat(60),
    ])
      expect(parseIp(bad)).toBeNull();
  });
});

describe("ipKey", () => {
  it("keeps IPv4 whole", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
  });
  it("groups IPv6 by /64", () => {
    expect(ipKey("2001:db8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(
      ipKey("2001:db8:1:2::1"),
    );
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipKey("64:ff9b::203.0.113.7")).toBe("0064:ff9b:0000:0000::/64");
  });
});
