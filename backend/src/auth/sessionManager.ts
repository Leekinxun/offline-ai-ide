import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TaskManager } from "../agent/taskManager.js";
import { MessageBus } from "../agent/messageBus.js";
import { TeammateManager } from "../agent/teammateManager.js";
import { config } from "../config.js";
import { setActiveTeamId } from "../team/sessionBridge.js";

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
}

export interface SessionSummary {
  token: string;
  username: string;
  workspaceDir: string;
  workspaceRoot: string;
  isAdmin: boolean;
  isolated: boolean;
}

function createSessionSingletons(workspaceDir: string) {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const teammateManager = new TeammateManager(workspaceDir, messageBus, taskManager);
  return { taskManager, messageBus, teammateManager };
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
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
    for (const configPath of this.resolveConfigCandidates()) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        this.configPath = configPath;
        console.log(`Loaded users config from ${configPath}`);
        return this.normalizeConfig(JSON.parse(raw) as Partial<UsersConfig>);
      } catch {
        // try next
      }
    }

    console.warn("users.json not found, using defaults");
    this.configPath = this.resolveDefaultConfigPath();
    return this.normalizeConfig({});
  }

  private saveConfig(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(
      this.configPath,
      `${JSON.stringify(this.usersConfig, null, 2)}\n`,
      "utf-8"
    );
  }

  private getUser(username: string): UserConfig | undefined {
    return this.usersConfig.users.find((user) => user.username === username);
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
        this.sessions.delete(token);
        continue;
      }
      session.isAdmin = Boolean(user.isAdmin);
    }
  }

  reloadConfig(): void {
    this.usersConfig = this.loadConfig();
    for (const [token, session] of this.sessions.entries()) {
      const user = this.getUser(session.username);
      if (!user) {
        this.sessions.delete(token);
        continue;
      }
      session.isAdmin = Boolean(user.isAdmin);
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
    const token = crypto.randomUUID();
    const singletons = createSessionSingletons(canonicalWorkspace);
    const session: UserSession = {
      token,
      username,
      workspaceDir: canonicalWorkspace,
      workspaceRoot: canonicalWorkspace,
      isAdmin,
      isolated,
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
    };
  }

  createIsolatedSession(parentToken: string, workspaceDir: string): SessionSummary {
    const parent = this.sessions.get(parentToken);
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
    if (!user || user.password !== password) return null;
    try {
      return this.createSession(
        user.username,
        user.defaultWorkspace,
        Boolean(user.isAdmin)
      );
    } catch {
      return null;
    }
  }

  getSession(token: string | null | undefined): UserSession | null {
    if (!token) return null;
    return this.sessions.get(token) || null;
  }

  logout(token: string): void {
    this.sessions.delete(token);
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

  requestRegistration(username: string, password: string): SafeRegistrationRequest {
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

    const registration: RegistrationRequest = {
      username: normalizedUsername,
      password,
      requestedAt: Date.now(),
    };
    this.usersConfig.pendingRegistrations.push(registration);
    this.saveConfig();
    return {
      username: registration.username,
      requestedAt: registration.requestedAt,
    };
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
      password: registration.password,
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
    this.usersConfig.users.push(normalized);
    this.saveConfig();
    return this.toSafeUser(normalized);
  }

  updateUserPassword(username: string, password: string): SafeUserConfig {
    const user = this.getUser(username);
    if (!user) {
      throw new Error("User not found");
    }
    user.password = password;
    this.saveConfig();
    this.syncSessionsForUser(username);
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
        return canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${path.sep}`);
      });
      return withinCanonicalRoot ? canonical : null;
    } catch {
      return null;
    }
  }

  changeWorkspace(token: string, newDir: string): { workspaceDir: string } | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.isolated) return null;

    const resolved = this.resolveSelectableWorkspace(newDir);
    if (!resolved) return null;

    session.workspaceDir = resolved;
    const singletons = createSessionSingletons(resolved);
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
    const session = this.sessions.get(token);
    if (!session || session.isolated) return null;

    const resolved = this.resolveSelectableWorkspaceWithinRoot(
      newDir,
      session.workspaceRoot
    );
    if (!resolved) return null;

    session.workspaceDir = resolved;
    const singletons = createSessionSingletons(resolved);
    session.taskManager = singletons.taskManager;
    session.messageBus = singletons.messageBus;
    session.teammateManager = singletons.teammateManager;
    setActiveTeamId(session, null);

    return { workspaceDir: resolved };
  }

  listUserWorkspaceDirectories(
    token: string,
    dir?: string
  ): {
    path: string;
    rootPath: string;
    entries: { name: string; path: string }[];
  } | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    const requestedPath = dir?.trim() || session.workspaceRoot;
    const selectableDirectory = this.resolveSelectableWorkspaceWithinRoot(
      requestedPath,
      session.workspaceRoot
    );
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
        rootPath: session.workspaceRoot,
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
    return selectable === canonicalRoot || selectable.startsWith(`${canonicalRoot}${path.sep}`)
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
      const prefix = resolved === "/" ? "/" : resolved + "/";
      if (resolvedRoot.startsWith(prefix) || resolvedRoot === resolved) {
        const relative = path.relative(resolved, resolvedRoot);
        const firstPart = relative.split("/")[0];
        if (firstPart) {
          children.set(firstPart, path.join(resolved, firstPart));
        }
      }
    }

    return Array.from(children.entries())
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([name, fullPath]) => ({ name, path: fullPath }));
  }
}

export const sessionManager = new SessionManager();
