import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import { config } from "./config.js";
import { filesRouter } from "./routes/files.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { chatRouter } from "./routes/chat.js";
import { pluginsRouter } from "./routes/plugins.js";
import { authMiddleware } from "./auth/middleware.js";
import { getWsSession } from "./auth/middleware.js";
import { handleChatWs } from "./ws/chat.js";
import { handleTerminalWs } from "./ws/terminal.js";
import { UserSession } from "./auth/sessionManager.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Auth routes (no middleware — login/logout must be public)
app.use("/api/auth", authRouter);
app.use("/api/plugins", pluginsRouter);

// Protected API routes
app.use("/api/files", authMiddleware, filesRouter);
app.use("/api/admin", authMiddleware, adminRouter);
app.use("/api/chat", authMiddleware, chatRouter);
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Static frontend files
const staticPath = path.resolve(config.staticDir);
app.use(express.static(staticPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticPath, "index.html"));
});

// HTTP + WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = request.url || "";
  if (!url.startsWith("/ws/")) {
    socket.destroy();
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
  if (url.startsWith("/ws/chat")) {
    handleChatWs(ws, session);
  } else if (url.startsWith("/ws/terminal")) {
    handleTerminalWs(ws, session);
  } else {
    ws.close();
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`AI IDE running at http://localhost:${config.port}`);
});
