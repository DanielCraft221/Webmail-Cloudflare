import { isIP } from "node:net";

/** A valid IPv4 or IPv6 address, or null. IPv4-mapped IPv6 (::ffff:1.2.3.4) becomes plain IPv4. */
export function parseIp(value: string | null | undefined): string | null {
  const ip = value?.trim() ?? "";
  if (ip.length > 45) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;
  return isIP(ip) ? ip.toLowerCase() : null;
}

/** Key for rate limits and bans: the IPv4 address, or the /64 block of an IPv6 address. */
export function ipKey(ip: string): string {
  if (isIP(ip) === 4) return ip;
  return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
}

function expandIpv6(ip: string): string[] {
  let text = ip.toLowerCase();
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill =
    tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => g.padStart(4, "0"));
}
