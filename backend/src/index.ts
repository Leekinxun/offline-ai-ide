import express from "express";
import { createServer } from "http";
import type { Socket } from "net";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import fs from "fs";
import { config } from "./config.js";
import { filesRouter } from "./routes/files.js";
import { authRouter } from "./routes/auth.js";
import { mobilePairingRouter } from "./routes/mobilePairing.js";
import { mobileDataRouter } from "./routes/mobileData.js";
import { adminRouter } from "./routes/admin.js";
import { chatRouter } from "./routes/chat.js";
import { pluginsRouter } from "./routes/plugins.js";
import { teamRouter } from "./routes/team.js";
import { checkpointsRouter } from "./routes/checkpoints.js";
import { diagnosticsRouter } from "./routes/diagnostics.js";
import { runRouter } from "./routes/run.js";
import { debugRouter } from "./routes/debug.js";
import { gitDeliveryRouter } from "./routes/gitDelivery.js";
import { deliveryRouter, deliveryWebhookRouter } from "./routes/delivery.js";
import { extensionsPolicyRouter } from "./routes/extensionsPolicy.js";
import { modelGovernanceRouter } from "./routes/modelGovernance.js";
import { migrationsRouter } from "./routes/migrations.js";
import { authMiddleware } from "./auth/middleware.js";
import { getWsSession } from "./auth/middleware.js";
import { handleChatWs } from "./ws/chat.js";
import { handleTerminalWs } from "./ws/terminal.js";
import { handleTeamWs } from "./ws/team.js";
import { handleMobileWs } from "./ws/mobile.js";
import { getMobileSessionFromUpgrade } from "./mobile/pairing.js";
import { stopRunsForSession } from "./chat/runCoordinator.js";
import { sessionManager, type UserSession } from "./auth/sessionManager.js";
import { canWriteActiveWorkspace, getTeamManager, resolveActiveTeam } from "./team/sessionBridge.js";
import { reloadExternalPlugins } from "./plugins/registry.js";

const app = express();
app.disable("x-powered-by");
reloadExternalPlugins();
// The Web and desktop frontends use same-origin API requests. Cross-origin
// credentials are deliberately unavailable to external sites.
// Signed webhook verification requires the exact bytes received from the provider.
app.use("/api/delivery/webhooks", deliveryWebhookRouter);
app.use(express.json({ limit: "10mb" }));

// Auth routes (no middleware — login/logout must be public)
app.use("/api/auth", authRouter);
app.use("/api/mobile/pairing", mobilePairingRouter);
app.use("/api/mobile/data", mobileDataRouter);
app.use("/api/plugins", pluginsRouter);

// Protected API routes
app.use("/api/files", authMiddleware, filesRouter);
app.use("/api/admin", authMiddleware, adminRouter);
app.use("/api/chat", authMiddleware, chatRouter);
app.use("/api/team", authMiddleware, teamRouter);
app.use("/api/checkpoints", authMiddleware, checkpointsRouter);
app.use("/api/diagnostics", authMiddleware, diagnosticsRouter);
app.use("/api/run", authMiddleware, runRouter);
app.use("/api/debug", authMiddleware, debugRouter);
app.use("/api/git-delivery", authMiddleware, gitDeliveryRouter);
app.use("/api/delivery", authMiddleware, deliveryRouter);
app.use("/api/extension-policy", authMiddleware, extensionsPolicyRouter);
app.use("/api/model-governance", authMiddleware, modelGovernanceRouter);
app.use("/api/migrations", authMiddleware, migrationsRouter);
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Static frontend files
function resolveStaticDirectory(dir: string): string {
  const configured = path.resolve(dir);
  if (fs.existsSync(path.join(configured, "index.html"))) {
    return configured;
  }
  const relativeFrontendDist = path.resolve(process.cwd(), "../frontend/dist");
  if (fs.existsSync(path.join(relativeFrontendDist, "index.html"))) {
    return relativeFrontendDist;
  }
  const projectFrontendDist = path.resolve(process.cwd(), "frontend/dist");
  if (fs.existsSync(path.join(projectFrontendDist, "index.html"))) {
    return projectFrontendDist;
  }
  return configured;
}

const staticPath = resolveStaticDirectory(config.staticDir);
app.use("/mobile", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(staticPath));
app.get("*", (_req, res) => {
  const indexPath = path.join(staticPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send("CrownForge 静态前端未就绪，请先执行 cd frontend && npm run build");
  }
});

// HTTP + WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const connections = new Set<Socket>();
const desktopSockets = new Map<string, Set<WebSocket>>();

sessionManager.onSessionRevoked((token) => {
  stopRunsForSession(token);
  for (const ws of desktopSockets.get(token) || []) {
    try { ws.close(1008, "Session ended"); } catch { ws.terminate(); }
  }
  desktopSockets.delete(token);
});

server.on("connection", (socket) => {
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
});

server.on("upgrade", (request, socket, head) => {
  const url = request.url || "";
  if (!url.startsWith("/ws/")) {
    socket.destroy();
    return;
  }

  if (new URL(url, "http://localhost").pathname === "/ws/mobile") {
    const mobile = getMobileSessionFromUpgrade(request);
    if (!mobile) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleMobileWs(ws, request, mobile));
    return;
  }

  const session = getWsSession(request);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, session);
  });
});

wss.on("connection", (ws: WebSocket, req: any, session: UserSession) => {
  const url = req.url || "";
  const sockets = desktopSockets.get(session.token) || new Set<WebSocket>();
  sockets.add(ws);
  desktopSockets.set(session.token, sockets);
  const originalWorkspace = session.workspaceDir;
  const originalTeamId = resolveActiveTeam(session)?.id || null;
  const validate = setInterval(() => {
    if (sessionManager.getSession(session.token, { touch: false }) !== session || session.workspaceDir !== originalWorkspace) {
      ws.close(1008, "Session or workspace changed");
      return;
    }
    if (originalTeamId) {
      try {
        const team = getTeamManager(session).getTeamDetails(originalTeamId, session.username);
        if (team.workspaceDir !== originalWorkspace) { ws.close(1008, "Team access changed"); return; }
      } catch { ws.close(1008, "Team access changed"); return; }
    }
    if (url.startsWith("/ws/terminal") && !canWriteActiveWorkspace(session)) ws.close(1008, "Terminal permission changed");
  }, 15_000);
  validate.unref?.();
  ws.on("close", () => {
    clearInterval(validate);
    sockets.delete(ws);
    if (sockets.size === 0) desktopSockets.delete(session.token);
  });
  if (url.startsWith("/ws/chat")) {
    handleChatWs(ws, session);
  } else if (url.startsWith("/ws/terminal")) {
    handleTerminalWs(ws, session);
  } else if (url.startsWith("/ws/team")) {
    handleTeamWs(ws, session);
  } else {
    ws.close();
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  const code = ["EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EMFILE", "ENFILE"].includes(error.code || "")
    ? error.code
    : "STARTUP_FAILED";
  console.error(`CrewForge backend failed to listen (${code})`);
  if (process.send) {
    try {
      process.send({ type: "error", phase: "listen", code }, () => process.exit(1));
      return;
    } catch { /* The host already disconnected. */ }
  }
  process.exit(1);
});

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "shutdown") return;
  wss.clients.forEach((client) => client.terminate());
  server.close(() => process.exit(0));
  connections.forEach((socket) => socket.destroy());
});

server.listen(config.port, config.host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    console.error("CrewForge backend failed to resolve its listening address");
    process.send?.({ type: "error", phase: "listen", code: "NO_LISTEN_ADDRESS" });
    server.close(() => process.exit(1));
    return;
  }
  const displayHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const url = `http://${displayHost}:${address.port}`;
  console.log(`CrewForge running at ${url} (listening on ${config.host}:${address.port})`);
  process.send?.({ type: "ready", url });
});
