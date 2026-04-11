import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import { config } from "./config.js";
import { filesRouter } from "./routes/files.js";
import { handleChatWs } from "./ws/chat.js";
import { handleTerminalWs } from "./ws/terminal.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// API routes
app.use("/api/files", filesRouter);
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
  if (url.startsWith("/ws/")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket, req) => {
  const url = req.url || "";
  if (url.startsWith("/ws/chat")) {
    handleChatWs(ws);
  } else if (url.startsWith("/ws/terminal")) {
    handleTerminalWs(ws);
  } else {
    ws.close();
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`AI IDE running at http://localhost:${config.port}`);
});
