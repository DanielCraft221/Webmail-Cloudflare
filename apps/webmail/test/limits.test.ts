import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/server/db.ts";
import { ipKey } from "../src/lib/server/ip.ts";
import {
  BAN_STEPS,
  banUntil,
  clearUser,
  ipFailure,
  lockUntil,
  removeBan,
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
  it("locks after 5 failures and clears", () => {
    const db = openDb(":memory:");
    const key = userKey(" Ana ");
    expect(key).toBe(userKey("ana"));
    for (let i = 0; i < 4; i++) expect(userFailure(db, key, i)).toBe(false);
    expect(userFailure(db, key, 4)).toBe(true);
    expect(lockUntil(db, key, 5)).toBe(4 + 15 * MINUTE);
    expect(lockUntil(db, key, 4 + 15 * MINUTE)).toBeNull();
    expect(clearUser(db, key)).toBe(1);
    expect(lockUntil(db, key, 5)).toBeNull();
  });
});
