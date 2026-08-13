import fs from "node:fs";
import path from "node:path";
import type { AdminPolicyBundle, PermissionExplanation, PermissionLayer, SandboxGrant, WorkspacePolicyOverride } from "./types.js";
import { explainPermission, layerAllowsPermission } from "./evaluator.js";

const DEFAULT_ADMIN: AdminPolicyBundle = {
  schemaVersion: 1, version: 1,
  permissions: { id: "admin", allow: ["*"], deny: [] },
  sandbox: { readPaths: ["."], writePaths: ["."], networkOrigins: [], secretEnv: [] },
  updatedAt: new Date(0).toISOString(),
};

function normalizePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))).sort();
}

function normalizeLayer(value: unknown, id: string): PermissionLayer {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { id, allow: normalizePatterns(input.allow), deny: normalizePatterns(input.deny), ...(input.signed === false ? { signed: false } : {}) };
}

function normalizeSandbox(value: unknown): SandboxGrant {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { readPaths: normalizePatterns(input.readPaths), writePaths: normalizePatterns(input.writePaths), networkOrigins: normalizePatterns(input.networkOrigins), secretEnv: normalizePatterns(input.secretEnv) };
}

function readJson(filePath: string): unknown {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error("Policy files cannot be symlinks");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

export class ExtensionPolicyStore {
  readonly adminPath: string;
  readonly workspacePath: string;
  constructor(readonly workspaceDir: string, adminPath?: string) {
    this.adminPath = path.resolve(adminPath || process.env.CREWFORGE_ADMIN_POLICY || path.join(process.cwd(), ".crewforge", "admin-policy.json"));
    this.workspacePath = path.join(path.resolve(workspaceDir), ".codex", "policy-override.json");
  }

  private assertWorkspacePathSafe(): void {
    const root = fs.realpathSync.native(path.resolve(this.workspaceDir));
    let cursor = root;
    for (const segment of [".codex", "policy-override.json"]) {
      cursor = path.join(cursor, segment);
      if (!fs.existsSync(cursor)) continue;
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Workspace policy path cannot contain symlinks");
      if (!fs.realpathSync.native(cursor).startsWith(`${root}${path.sep}`)) throw new Error("Workspace policy path escapes workspace");
    }
  }

  getAdminPolicy(): AdminPolicyBundle {
    const raw = readJson(this.adminPath) as Partial<AdminPolicyBundle> | undefined;
    if (!raw) return { ...DEFAULT_ADMIN, permissions: { ...DEFAULT_ADMIN.permissions }, sandbox: { ...DEFAULT_ADMIN.sandbox } };
    return { schemaVersion: 1, version: Number.isInteger(raw.version) && Number(raw.version) > 0 ? Number(raw.version) : 1, permissions: normalizeLayer(raw.permissions, "admin"), sandbox: normalizeSandbox(raw.sandbox), trustedSigningKeys: raw.trustedSigningKeys && typeof raw.trustedSigningKeys === "object" ? raw.trustedSigningKeys : undefined, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString() };
  }

  putAdminPolicy(input: unknown, expectedVersion: number): AdminPolicyBundle {
    const current = this.getAdminPolicy();
    if (current.version !== expectedVersion) throw Object.assign(new Error("Admin policy version conflict"), { code: "VERSION_CONFLICT", currentVersion: current.version });
    const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const next: AdminPolicyBundle = { schemaVersion: 1, version: current.version + 1, permissions: normalizeLayer(raw.permissions, "admin"), sandbox: normalizeSandbox(raw.sandbox), trustedSigningKeys: raw.trustedSigningKeys && typeof raw.trustedSigningKeys === "object" ? raw.trustedSigningKeys as Record<string, string> : current.trustedSigningKeys, updatedAt: new Date().toISOString() };
    atomicWrite(this.adminPath, next); return next;
  }

  getWorkspaceOverride(): WorkspacePolicyOverride {
    this.assertWorkspacePathSafe();
    const admin = this.getAdminPolicy();
    const raw = readJson(this.workspacePath) as Partial<WorkspacePolicyOverride> | undefined;
    if (!raw) return { schemaVersion: 1, version: 0, adminPolicyVersion: admin.version, permissions: { id: "workspace", allow: [...admin.permissions.allow], deny: [] }, sandbox: { ...admin.sandbox }, updatedAt: new Date(0).toISOString() };
    return { schemaVersion: 1, version: Number.isInteger(raw.version) ? Number(raw.version) : 0, adminPolicyVersion: Number.isInteger(raw.adminPolicyVersion) ? Number(raw.adminPolicyVersion) : admin.version, permissions: normalizeLayer(raw.permissions, "workspace"), sandbox: normalizeSandbox(raw.sandbox), updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString() };
  }

  putWorkspaceOverride(input: unknown, expectedVersion: number): WorkspacePolicyOverride {
    const current = this.getWorkspaceOverride();
    if (current.version !== expectedVersion) throw Object.assign(new Error("Workspace policy version conflict"), { code: "VERSION_CONFLICT", currentVersion: current.version });
    const admin = this.getAdminPolicy();
    const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (raw.adminPolicyVersion !== undefined && raw.adminPolicyVersion !== admin.version) throw Object.assign(new Error("Admin policy version conflict"), { code: "VERSION_CONFLICT", currentVersion: admin.version });
    const requested = normalizeLayer(raw.permissions, "workspace");
    const escalation = requested.allow.find((permission) => !layerAllowsPermission(admin.permissions, permission));
    if (escalation) throw new Error(`Workspace override cannot expand admin permission: ${escalation}`);
    const sandbox = normalizeSandbox(raw.sandbox);
    for (const key of ["readPaths", "writePaths", "networkOrigins", "secretEnv"] as const) {
      const unauthorized = (sandbox[key] || []).find((item) => !(admin.sandbox[key] || []).includes(item));
      if (unauthorized) throw new Error(`Workspace override cannot expand admin sandbox grant: ${key}:${unauthorized}`);
    }
    const next: WorkspacePolicyOverride = { schemaVersion: 1, version: current.version + 1, adminPolicyVersion: admin.version, permissions: requested, sandbox, updatedAt: new Date().toISOString() };
    this.assertWorkspacePathSafe(); atomicWrite(this.workspacePath, next); return next;
  }

  explain(permission: string, extensionLayers: PermissionLayer[] = [], sandboxLayers: SandboxGrant[] = []): PermissionExplanation {
    const admin = this.getAdminPolicy(); const workspace = this.getWorkspaceOverride();
    return explainPermission(permission, [admin.permissions, ...extensionLayers, workspace.permissions], [admin.sandbox, ...sandboxLayers, workspace.sandbox]);
  }
}
