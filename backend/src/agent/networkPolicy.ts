import { isIP } from "node:net";

export interface NetworkGrant { host: string; port: number; }
export interface NetworkPolicyDecision { allowed: boolean; reason?: string; grant?: NetworkGrant; }

function normalizePort(port: number): number | undefined {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/** Normalizes a concrete hostname or IP address; patterns and URL strings are rejected. */
export function normalizeNetworkHost(host: string): string | undefined {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253 || /[*/\\@:/\s]/.test(normalized)) return undefined;
  if (isIP(normalized)) {
    if (normalized === "0.0.0.0" || normalized === "::") return undefined;
    return normalized;
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) return undefined;
  return normalized;
}

export function normalizeNetworkGrant(grant: NetworkGrant): NetworkGrant | undefined {
  const host = normalizeNetworkHost(grant.host);
  const port = normalizePort(grant.port);
  return host && port ? { host, port } : undefined;
}

/** Default deny. A request needs an exact normalized host-and-port grant. */
export function evaluateNetworkAccess(host: string, port: number, grants: readonly NetworkGrant[] = []): NetworkPolicyDecision {
  const normalizedHost = normalizeNetworkHost(host);
  const normalizedPort = normalizePort(port);
  if (!normalizedHost || !normalizedPort) return { allowed: false, reason: "Invalid network destination" };
  for (const candidate of grants) {
    const grant = normalizeNetworkGrant(candidate);
    if (grant && grant.host === normalizedHost && grant.port === normalizedPort) return { allowed: true, grant };
  }
  return { allowed: false, reason: "Network access is denied unless explicitly granted for this host and port" };
}
