import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TaskManager } from "../agent/taskManager.js";
import { MessageBus } from "../agent/messageBus.js";
import { TeammateManager } from "../agent/teammateManager.js";
import { config } from "../config.js";
import { setActiveTeamId } from "../team/sessionBridge.js";
import { reconcileChangeSetReviewRuns } from "../chat/changeSetReviewRun.js";
import { warmTypeScriptLanguageService } from "../utils/typescriptLanguageService.js";
import { hashPassword, hashPasswordAsync, isPasswordHash, verifyPassword, verifyPasswordAsync } from "./password.js";

const DESKTOP_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const DESKTOP_SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;

interface UserConfig {
  username: string;
  password: string;
  defaultWorkspace: string;
  isAdmin?: boolean;
}

interface RegistrationRequest {
  username: string;
  password: string;
  requestedAt: number;
}

interface UsersConfig {
  allowedRoots: string[];
  users: UserConfig[];
  pendingRegistrations: RegistrationRequest[];
}

export interface SafeUserConfig {
  username: string;
  defaultWorkspace: string;
  isAdmin: boolean;
}

export interface SafeRegistrationRequest {
  username: string;
  requestedAt: number;
}

export function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  const c = path.resolve(candidate);
  const p = path.resolve(parent);
  if (process.platform === "win32") {
    const cLower = c.toLowerCase();
    const pLower = p.toLowerCase();
    return cLower === pLower || cLower.startsWith(`${pLower}${path.sep}`);
  }
  return c === p || c.startsWith(`${p}${path.sep}`);
}

export function isSamePath(a: string, b: string): boolean {
  const resA = path.resolve(a);
  const resB = path.resolve(b);
  if (process.platform === "win32") {
    return resA.toLowerCase() === resB.toLowerCase();
  }
  return resA === resB;
}

export interface UserSession {
  token: string;
  username: string;
  workspaceDir: string;
  workspaceRoot: string;
  isAdmin: boolean;
  isolated: boolean;
  taskManager: TaskManager;
  messageBus: MessageBus;
  teammateManager: TeammateManager;
  createdAt?: number;
  lastSeenAt?: number;
  expiresAt?: number;
}

export interface SessionSummary {
  token: string;
  username: string;
  workspaceDir: string;
  workspaceRoot: string;
  isAdmin: boolean;
  isolated: boolean;
  expiresAt?: number;
}

function createSessionSingletons(workspaceDir: string) {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const teammateManager = new TeammateManager(workspaceDir, messageBus, taskManager);
  // Durable orchestration state can outlive the process; reconcile it before a
  // new session exposes stale "working" agents or expired work/message leases.
  taskManager.releaseExpiredLeases();
  messageBus.reclaimExpired();
  teammateManager.reconcile();
  // Review attempts are separately leased durable work. Resume or mark any
  // orphaned attempt as soon as the workspace becomes active, without waiting
  // for a review-runs UI/API read.
  void Promise.resolve().then(() => reconcileChangeSetReviewRuns(workspaceDir)).catch(() => { /* best-effort startup recovery */ });
  const warmup = setTimeout(() => warmTypeScriptLanguageService(workspaceDir), 0);
  warmup.unref?.();
  return { taskManager, messageBus, teammateManager };
}

let createSessionSingletonsForManager = createSessionSingletons;

export function setCreateSessionSingletonsForTests(
  value?: typeof createSessionSingletons
): void {
  createSessionSingletonsForManager = value || createSessionSingletons;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private revokedListeners = new Set<(token: string) => void>();
  private loadedConfigFromFile = false;
  private configRevision = 0;
  private migrationPromise: Promise<boolean> | null = null;
  private mobileExposureCache: { revision: number; allowed: boolean } | null = null;
  private usersConfig: UsersConfig;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath
      ? path.resolve(configPath)
      : this.resolveDefaultConfigPath();
    this.usersConfig = this.loadConfig();
  }

  private resolveConfigCandidates(): string[] {
    return Array.from(new Set([
      this.configPath,
      process.env.USERS_CONFIG,
      path.resolve(process.cwd(), "users.json"),
      path.resolve(process.cwd(), "../users.json"),
    ].filter(Boolean) as string[]));
  }

  private resolveDefaultConfigPath(): string {
    const configured = process.env.USERS_CONFIG;
    if (configured) {
      return path.resolve(configured);
    }
    if (process.cwd().endsWith(`${path.sep}backend`)) {
      return path.resolve(process.cwd(), "../users.json");
    }
    return path.resolve(process.cwd(), "users.json");
  }

  private normalizeUser(user: Partial<UserConfig>): UserConfig | null {
    const username = typeof user.username === "string" ? user.username.trim() : "";
    const password = typeof user.password === "string" ? user.password : "";
    const defaultWorkspace =
      typeof user.defaultWorkspace === "string" && user.defaultWorkspace.trim()
        ? path.resolve(user.defaultWorkspace)
        : path.resolve(config.defaultWorkspaceDir, username || "workspace");

    if (!username || !password) {
      return null;
    }

    return {
      username,
      password,
      defaultWorkspace,
      isAdmin: user.isAdmin ?? username === "admin",
    };
  }

  private normalizeRegistration(
    registration: Partial<RegistrationRequest>
  ): RegistrationRequest | null {
    const username =
      typeof registration.username === "string" ? registration.username.trim() : "";
    const password = typeof registration.password === "string" ? registration.password : "";
    const requestedAt =
      typeof registration.requestedAt === "number" && Number.isFinite(registration.requestedAt)
        ? registration.requestedAt
        : Date.now();
    if (!username || !password || !this.isValidUsername(username)) return null;
    return { username, password, requestedAt };
  }

  private normalizeConfig(raw: Partial<UsersConfig>): UsersConfig {
    const allowedRoots = Array.isArray(raw.allowedRoots) && raw.allowedRoots.length > 0
      ? raw.allowedRoots
          .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
          .map((root) => path.resolve(root))
      : [path.resolve(config.defaultWorkspaceDir)];
    const initialWorkspaceRoot = path.resolve(config.defaultWorkspaceDir);
    const hasDefaultRoot = allowedRoots.some((root) => isSameOrDescendantPath(initialWorkspaceRoot, root));
    if (!hasDefaultRoot) {
      allowedRoots.push(initialWorkspaceRoot);
    }

    const users = Array.isArray(raw.users)
      ? raw.users
          .map((user) => this.normalizeUser(user))
          .filter((user): user is UserConfig => user !== null)
      : [];

    if (users.length === 0) {
      users.push({
        username: "admin",
        password: "admin123",
        defaultWorkspace: path.resolve(config.defaultWorkspaceDir),
        isAdmin: true,
      });
    }

    const existingUsernames = new Set(users.map((user) => user.username));
    const pendingUsernames = new Set<string>();
    const pendingRegistrations = Array.isArray(raw.pendingRegistrations)
      ? raw.pendingRegistrations
          .map((registration) => this.normalizeRegistration(registration))
          .filter((registration): registration is RegistrationRequest => {
            if (!registration) return false;
            if (existingUsernames.has(registration.username)) return false;
            if (pendingUsernames.has(registration.username)) return false;
            pendingUsernames.add(registration.username);
            return true;
          })
      : [];

    return { allowedRoots, users, pendingRegistrations };
  }

  private loadConfig(): UsersConfig {
    if (process.env.CREWFORGE_DESKTOP === "1") {
      // A desktop install must never recover a damaged credentials file by
      // silently enabling the Web development default (admin/admin123).
      const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Partial<UsersConfig>;
      if (!Array.isArray(raw.users) || !raw.users.some((user) => user && typeof user === "object" && this.normalizeUser(user))) {
        throw new Error("Desktop users configuration has no valid account");
      }
      console.log(`Loaded users config from ${this.configPath}`);
      this.loadedConfigFromFile = true;
      return this.normalizeConfig(raw);
    }
    for (const configPath of this.resolveConfigCandidates()) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const normalized = this.normalizeConfig(JSON.parse(raw) as Partial<UsersConfig>);
        this.configPath = configPath;
        console.log(`Loaded users config from ${configPath}`);
        this.loadedConfigFromFile = true;
        return normalized;
      } catch {
        // try next
      }
    }

    console.warn("users.json not found, using defaults");
    this.configPath = this.resolveDefaultConfigPath();
    this.loadedConfigFromFile = false;
    return this.normalizeConfig({});
  }

  canExposeMobile(): boolean {
    if (this.mobileExposureCache?.revision === this.configRevision) return this.mobileExposureCache.allowed;
    const allowed = this.loadedConfigFromFile && !this.usersConfig.users.some((user) =>
      user.username === "admin" && Boolean(user.isAdmin) && verifyPassword("admin123", user.password)
    );
    this.mobileExposureCache = { revision: this.configRevision, allowed };
    return allowed;
  }

  private saveConfig(): void {
    this.writeConfig(this.usersConfig);
    this.loadedConfigFromFile = true;
  }

  private writeConfig(configToSave: UsersConfig): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(configToSave, null, 2)}\n`, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, this.configPath);
      this.configRevision += 1;
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  }

  private getUser(username: string): UserConfig | undefined {
    return this.usersConfig.users.find((user) => user.username === username);
  }

  private cloneUsersConfig(): UsersConfig {
    return {
      allowedRoots: [...this.usersConfig.allowedRoots],
      users: this.usersConfig.users.map((user) => ({ ...user })),
      pendingRegistrations: this.usersConfig.pendingRegistrations.map((registration) => ({ ...registration })),
    };
  }

  private isValidUsername(username: string): boolean {
    return /^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,63}$/u.test(username);
  }

  private toSafeUser(user: UserConfig): SafeUserConfig {
    return {
      username: user.username,
      defaultWorkspace: path.resolve(user.defaultWorkspace),
      isAdmin: Boolean(user.isAdmin),
    };
  }

  private syncSessionsForUser(username: string): void {
    const user = this.getUser(username);
    for (const [token, session] of this.sessions.entries()) {
      if (session.username !== username) continue;
      if (!user) {
        this.deleteSession(token);
        continue;
      }
      session.isAdmin = Boolean(user.isAdmin);
    }
  }

  reloadConfig(): void {
    const previousPasswords = new Map(this.usersConfig.users.map((user) => [user.username, user.password]));
    this.usersConfig = this.loadConfig();
    this.configRevision += 1;
    for (const [token, session] of this.sessions.entries()) {
      const user = this.getUser(session.username);
      if (!user || previousPasswords.get(session.username) !== user.password) {
        this.deleteSession(token);
        continue;
      }
      session.isAdmin = Boolean(user.isAdmin);
    }
  }

  private deleteSession(token: string): void {
    if (!this.sessions.delete(token)) return;
    for (const listener of this.revokedListeners) listener(token);
  }

  onSessionRevoked(listener: (token: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  private migratePlaintextPasswords(): void {
    const needsMigration = this.usersConfig.users.some((user) => !isPasswordHash(user.password)) ||
      this.usersConfig.pendingRegistrations.some((entry) => !isPasswordHash(entry.password));
    if (!needsMigration) return;
    const updated = this.cloneUsersConfig();
    for (const user of updated.users) {
      if (!isPasswordHash(user.password)) user.password = hashPassword(user.password);
    }
    for (const registration of updated.pendingRegistrations) {
      if (!isPasswordHash(registration.password)) registration.password = hashPassword(registration.password);
    }
    this.writeConfig(updated);
    this.usersConfig = updated;
    this.loadedConfigFromFile = true;
  }

  private async migratePlaintextPasswordsAsync(): Promise<boolean> {
    if (this.migrationPromise) return this.migrationPromise;
    const work = (async () => {
      const revision = this.configRevision;
      const updated = this.cloneUsersConfig();
      let changed = false;
      for (const user of updated.users) {
        if (isPasswordHash(user.password)) continue;
        user.password = await hashPasswordAsync(user.password);
        changed = true;
      }
      for (const registration of updated.pendingRegistrations) {
        if (isPasswordHash(registration.password)) continue;
        registration.password = await hashPasswordAsync(registration.password);
        changed = true;
      }
      if (revision !== this.configRevision) return false;
      if (changed) {
        this.writeConfig(updated);
        this.usersConfig = updated;
        this.loadedConfigFromFile = true;
      }
      return true;
    })();
    this.migrationPromise = work;
    try {
      return await work;
    } finally {
      if (this.migrationPromise === work) this.migrationPromise = null;
    }
  }

  private createSession(
    username: string,
    workspaceDir: string,
    isAdmin: boolean,
    isolated = false
  ): SessionSummary {
    const resolvedWorkspace = path.resolve(workspaceDir);
    if (!isolated && !this.isAllowedPath(resolvedWorkspace)) {
      throw new Error("Workspace is not within allowed roots");
    }
    fs.mkdirSync(resolvedWorkspace, { recursive: true });
    const canonicalWorkspace = isolated
      ? (() => {
          try {
            return fs.statSync(resolvedWorkspace).isDirectory()
              ? fs.realpathSync.native(resolvedWorkspace)
              : null;
          } catch {
            return null;
          }
        })()
      : this.resolveSelectableWorkspace(resolvedWorkspace);
    if (!canonicalWorkspace) {
      throw new Error(isolated
        ? "Workspace is not an accessible directory"
        : "Workspace is not an accessible directory within allowed roots");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const createdAt = Date.now();
    const singletons = createSessionSingletonsForManager(canonicalWorkspace);
    const session: UserSession = {
      token,
      username,
      workspaceDir: canonicalWorkspace,
      workspaceRoot: canonicalWorkspace,
      isAdmin,
      isolated,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: createdAt + DESKTOP_SESSION_ABSOLUTE_MS,
      ...singletons,
    };
    this.sessions.set(token, session);
    return {
      token,
      username,
      workspaceDir: canonicalWorkspace,
      workspaceRoot: canonicalWorkspace,
      isAdmin,
      isolated,
      expiresAt: session.expiresAt,
    };
  }

  createIsolatedSession(parentToken: string, workspaceDir: string): SessionSummary {
    const parent = this.getSession(parentToken);
    if (!parent) throw new Error("Parent session not found");
    if (parent.isolated) throw new Error("Nested isolated sessions are not supported");
    const resolved = path.resolve(workspaceDir);
    const managedMarker = `${path.sep}.crownforge-worktrees${path.sep}`;
    if (!resolved.includes(managedMarker)) {
      throw new Error("Isolated sessions require a managed worktree");
    }
    return this.createSession(parent.username, resolved, parent.isAdmin, true);
  }

  login(
    username: string,
    password: string
  ): SessionSummary | null {
    const user = this.getUser(username);
    if (!user || !verifyPassword(password, user.password)) return null;
    try {
      this.migratePlaintextPasswords();
    } catch {
      // A successful login must not leave legacy plaintext credentials on disk.
      return null;
    }
    return this.openUserSession(this.getUser(username) || user);
  }

  async loginAsync(username: string, password: string): Promise<SessionSummary | null> {
    const original = this.getUser(username);
    const originalPassword = original?.password;
    if (!await verifyPasswordAsync(password, originalPassword)) return null;
    if (!original || typeof originalPassword !== "string") return null;
    const afterVerification = this.getUser(username);
    if (!afterVerification) return null;
    if (afterVerification.password !== originalPassword) {
      if (!await verifyPasswordAsync(password, afterVerification.password)) return null;
      if (this.getUser(username)?.password !== afterVerification.password) return null;
    }
    try {
      if (!await this.migratePlaintextPasswordsAsync()) return null;
    } catch {
      return null;
    }
    const current = this.getUser(username);
    if (!current) return null;
    if (current.password !== originalPassword) {
      if (isPasswordHash(originalPassword) || !await verifyPasswordAsync(password, current.password)) return null;
      if (this.getUser(username)?.password !== current.password) return null;
    }
    return this.openUserSession(current);
  }

  private openUserSession(user: UserConfig): SessionSummary | null {
    const defaultWorkspace = path.resolve(user.defaultWorkspace);
    const fallbackWorkspace = path.resolve(config.defaultWorkspaceDir);
    const workspaceDir =
      process.env.CREWFORGE_DESKTOP === "1" && !this.resolveSelectableWorkspace(defaultWorkspace)
        ? fallbackWorkspace
        : defaultWorkspace;
    try {
      return this.createSession(
        user.username,
        workspaceDir,
        Boolean(user.isAdmin)
      );
    } catch {
      if (process.env.CREWFORGE_DESKTOP === "1" && path.resolve(workspaceDir) !== fallbackWorkspace) {
        try {
          return this.createSession(user.username, fallbackWorkspace, Boolean(user.isAdmin));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  getOrCreateDesktopLocalSession(): SessionSummary | null {
    if (process.env.CREWFORGE_DESKTOP !== "1") return null;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.username === "admin" && !session.isolated) {
        if (session.expiresAt && now >= session.expiresAt) continue;
        session.lastSeenAt = now;
        return {
          token: session.token,
          username: session.username,
          workspaceDir: session.workspaceDir,
          workspaceRoot: session.workspaceRoot,
          isAdmin: session.isAdmin,
          isolated: session.isolated,
          expiresAt: session.expiresAt,
        };
      }
    }
    const adminUser = this.usersConfig.users.find((u) => u.isAdmin) || this.usersConfig.users[0];
    if (adminUser) {
      return this.openUserSession(adminUser);
    }
    return null;
  }

  getSession(token: string | null | undefined, options: { touch?: boolean } = {}): UserSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    const now = Date.now();
    if ((session.expiresAt !== undefined && now >= session.expiresAt) ||
        (session.lastSeenAt !== undefined && now - session.lastSeenAt >= DESKTOP_SESSION_IDLE_MS) ||
        !this.getUser(session.username)) {
      this.deleteSession(token);
      return null;
    }
    if (options.touch !== false) session.lastSeenAt = now;
    return session;
  }

  logout(token: string): void {
    this.deleteSession(token);
  }

  listUsers(): SafeUserConfig[] {
    return this.usersConfig.users
      .slice()
      .sort((left, right) => left.username.localeCompare(right.username))
      .map((user) => this.toSafeUser(user));
  }

  listPendingRegistrations(): SafeRegistrationRequest[] {
    return this.usersConfig.pendingRegistrations
      .slice()
      .sort((left, right) => left.requestedAt - right.requestedAt)
      .map(({ username, requestedAt }) => ({ username, requestedAt }));
  }

  private validateRegistration(username: string, password: string): string {
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      throw new Error("Username and password are required");
    }
    if (!this.isValidUsername(normalizedUsername)) {
      throw new Error(
        "Username must start with a letter or number and contain only letters, numbers, dots, underscores, hyphens, or @"
      );
    }
    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }
    if (
      this.getUser(normalizedUsername) ||
      this.usersConfig.pendingRegistrations.some(
        (registration) => registration.username === normalizedUsername
      )
    ) {
      throw new Error("Username is already registered or pending approval");
    }
    return normalizedUsername;
  }

  private persistRegistration(normalizedUsername: string, passwordHash: string): SafeRegistrationRequest {
    const registration: RegistrationRequest = {
      username: normalizedUsername,
      password: passwordHash,
      requestedAt: Date.now(),
    };
    this.usersConfig.pendingRegistrations.push(registration);
    this.saveConfig();
    return {
      username: registration.username,
      requestedAt: registration.requestedAt,
    };
  }

  requestRegistration(username: string, password: string): SafeRegistrationRequest {
    const normalizedUsername = this.validateRegistration(username, password);
    return this.persistRegistration(normalizedUsername, hashPassword(password));
  }

  async requestRegistrationAsync(username: string, password: string): Promise<SafeRegistrationRequest> {
    this.validateRegistration(username, password);
    const passwordHash = await hashPasswordAsync(password);
    // Another request may have claimed the name while the KDF ran.
    const normalizedUsername = this.validateRegistration(username, password);
    return this.persistRegistration(normalizedUsername, passwordHash);
  }

  approveRegistration(username: string, defaultWorkspace?: string): SafeUserConfig {
    const normalizedUsername = username.trim();
    const registration = this.usersConfig.pendingRegistrations.find(
      (entry) => entry.username === normalizedUsername
    );
    if (!registration) {
      throw new Error("Registration request not found");
    }
    if (this.getUser(normalizedUsername)) {
      throw new Error("User already exists");
    }

    const fallbackRoot = this.usersConfig.allowedRoots[0];
    const workspaceDir = path.resolve(
      defaultWorkspace?.trim() || path.join(fallbackRoot, normalizedUsername)
    );
    if (!this.isAllowedPath(workspaceDir)) {
      throw new Error("Default workspace is not within allowed roots");
    }

    const user: UserConfig = {
      username: normalizedUsername,
      password: isPasswordHash(registration.password) ? registration.password : hashPassword(registration.password),
      defaultWorkspace: workspaceDir,
      isAdmin: false,
    };
    this.usersConfig.users.push(user);
    this.usersConfig.pendingRegistrations = this.usersConfig.pendingRegistrations.filter(
      (entry) => entry.username !== normalizedUsername
    );
    this.saveConfig();
    return this.toSafeUser(user);
  }

  rejectRegistration(username: string): void {
    const normalizedUsername = username.trim();
    const before = this.usersConfig.pendingRegistrations.length;
    this.usersConfig.pendingRegistrations = this.usersConfig.pendingRegistrations.filter(
      (entry) => entry.username !== normalizedUsername
    );
    if (this.usersConfig.pendingRegistrations.length === before) {
      throw new Error("Registration request not found");
    }
    this.saveConfig();
  }

  getAllowedRoots(): string[] {
    return [...this.usersConfig.allowedRoots];
  }

  createUser(input: {
    username: string;
    password: string;
    defaultWorkspace: string;
    isAdmin?: boolean;
  }): SafeUserConfig {
    const normalized = this.normalizeUser(input);
    if (!normalized) {
      throw new Error("Username and password are required");
    }
    if (input.password.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }
    if (this.getUser(normalized.username)) {
      throw new Error("User already exists");
    }
    if (
      this.usersConfig.pendingRegistrations.some(
        (registration) => registration.username === normalized.username
      )
    ) {
      throw new Error("Username has a pending registration request");
    }
    if (!this.isAllowedPath(normalized.defaultWorkspace)) {
      throw new Error("Default workspace is not within allowed roots");
    }
    normalized.password = hashPassword(normalized.password);
    this.usersConfig.users.push(normalized);
    this.saveConfig();
    return this.toSafeUser(normalized);
  }

  updateUserPassword(username: string, password: string): SafeUserConfig {
    if (!this.getUser(username)) {
      throw new Error("User not found");
    }
    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }
    const updated = this.cloneUsersConfig();
    const user = updated.users.find((entry) => entry.username === username)!;
    user.password = hashPassword(password);
    this.writeConfig(updated);
    this.usersConfig = updated;
    this.loadedConfigFromFile = true;
    for (const [token, session] of this.sessions.entries()) {
      if (session.username === username) this.deleteSession(token);
    }
    return this.toSafeUser(user);
  }

  deleteUser(username: string, currentUsername: string): void {
    const user = this.getUser(username);
    if (!user) {
      throw new Error("User not found");
    }
    if (username === currentUsername) {
      throw new Error("You cannot delete the current logged-in user");
    }
    const adminCount = this.usersConfig.users.filter((entry) => entry.isAdmin).length;
    if (user.isAdmin && adminCount <= 1) {
      throw new Error("At least one admin user must remain");
    }
    this.usersConfig.users = this.usersConfig.users.filter(
      (entry) => entry.username !== username
    );
    this.saveConfig();
    this.syncSessionsForUser(username);
  }

  isAllowedPath(dir: string): boolean {
    const resolved = path.resolve(dir);
    return this.usersConfig.allowedRoots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
    });
  }

  isSelectableWorkspace(dir: string): boolean {
    return this.resolveSelectableWorkspace(dir) !== null;
  }

  private resolveSelectableWorkspace(dir: string): string | null {
    try {
      const resolved = path.resolve(dir);
      if (!fs.statSync(resolved).isDirectory()) return null;
      const canonical = fs.realpathSync.native(resolved);
      const withinCanonicalRoot = this.usersConfig.allowedRoots.some((root) => {
        let canonicalRoot = path.resolve(root);
        try {
          canonicalRoot = fs.realpathSync.native(canonicalRoot);
        } catch {
          // A non-existent root cannot contain an existing selectable directory.
          return false;
        }
        return isSameOrDescendantPath(canonical, canonicalRoot);
      });
      return withinCanonicalRoot ? canonical : null;
    } catch {
      return null;
    }
  }

  changeWorkspace(token: string, newDir: string): { workspaceDir: string } | null {
    const session = this.getSession(token);
    if (!session) return null;
    if (session.isolated) return null;

    const resolved = this.resolveSelectableWorkspace(newDir);
    if (!resolved) return null;

    session.workspaceDir = resolved;
    const singletons = createSessionSingletonsForManager(resolved);
    session.taskManager = singletons.taskManager;
    session.messageBus = singletons.messageBus;
    session.teammateManager = singletons.teammateManager;
    setActiveTeamId(session, null);

    return { workspaceDir: resolved };
  }

  changeWorkspaceWithinUserRoot(
    token: string,
    newDir: string
  ): { workspaceDir: string } | null {
    const session = this.getSession(token);
    if (!session || session.isolated) return null;

    const resolved = this.resolveSelectableWorkspaceWithinRoot(
      newDir,
      session.workspaceRoot
    );
    if (!resolved) return null;

    session.workspaceDir = resolved;
    const singletons = createSessionSingletonsForManager(resolved);
    session.taskManager = singletons.taskManager;
    session.messageBus = singletons.messageBus;
    session.teammateManager = singletons.teammateManager;
    setActiveTeamId(session, null);

    return { workspaceDir: resolved };
  }

  changeWorkspaceFromTrustedDesktopPicker(
    token: string,
    newDir: string
  ): { workspaceDir: string; workspaceRoot: string } | null {
    const session = this.getSession(token);
    if (!session || session.isolated || process.env.CREWFORGE_DESKTOP !== "1") return null;

    let canonicalWorkspace: string;
    try {
      const resolved = path.resolve(newDir);
      if (!fs.statSync(resolved).isDirectory()) return null;
      canonicalWorkspace = fs.realpathSync.native(resolved);
    } catch {
      return null;
    }

    const singletons = createSessionSingletonsForManager(canonicalWorkspace);

    const nextConfig = this.cloneUsersConfig();
    const user = nextConfig.users.find((entry) => entry.username === session.username);
    if (!user) return null;
    user.defaultWorkspace = canonicalWorkspace;

    const hasAllowedRoot = nextConfig.allowedRoots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return isSamePath(resolvedRoot, canonicalWorkspace);
    });
    if (!hasAllowedRoot) {
      nextConfig.allowedRoots.push(canonicalWorkspace);
    }

    this.writeConfig(nextConfig);
    this.usersConfig = nextConfig;

    session.workspaceDir = canonicalWorkspace;
    session.workspaceRoot = canonicalWorkspace;
    session.taskManager = singletons.taskManager;
    session.messageBus = singletons.messageBus;
    session.teammateManager = singletons.teammateManager;
    setActiveTeamId(session, null);

    return { workspaceDir: canonicalWorkspace, workspaceRoot: canonicalWorkspace };
  }

  listUserWorkspaceDirectories(
    token: string,
    dir?: string
  ): {
    path: string;
    rootPath: string;
    entries: { name: string; path: string }[];
  } | null {
    const session = this.getSession(token);
    if (!session) return null;

    const requestedPath = dir?.trim() || session.workspaceDir || session.workspaceRoot;
    let selectableDirectory: string | null = null;
    let effectiveRootPath = session.workspaceRoot;

    if (session.isAdmin) {
      selectableDirectory = this.resolveSelectableWorkspace(requestedPath);
      if (selectableDirectory) {
        const matchedRoot = this.usersConfig.allowedRoots.find((root) => {
          try {
            const canonicalRoot = fs.realpathSync.native(path.resolve(root));
            return isSameOrDescendantPath(selectableDirectory!, canonicalRoot);
          } catch {
            return false;
          }
        });
        if (matchedRoot) {
          try {
            effectiveRootPath = fs.realpathSync.native(path.resolve(matchedRoot));
          } catch {
            effectiveRootPath = path.resolve(matchedRoot);
          }
        }
      }
    } else {
      selectableDirectory = this.resolveSelectableWorkspaceWithinRoot(
        requestedPath,
        session.workspaceRoot
      );
      effectiveRootPath = session.workspaceRoot;
    }

    if (!selectableDirectory) return null;

    try {
      const entries = fs.readdirSync(selectableDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((left, right) =>
          left.name.toLowerCase().localeCompare(right.name.toLowerCase())
        )
        .map((entry) => ({
          name: entry.name,
          path: path.join(selectableDirectory, entry.name),
        }));
      return {
        path: selectableDirectory,
        rootPath: effectiveRootPath,
        entries,
      };
    } catch {
      return null;
    }
  }

  private resolveSelectableWorkspaceWithinRoot(
    dir: string,
    workspaceRoot: string
  ): string | null {
    const selectable = this.resolveSelectableWorkspace(dir);
    if (!selectable) return null;

    const canonicalRoot = path.resolve(workspaceRoot);
    return isSameOrDescendantPath(selectable, canonicalRoot)
      ? selectable
      : null;
  }

  listDirectories(dir: string): { name: string; path: string }[] {
    const resolved = path.resolve(dir);

    // If path is within an allowed root, list its subdirectories normally
    const selectableDirectory = this.resolveSelectableWorkspace(resolved);
    if (selectableDirectory) {
      try {
        const entries = fs.readdirSync(selectableDirectory, { withFileTypes: true });
        return entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
          .map((e) => ({ name: e.name, path: path.join(selectableDirectory, e.name) }));
      } catch {
        return [];
      }
    }

    // If path is an ancestor of an allowed root, show children that lead to allowed roots
    const children = new Map<string, string>();
    for (const root of this.usersConfig.allowedRoots) {
      const resolvedRoot = path.resolve(root);
      const relative = path.relative(resolved, resolvedRoot);
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        const firstPart = relative.split(path.sep)[0];
        children.set(firstPart, path.join(resolved, firstPart));
      }
    }

    return Array.from(children.entries())
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([name, fullPath]) => ({ name, path: fullPath }));
  }
}

export let sessionManager = new SessionManager();

export function setSessionManagerForTests(manager: SessionManager): void {
  sessionManager = manager;
}
