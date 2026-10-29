import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

/** Source of the keys that sign Access JWTs, by team domain. */
export type AccessKeys = (teamDomain: string) => JWTVerifyGetKey;

export const CLOCK_TOLERANCE_SECONDS = 60;

/** The only accepted team domain shape, so configuration can never point key fetching elsewhere. */
const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/** Production key source: the team's Access certs endpoint, cached per isolate by jose. */
export const remoteAccessKeys: AccessKeys = (teamDomain) => {
  let keys = remoteKeySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
};

export type AccessConfig = {
  teamDomain: string | undefined;
  audience: string | undefined;
  clientId: string | undefined;
};

/**
 * True only for a valid Access JWT from the expected service token: RS256, exact issuer,
 * audience containing ours, exp required, exp and nbf within the clock tolerance.
 * Missing configuration fails closed.
 */
export async function verifyAccessJwt(
  token: string | undefined,
  config: AccessConfig,
  keys: AccessKeys,
): Promise<boolean> {
  const { teamDomain, audience, clientId } = config;
  if (!token || !audience || !clientId) return false;
  if (!teamDomain || !TEAM_DOMAIN.test(teamDomain)) return false;
  try {
    const { payload } = await jwtVerify(token, keys(teamDomain), {
      algorithms: ["RS256"],
      issuer: teamDomain,
      audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp"],
    });
    return payload.common_name === clientId;
  } catch {
    return false;
  }
}
