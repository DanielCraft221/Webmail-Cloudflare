import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/server/db.ts";
import { ipKey, lockBlockKey } from "../src/lib/server/ip.ts";
import {
  BAN_STEPS,
  banUntil,
  clearUser,
  clearUserFailures,
  ipFailure,
  lockUntil,
  removeBan,
  USER_FAILURES,
  userFailure,
  userKey,
} from "../src/lib/server/limits.ts";

const MINUTE = 60_000;

describe("IP bans", () => {
  it("bans after 10 failures in 15 minutes, longer each time within 7 days", () => {
    const db = openDb(":memory:");
    const key = ipKey("203.0.113.7");
    let now = 1_000_000_000_000;
    const tenFailures = () => {
      let length: number | null = null;
      for (let i = 0; i < 10; i++) length = ipFailure(db, key, now + i);
      return length;
    };
    for (let i = 0; i < 9; i++) expect(ipFailure(db, key, now + i)).toBeNull();
    expect(banUntil(db, key, now + 10)).toBeNull();
    expect(ipFailure(db, key, now + 9)).toBe(BAN_STEPS[0]);
    expect(banUntil(db, key, now + 10)).toBe(now + 9 + 15 * MINUTE);

    now += 20 * MINUTE;
    expect(tenFailures()).toBe(60 * MINUTE);
    now += 2 * 60 * MINUTE;
    expect(tenFailures()).toBe(24 * 60 * MINUTE);
    now += 8 * 24 * 60 * MINUTE;
    expect(tenFailures()).toBe(BAN_STEPS[0]);
  });

  it("does not count failures older than 15 minutes", () => {
    const db = openDb(":memory:");
    const key = ipKey("203.0.113.8");
    for (let i = 0; i < 9; i++) ipFailure(db, key, i);
    expect(ipFailure(db, key, 16 * MINUTE)).toBeNull();
  });

  it("counts two IPv6 addresses of the same /64 together", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i++)
      ipFailure(db, ipKey(`2001:db8:5:6::${i + 1}`), i);
    for (let i = 0; i < 4; i++)
      ipFailure(db, ipKey(`2001:db8:5:6:aaaa::${i + 1}`), 10 + i);
    expect(ipFailure(db, ipKey("2001:db8:5:6:ffff:ffff:ffff:ffff"), 20)).toBe(
      BAN_STEPS[0],
    );
    expect(banUntil(db, ipKey("2001:db8:5:6::99"), 30)).not.toBeNull();
    expect(banUntil(db, ipKey("2001:db8:5:7::1"), 30)).toBeNull();
    expect(removeBan(db, ipKey("2001:db8:5:6::1"))).toBe(1);
  });
});

describe("username locks", () => {
  const A = ipKey("198.51.100.1");
  const B = ipKey("198.51.100.2");

  it("locks a username for one IP block after 5 failures from it", () => {
    const db = openDb(":memory:");
    expect(userKey(" Ana ")).toBe(userKey("ana"));
    for (let i = 0; i < 4; i++) expect(userFailure(db, "ana", A, i)).toBeNull();
    expect(userFailure(db, "ana", A, 4)).toBe("ip");
    expect(lockUntil(db, "ana", A, 5)).toBe(4 + 15 * MINUTE);
    expect(lockUntil(db, "ana", A, 4 + 15 * MINUTE)).toBeNull();
    // Another IP block, or the same block for another username, is not locked.
    expect(lockUntil(db, "ana", B, 5)).toBeNull();
    expect(lockUntil(db, "bia", A, 5)).toBeNull();
  });

  it("counts the IPv6 /48 as one block", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i++)
      userFailure(db, "ana", lockBlockKey(`2001:db8:1:${i}::1`), i);
    expect(
      lockUntil(db, "ana", lockBlockKey("2001:db8:1:ffff::9"), 5),
    ).not.toBeNull();
    expect(lockUntil(db, "ana", lockBlockKey("2001:db8:2::1"), 5)).toBeNull();
  });

  it("locks the username for every IP after 50 failures from many IPs", () => {
    const db = openDb(":memory:");
    let scope: string | null = null;
    for (let i = 0; i < USER_FAILURES; i++)
      scope = userFailure(db, "ana", ipKey(`203.0.113.${i}`), i);
    expect(scope).toBe("global");
    expect(lockUntil(db, "ana", ipKey("192.0.2.1"), 60)).not.toBeNull();
  });

  it("a success clears the counts; the CLI clears every lock of the username", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 4; i++) userFailure(db, "ana", A, i);
    clearUserFailures(db, "ana", A);
    expect(userFailure(db, "ana", A, 10)).toBeNull();
    for (let i = 0; i < 5; i++) userFailure(db, "ana", B, 20 + i);
    for (let i = 0; i < 5; i++) userFailure(db, "bia", B, 20 + i);
    expect(clearUser(db, "ana")).toBe(1);
    expect(lockUntil(db, "ana", B, 30)).toBeNull();
    expect(lockUntil(db, "bia", B, 30)).not.toBeNull();
  });
});
