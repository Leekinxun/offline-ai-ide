import crypto from "node:crypto";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Request } from "express";
import { sessionManager, type UserSession } from "../auth/sessionManager.js";
import { getTeamManager, resolveActiveTeam } from "../team/sessionBridge.js";

const TICKET_LIFETIME_MS = 90_000;
const MOBILE_IDLE_MS = 30 * 60_000;
const MOBILE_ABSOLUTE_MS = 8 * 60 * 60_000;
const PAIRING_RETENTION_MS = 10 * 60_000;
const PRODUCTION_COOKIE = "__Host-crewforge_mobile";
const DEVELOPMENT_COOKIE = "crewforge_mobile_dev";

export type PairingStatus = "pending" | "claimed" | "approved" | "rejected" | "expired" | "used";

export interface MobileScope {
  key: string;
  workspaceDir: string;
  teamId: string | null;
}

export interface MobileSession {
  id: string;
  username: string;
  parentSessionToken: string;
  workspaceDir: string;
  workspaceRoot: string;
  teamId: string | null;
  scopeKey: string;
  allowedScopes: MobileScope[];
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  idleExpiresAt: number;
  csrfToken: string;
}

interface PairingRecord {
  id: string;
  ticketHash: string;
  parentSessionToken: string;
  username: string;
  createdAt: number;
  expiresAt: number;
  status: PairingStatus;
  shortCode?: string;
  claimHash?: string;
  claimedAt?: number;
  deviceName?: string;
}

export class PairingError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

function secret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function getMobilePublicBaseUrl(): URL {
  const raw = process.env.MOBILE_PUBLIC_BASE_URL || process.env.CROWNFORGE_PUBLIC_URL;
  if (!raw) {
    throw new PairingError("MOBILE_PUBLIC_BASE_URL must point to the phone-reachable HTTPS origin", 503);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PairingError("MOBILE_PUBLIC_BASE_URL is not a valid URL", 503);
  }
  const localHttp = process.env.NODE_ENV !== "production" && url.protocol === "http:" && isLoopback(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || !url.host || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new PairingError("MOBILE_PUBLIC_BASE_URL must be an HTTPS origin (HTTP loopback is for local development only)", 503);
  }
  return url;
}

export function isSameMobileOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return false;
  try {
    return new URL(origin).origin === getMobilePublicBaseUrl().origin;
  } catch {
    return false;
  }
}

export function mobileCookieName(): string {
  const url = getMobilePublicBaseUrl();
  return url.protocol === "https:" ? PRODUCTION_COOKIE : DEVELOPMENT_COOKIE;
}

export function mobileCookieHeader(value: string, maxAgeSeconds: number): string {
  const secure = getMobilePublicBaseUrl().protocol === "https:" ? "; Secure" : "";
  return `${mobileCookieName()}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; SameSite=Strict${secure}`;
}

export function mobileCookieValue(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie || "";
  const name = mobileCookieName();
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function validateMobileCsrf(session: MobileSession, provided: unknown): boolean {
  if (typeof provided !== "string" || !provided) return false;
  const expected = Buffer.from(session.csrfToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function publicMobileSession(session: MobileSession) {
  return {
    id: session.id,
    username: session.username,
    teamId: session.teamId,
    scopeKey: session.scopeKey,
    expiresAt: session.expiresAt,
    idleExpiresAt: session.idleExpiresAt,
    csrfToken: session.csrfToken,
  };
}

export class MobilePairingManager {
  private pairings = new Map<string, PairingRecord>();
  private tickets = new Map<string, string>();
  private claims = new Map<string, string>();
  private mobileSessions = new Map<string, MobileSession>();
  private mobileHashesById = new Map<string, string>();

  private desktop(token: string, touch = true): UserSession | null {
    return sessionManager.getSession(token, { touch });
  }

  private prune(now = Date.now()): void {
    for (const [id, pairing] of this.pairings) {
      if (now <= pairing.expiresAt + PAIRING_RETENTION_MS) continue;
      this.pairings.delete(id);
      this.tickets.delete(pairing.ticketHash);
      if (pairing.claimHash) this.claims.delete(pairing.claimHash);
    }
    for (const [hash, session] of this.mobileSessions) {
      const activeScope = session.allowedScopes.find((scope) => scope.key === session.scopeKey);
      if (now >= session.expiresAt || now >= session.idleExpiresAt || !this.desktop(session.parentSessionToken, false) ||
          !activeScope || !this.validScope(session, activeScope, false)) {
        this.mobileSessions.delete(hash);
        this.mobileHashesById.delete(session.id);
      }
    }
  }

  private currentStatus(pairing: PairingRecord, now = Date.now()): PairingStatus {
    if (now >= pairing.expiresAt && pairing.status !== "used" && pairing.status !== "rejected") {
      pairing.status = "expired";
      this.tickets.delete(pairing.ticketHash);
    }
    if (!this.desktop(pairing.parentSessionToken) && pairing.status !== "used") {
      pairing.status = "expired";
      this.tickets.delete(pairing.ticketHash);
    }
    return pairing.status;
  }

  private pairingForDesktop(id: string, parentSessionToken: string): PairingRecord {
    const pairing = this.pairings.get(id);
    if (!pairing || pairing.parentSessionToken !== parentSessionToken || !this.desktop(parentSessionToken)) {
      throw new PairingError("Pairing not found", 404);
    }
    this.currentStatus(pairing);
    return pairing;
  }

  create(parent: UserSession) {
    if (process.env.CREWFORGE_DESKTOP === "1") {
      throw new PairingError("Mobile pairing is available only in the Web deployment", 404);
    }
    if (!sessionManager.canExposeMobile()) {
      throw new PairingError("Configure users.json and change the default admin password before enabling mobile access", 503);
    }
    const base = getMobilePublicBaseUrl();
    if (!this.desktop(parent.token)) throw new PairingError("Desktop session expired", 401);
    this.prune();
    for (const pairing of this.pairings.values()) {
      if (pairing.parentSessionToken !== parent.token ||
          !["pending", "claimed", "approved"].includes(this.currentStatus(pairing))) continue;
      pairing.status = "rejected";
      this.tickets.delete(pairing.ticketHash);
    }
    const ticket = secret();
    const now = Date.now();
    const record: PairingRecord = {
      id: crypto.randomUUID(),
      ticketHash: digest(ticket),
      parentSessionToken: parent.token,
      username: parent.username,
      createdAt: now,
      expiresAt: now + TICKET_LIFETIME_MS,
      status: "pending",
    };
    this.pairings.set(record.id, record);
    this.tickets.set(record.ticketHash, record.id);
    const pairUrl = new URL("/mobile/pair", base);
    pairUrl.hash = `ticket=${encodeURIComponent(ticket)}`;
    return { id: record.id, ticket, pairUrl: pairUrl.toString(), expiresAt: record.expiresAt, status: record.status };
  }

  status(id: string, parentSessionToken: string) {
    const pairing = this.pairingForDesktop(id, parentSessionToken);
    return {
      id: pairing.id,
      status: pairing.status,
      expiresAt: pairing.expiresAt,
      shortCode: pairing.shortCode || null,
      deviceName: pairing.deviceName || null,
      claimedAt: pairing.claimedAt || null,
    };
  }

  claim(ticket: string, deviceName?: string) {
    this.prune();
    const id = this.tickets.get(digest(ticket));
    const pairing = id ? this.pairings.get(id) : null;
    if (!pairing || this.currentStatus(pairing) !== "pending") {
      throw new PairingError("Pairing ticket is invalid or already claimed", 409);
    }
    const claimToken = secret();
    pairing.claimHash = digest(claimToken);
    pairing.shortCode = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    pairing.claimedAt = Date.now();
    pairing.deviceName = typeof deviceName === "string" && deviceName.trim()
      ? deviceName.trim().slice(0, 80)
      : "微信手机浏览器";
    pairing.status = "claimed";
    this.tickets.delete(pairing.ticketHash);
    this.claims.set(pairing.claimHash, pairing.id);
    return { claimToken, shortCode: pairing.shortCode, status: pairing.status, expiresAt: pairing.expiresAt };
  }

  claimStatus(claimToken: string) {
    const id = this.claims.get(digest(claimToken));
    const pairing = id ? this.pairings.get(id) : null;
    if (!pairing) throw new PairingError("Claim not found", 404);
    return { status: this.currentStatus(pairing), shortCode: pairing.shortCode, expiresAt: pairing.expiresAt };
  }

  approve(id: string, parentSessionToken: string) {
    const pairing = this.pairingForDesktop(id, parentSessionToken);
    if (pairing.status !== "claimed") throw new PairingError("Pairing is not awaiting approval", 409);
    pairing.status = "approved";
    return this.status(id, parentSessionToken);
  }

  reject(id: string, parentSessionToken: string) {
    const pairing = this.pairingForDesktop(id, parentSessionToken);
    if (pairing.status !== "pending" && pairing.status !== "claimed") {
      throw new PairingError("Pairing cannot be rejected", 409);
    }
    pairing.status = "rejected";
    this.tickets.delete(pairing.ticketHash);
    return this.status(id, parentSessionToken);
  }

  private capturedScopes(parent: UserSession): MobileScope[] {
    const teamScopes: MobileScope[] = [];
    for (const team of getTeamManager(parent).listTeams(parent.username)) {
      if (!team.role || !sessionManager.isSelectableWorkspace(team.workspaceDir)) continue;
      teamScopes.push({ key: `team:${team.id}`, workspaceDir: path.resolve(team.workspaceDir), teamId: team.id });
    }
    // A team workspace must not also appear as a solo scope with a null role.
    if (teamScopes.some((scope) => scope.workspaceDir === path.resolve(parent.workspaceRoot))) return teamScopes;
    return [{ key: "personal", workspaceDir: parent.workspaceRoot, teamId: null }, ...teamScopes];
  }

  exchange(claimToken: string): { cookieSecret: string; session: MobileSession } {
    const claimHash = digest(claimToken);
    const id = this.claims.get(claimHash);
    const pairing = id ? this.pairings.get(id) : null;
    if (!pairing || this.currentStatus(pairing) !== "approved") {
      throw new PairingError("Pairing is not approved or has expired", 409);
    }
    const parent = this.desktop(pairing.parentSessionToken);
    if (!parent || parent.username !== pairing.username) throw new PairingError("Desktop session expired", 401);
    const allowedScopes = this.capturedScopes(parent);
    if (!allowedScopes.length) throw new PairingError("No authorized mobile workspace", 403);
    const activeTeamId = resolveActiveTeam(parent)?.id || null;
    const initial = allowedScopes.find((scope) => scope.teamId && scope.teamId === activeTeamId)
      || allowedScopes[0];
    const now = Date.now();
    const cookieSecret = secret();
    const session: MobileSession = {
      id: crypto.randomUUID(),
      username: parent.username,
      parentSessionToken: parent.token,
      workspaceDir: initial.workspaceDir,
      workspaceRoot: parent.workspaceRoot,
      teamId: initial.teamId,
      scopeKey: initial.key,
      allowedScopes,
      deviceName: pairing.deviceName || "微信手机浏览器",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + MOBILE_ABSOLUTE_MS,
      idleExpiresAt: now + MOBILE_IDLE_MS,
      csrfToken: secret(),
    };
    pairing.status = "used";
    this.claims.delete(claimHash);
    this.mobileSessions.set(digest(cookieSecret), session);
    this.mobileHashesById.set(session.id, digest(cookieSecret));
    return { cookieSecret, session };
  }

  private validScope(session: MobileSession, scope: MobileScope, touch = true): boolean {
    if (!sessionManager.isSelectableWorkspace(scope.workspaceDir)) return false;
    if (!scope.teamId) {
      const parent = this.desktop(session.parentSessionToken, touch);
      if (!parent || getTeamManager(parent).hasTeamAtWorkspace(scope.workspaceDir)) return false;
      return path.resolve(scope.workspaceDir) === path.resolve(session.workspaceRoot);
    }
    const parent = this.desktop(session.parentSessionToken, touch);
    if (!parent) return false;
    try {
      const currentTeam = getTeamManager(parent).getTeamDetails(scope.teamId, session.username);
      return path.resolve(currentTeam.workspaceDir) === path.resolve(scope.workspaceDir);
    } catch {
      return false;
    }
  }

  getSession(cookieSecret: string | null | undefined, options: { touch?: boolean } = {}): MobileSession | null {
    if (!cookieSecret) return null;
    const hash = digest(cookieSecret);
    const session = this.mobileSessions.get(hash);
    if (!session) return null;
    const now = Date.now();
    const parent = this.desktop(session.parentSessionToken, options.touch !== false);
    const activeScope = session.allowedScopes.find((scope) => scope.key === session.scopeKey);
    if (now >= session.expiresAt || now >= session.idleExpiresAt || !parent ||
        parent.username !== session.username || !activeScope || !this.validScope(session, activeScope, options.touch !== false)) {
      this.revoke(session.id);
      return null;
    }
    if (options.touch !== false) {
      session.lastSeenAt = now;
      session.idleExpiresAt = Math.min(now + MOBILE_IDLE_MS, session.expiresAt);
    }
    return session;
  }

  availableScopes(session: MobileSession): MobileScope[] {
    return session.allowedScopes.filter((scope) => this.validScope(session, scope, false));
  }

  setScope(session: MobileSession, key: string): MobileSession {
    const current = this.mobileSessions.get(this.mobileHashesById.get(session.id) || "");
    if (current !== session) throw new PairingError("Mobile session expired", 401);
    const scope = session.allowedScopes.find((entry) => entry.key === key);
    if (!scope || !this.validScope(session, scope)) throw new PairingError("Scope is no longer available", 403);
    session.scopeKey = scope.key;
    session.workspaceDir = scope.workspaceDir;
    session.teamId = scope.teamId;
    return session;
  }

  listDevices(parent: UserSession) {
    this.prune();
    return [...this.mobileSessions.values()]
      .filter((session) => session.username === parent.username)
      .map((session) => ({
        id: session.id,
        deviceName: session.deviceName,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        teamId: session.teamId,
      }))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  revoke(id: string): boolean {
    const hash = this.mobileHashesById.get(id);
    if (!hash) return false;
    this.mobileHashesById.delete(id);
    return this.mobileSessions.delete(hash);
  }

  revokeForUser(id: string, username: string): boolean {
    const hash = this.mobileHashesById.get(id);
    const session = hash ? this.mobileSessions.get(hash) : null;
    return session?.username === username ? this.revoke(id) : false;
  }
}

export const mobilePairingManager = new MobilePairingManager();

export function getMobileSessionFromRequest(req: Request): MobileSession | null {
  try {
    return mobilePairingManager.getSession(mobileCookieValue(req));
  } catch {
    return null;
  }
}

export function getMobileSessionFromUpgrade(req: IncomingMessage): MobileSession | null {
  if (!isSameMobileOrigin(req)) return null;
  try {
    return mobilePairingManager.getSession(mobileCookieValue(req), { touch: false });
  } catch {
    return null;
  }
}
