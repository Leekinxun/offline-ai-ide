import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TaskManager } from "../agent/taskManager.js";
import { MessageBus } from "../agent/messageBus.js";
import { TeammateManager } from "../agent/teammateManager.js";
import { config } from "../config.js";

interface UserConfig {
  username: string;
  password: string;
  defaultWorkspace: string;
  isAdmin?: boolean;
}

interface UsersConfig {
  allowedRoots: string[];
  users: UserConfig[];
}

export interface SafeUserConfig {
  username: string;
  defaultWorkspace: string;
  isAdmin: boolean;
}

export interface UserSession {
  token: string;
  username: string;
  workspaceDir: string;
  isAdmin: boolean;
  taskManager: TaskManager;
  messageBus: MessageBus;
  teammateManager: TeammateManager;
}

function createSessionSingletons(workspaceDir: string) {
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const teammateManager = new TeammateManager(workspaceDir, messageBus, taskManager);
  return { taskManager, messageBus, teammateManager };
}

class SessionManager {
  private sessions = new Map<string, UserSession>();
  private usersConfig: UsersConfig;
  private configPath: string;

  constructor() {
    this.configPath = this.resolveDefaultConfigPath();
    this.usersConfig = this.loadConfig();
  }

  private resolveConfigCandidates(): string[] {
    return [
      process.env.USERS_CONFIG,
      path.resolve(process.cwd(), "users.json"),
      path.resolve(process.cwd(), "../users.json"),
    ].filter(Boolean) as string[];
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

    return { allowedRoots, users };
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

  login(
    username: string,
    password: string
  ): { token: string; username: string; workspaceDir: string; isAdmin: boolean } | null {
    const user = this.getUser(username);
    if (!user || user.password !== password) return null;

    // Check if user already has an active session
    for (const [, session] of this.sessions) {
      if (session.username === username) {
        return {
          token: session.token,
          username: session.username,
          workspaceDir: session.workspaceDir,
          isAdmin: session.isAdmin,
        };
      }
    }

    const workspaceDir = path.resolve(user.defaultWorkspace);
    try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch { /* ignore */ }

    const token = crypto.randomUUID();
    const singletons = createSessionSingletons(workspaceDir);
    this.sessions.set(token, {
      token,
      username,
      workspaceDir,
      isAdmin: Boolean(user.isAdmin),
      ...singletons,
    });
    return { token, username, workspaceDir, isAdmin: Boolean(user.isAdmin) };
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

  changeWorkspace(token: string, newDir: string): { workspaceDir: string } | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    const resolved = path.resolve(newDir);
    if (!this.isAllowedPath(resolved)) return null;

    try { fs.mkdirSync(resolved, { recursive: true }); } catch { /* ignore */ }

    session.workspaceDir = resolved;
    const singletons = createSessionSingletons(resolved);
    session.taskManager = singletons.taskManager;
    session.messageBus = singletons.messageBus;
    session.teammateManager = singletons.teammateManager;

    return { workspaceDir: resolved };
  }

  listDirectories(dir: string): { name: string; path: string }[] {
    const resolved = path.resolve(dir);

    // If path is within an allowed root, list its subdirectories normally
    if (this.isAllowedPath(resolved)) {
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        return entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
          .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }));
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
