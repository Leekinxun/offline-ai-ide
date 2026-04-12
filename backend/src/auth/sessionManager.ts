import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TaskManager } from "../agent/taskManager.js";
import { MessageBus } from "../agent/messageBus.js";
import { TeammateManager } from "../agent/teammateManager.js";

interface UserConfig {
  username: string;
  password: string;
  defaultWorkspace: string;
}

interface UsersConfig {
  allowedRoots: string[];
  users: UserConfig[];
}

export interface UserSession {
  token: string;
  username: string;
  workspaceDir: string;
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

  constructor() {
    this.usersConfig = this.loadConfig();
  }

  private loadConfig(): UsersConfig {
    // Look for users.json: env var → cwd → parent dir (project root when running from backend/)
    const candidates = [
      process.env.USERS_CONFIG,
      path.resolve(process.cwd(), "users.json"),
      path.resolve(process.cwd(), "../users.json"),
    ].filter(Boolean) as string[];

    for (const configPath of candidates) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        console.log(`Loaded users config from ${configPath}`);
        return JSON.parse(raw);
      } catch {
        // try next
      }
    }

    console.warn("users.json not found, using defaults");
    return {
      allowedRoots: ["/workspace"],
      users: [{ username: "admin", password: "admin123", defaultWorkspace: "/workspace" }],
    };
  }

  reloadConfig(): void {
    this.usersConfig = this.loadConfig();
  }

  login(username: string, password: string): { token: string; username: string; workspaceDir: string } | null {
    const user = this.usersConfig.users.find(
      (u) => u.username === username && u.password === password
    );
    if (!user) return null;

    // Check if user already has an active session
    for (const [, session] of this.sessions) {
      if (session.username === username) {
        return { token: session.token, username: session.username, workspaceDir: session.workspaceDir };
      }
    }

    const workspaceDir = path.resolve(user.defaultWorkspace);
    try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch { /* ignore */ }

    const token = crypto.randomUUID();
    const singletons = createSessionSingletons(workspaceDir);
    this.sessions.set(token, { token, username, workspaceDir, ...singletons });
    return { token, username, workspaceDir };
  }

  getSession(token: string | null | undefined): UserSession | null {
    if (!token) return null;
    return this.sessions.get(token) || null;
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  isAllowedPath(dir: string): boolean {
    const resolved = path.resolve(dir);
    return this.usersConfig.allowedRoots.some((root) => resolved.startsWith(path.resolve(root)));
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
