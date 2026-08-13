import { Router, type Request } from "express";
import type { UserSession } from "../auth/sessionManager.js";
import { getMigrationStatus, isMigrationRollbackFormatId, migrateWorkspacePersistence, rollbackLastMigration } from "../persistence/migrations.js";
import { getAppSettingsMigrationStatus, migrateAppSettingsFile, config } from "../config.js";

export const migrationsRouter = Router();
function session(req: Request): UserSession {
  const value = (req as Request & { userSession?: UserSession }).userSession;
  if (!value) throw new Error("Authenticated session required"); return value;
}

migrationsRouter.get("/", (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json({ ...getMigrationStatus(session(req).workspaceDir), appSettings: getAppSettingsMigrationStatus() }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

migrationsRouter.post("/run", (req, res) => {
  try {
    const actor = session(req); if (!actor.isAdmin) return void res.status(403).json({ error: "Admin access required" });
    const result = migrateWorkspacePersistence(actor.workspaceDir); const blocked = result.failed.length > 0 || result.skipped.some((entry) => entry.blocking); res.status(blocked ? 409 : 200).json({ result, status: getMigrationStatus(actor.workspaceDir) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

migrationsRouter.post("/rollback", (req, res) => {
  try {
    const actor = session(req); if (!actor.isAdmin) return void res.status(403).json({ error: "Admin access required" });
    const formatId = typeof req.body?.formatId === "string" ? req.body.formatId.trim() : "";
    if (!formatId || !isMigrationRollbackFormatId(formatId)) return void res.status(400).json({ error: "A canonical migratable formatId is required" });
    res.json({ rollback: rollbackLastMigration(actor.workspaceDir, formatId), status: getMigrationStatus(actor.workspaceDir) });
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

migrationsRouter.post("/app-settings/run", (req, res) => {
  try {
    const actor = session(req); if (!actor.isAdmin) return void res.status(403).json({ error: "Admin access required" });
    const status = migrateAppSettingsFile(config.appSettingsPath);
    res.status(status.state === "failed" ? 409 : 200).json({ status });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
