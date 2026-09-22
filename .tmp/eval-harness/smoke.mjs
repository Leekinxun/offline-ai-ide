// End-to-end smoke: login -> change workspace -> WS chat (ask mode)
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(REPO_ROOT, "backend", "package.json"));
const WebSocket = require("ws");

const BASE = "http://localhost:3000";
const WS_BASE = "ws://localhost:3000";
const EVAL_ROOT = path.join(REPO_ROOT, "workspace", "eval");

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin123" }),
});
const login = await loginRes.json();
console.log("login keys:", Object.keys(login), "status:", loginRes.status);
const token = login.token || login.sessionToken;
if (!token) { console.error("no token", login); process.exit(1); }

const ch = await fetch(`${BASE}/api/auth/workspace/change`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: EVAL_ROOT }),
});
console.log("workspace change:", ch.status, JSON.stringify(await ch.json()).slice(0, 200));

const ws = new WebSocket(`${WS_BASE}/ws/chat?token=${token}`);
const events = [];
let assistantText = "";
let thinkingLen = 0;
const started = Date.now();

const wsOpen = new Promise((r) => ws.on("open", r));
await wsOpen;
console.log("ws open");

ws.send(JSON.stringify({
  type: "message",
  requestId: "smoke-1",
  mode: "ask",
  message: "用一句话回答：当前工作区目录下有哪些文件或子目录？",
}));

await new Promise((resolve) => {
  const timer = setTimeout(() => resolve("timeout"), 180000);
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg);
    if (msg.type === "token") assistantText += msg.content;
    if (msg.type === "thinking") thinkingLen += msg.content.length;
    if (msg.type === "tool_approval_request") {
      ws.send(JSON.stringify({ type: "tool_approval", approvalId: msg.approvalId, decision: "allow_once" }));
    }
    if (msg.type === "summary") { clearTimeout(timer); resolve("summary"); }
    if (msg.type === "error") console.log("ERROR EVENT:", msg.content);
  });
});

console.log("elapsed_s:", Math.round((Date.now() - started) / 1000));
console.log("event types:", JSON.stringify(events.map((e) => e.type).reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {})));
const finalRun = [...events].reverse().find((e) => e.type === "run_state");
console.log("final run status:", finalRun && finalRun.status, "model:", finalRun && finalRun.modelName);
const summary = events.find((e) => e.type === "summary");
console.log("summary keys:", summary && Object.keys(summary).join(","));
console.log("thinking_chars:", thinkingLen);
console.log("assistant:", assistantText.slice(0, 500));
import { writeFileSync } from "fs";
writeFileSync("/tmp/smoke-events.json", JSON.stringify(events, null, 2));
ws.close();
process.exit(0);
