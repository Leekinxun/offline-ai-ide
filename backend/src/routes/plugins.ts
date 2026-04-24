import { Router } from "express";
import path from "path";
import {
  listExternalPlugins,
  resolveExternalPluginAsset,
} from "../plugins/registry.js";
import { config, getPluginOverrides } from "../config.js";

export const pluginsRouter = Router();

pluginsRouter.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    plugins: listExternalPlugins(),
    pluginsDir: config.pluginsDir,
    overrides: getPluginOverrides(),
  });
});

pluginsRouter.get("/assets/:pluginId/*", (req, res) => {
  const params = req.params as Record<string, string | undefined>;
  const pluginId = params.pluginId || "";
  const assetPath = params["0"] || "";
  const fullPath = resolveExternalPluginAsset(pluginId, assetPath);

  if (!fullPath) {
    return res.status(404).json({ detail: "Plugin asset not found" });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(path.resolve(fullPath));
});
