import { Router, type Request, type Response } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { ExtensionPolicyStore } from "../extensions/policy/store.js";
import { getActiveTeamRole } from "../team/sessionBridge.js";
import { listExternalPlugins, reloadExternalPlugins, resolveRegisteredPluginPolicy } from "../plugins/registry.js";

export const extensionsPolicyRouter = Router();

function session(req: Request): UserSession {
  const value = (req as Request & { userSession?: UserSession }).userSession;
  if (!value) throw new Error("Authenticated session required");
  return value;
}

function store(req: Request): ExtensionPolicyStore { return new ExtensionPolicyStore(session(req).workspaceDir); }

function expectedVersion(req: Request): number {
  const raw = req.header("if-match")?.replace(/^W\//, "").replace(/\"/g, "") ?? req.body?.expectedVersion;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error("A valid expectedVersion or If-Match header is required");
  return value;
}

function errorResponse(res: Response, error: unknown): void {
  const value = error as Error & { code?: string; currentVersion?: number };
  res.status(value.code === "VERSION_CONFLICT" ? 409 : 400).json({ error: value.message, ...(value.currentVersion !== undefined ? { currentVersion: value.currentVersion } : {}) });
}

extensionsPolicyRouter.get("/", (req, res) => {
  try { const policy = store(req); res.setHeader("Cache-Control", "no-store"); res.json({ admin: policy.getAdminPolicy(), workspace: policy.getWorkspaceOverride(), plugins: listExternalPlugins() }); }
  catch (error) { errorResponse(res, error); }
});

extensionsPolicyRouter.put("/admin", (req, res) => {
  try {
    if (!session(req).isAdmin) return void res.status(403).json({ error: "Admin access required" });
    const admin = store(req).putAdminPolicy(req.body, expectedVersion(req));
    reloadExternalPlugins();
    res.json({ admin });
  } catch (error) { errorResponse(res, error); }
});

extensionsPolicyRouter.put("/workspace", (req, res) => {
  try {
    const actor = session(req); const role = getActiveTeamRole(actor);
    if (!actor.isAdmin && role !== null && role !== "owner" && role !== "admin") return void res.status(403).json({ error: "Workspace policy updates require the solo workspace owner, team owner, or admin" });
    res.json({ workspace: store(req).putWorkspaceOverride(req.body, expectedVersion(req)) });
  }
  catch (error) { errorResponse(res, error); }
});

extensionsPolicyRouter.post("/explain", (req, res) => {
  try {
    if (typeof req.body?.permission !== "string" || !req.body.permission.trim()) throw new Error("permission is required");
    const bindingRequested = [req.body.pluginId, req.body.profileId, req.body.hookId].some((value) => value !== undefined) || req.body.skillIds !== undefined;
    const binding = bindingRequested && typeof req.body.pluginId === "string" ? resolveRegisteredPluginPolicy({
      pluginId: req.body.pluginId.trim(),
      ...(typeof req.body.profileId === "string" ? { profileId: req.body.profileId.trim() } : {}),
      ...(Array.isArray(req.body.skillIds) ? { skillIds: req.body.skillIds.filter((value: unknown): value is string => typeof value === "string") } : {}),
      ...(typeof req.body.hookId === "string" ? { hookId: req.body.hookId.trim() } : {}),
    }) : bindingRequested ? null : { layers: [], sandbox: [] };
    if (!binding) return void res.status(404).json({ error: "Signed server-side plugin/profile/skill/hook binding not found" });
    res.json({
      explanation: store(req).explain(req.body.permission.trim(), binding.layers, binding.sandbox),
      binding: { pluginId: req.body.pluginId, profileId: req.body.profileId, skillIds: req.body.skillIds || [], hookId: req.body.hookId },
    });
  } catch (error) { errorResponse(res, error); }
});
