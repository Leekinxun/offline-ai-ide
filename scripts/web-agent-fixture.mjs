// Local, deterministic browser fixture. No external model or real user data.
// Run: node scripts/web-agent-fixture.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-browser-fixture-")));
const workspace = path.join(fixture, "workspace");
// Freeze the UI under test: unrelated in-flight edits must not trigger HMR and
// reset unsaved buffers in the middle of a browser scenario.
const frontendSnapshot = path.join(fixture, "frontend");
fs.mkdirSync(frontendSnapshot);
for (const name of ["src", "public", "index.html", "package.json", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
  const source = path.join(root, "frontend", name);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(frontendSnapshot, name), { recursive: true });
}
fs.symlinkSync(path.join(root, "frontend/node_modules"), path.join(frontendSnapshot, "node_modules"), "dir");
const snapshotConfigPath = path.join(frontendSnapshot, "vite.config.ts");
fs.writeFileSync(snapshotConfigPath, fs.readFileSync(snapshotConfigPath, "utf8")
  .replace("export default defineConfig({", `export default defineConfig({\n  cacheDir: ${JSON.stringify(path.join(fixture, "vite-cache"))},`)
  .replace("  server: {", `  server: {\n    fs: { allow: ${JSON.stringify([frontendSnapshot, path.join(fixture, "vite-cache"), path.join(root, "frontend/node_modules")])} },`));
const backendPort = Number(process.env.FIXTURE_BACKEND_PORT || 43127);
const frontendPort = Number(process.env.FIXTURE_FRONTEND_PORT || 45173);
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(fixture, "plugins"));
fs.writeFileSync(path.join(workspace, "calculator.ts"), "export function add(a: number, b: number) {\n  return a - b;\n}\n");
fs.writeFileSync(path.join(workspace, "README.md"), "# Browser fixture\n\nSend FIXTURE_EDIT to exercise read, approval, edit and review without a paid model.\n");
const reviewOriginal = "请在当前目录下用 Python 标准库实现一个轻量 Key-Value 引擎。\n\n## Requirements\n\n1.storage.py: 实现 KVStore，支持 set(key, val)、get(key)、delete(key)。\n2.tests/test_storage.py: 编写完整的 unittest，覆盖持久化和恢复。\n\n## Notes\n\nDraft\n";
const reviewModified = "# 技术面试任务说明：轻量 Key-Value 引擎\n\n## Requirements\n\n1. `storage.py`：实现 `KVStore`，支持 `set(key, val)`、`get(key)`、`delete(key)`。\n2. `tests/test_storage.py`：编写完整的 `unittest`，覆盖持久化和恢复。\n\n## Notes\n\nReady\n";
fs.writeFileSync(path.join(workspace, "review-doc.md"), reviewOriginal);
fs.writeFileSync(path.join(workspace, "review-notes.md"), "Notes draft\n");
fs.writeFileSync(path.join(workspace, "review-checklist.md"), "Checklist draft\n");
fs.writeFileSync(path.join(workspace, ".gitignore"), ".history/\n.checkpoints/\n.team/\n.codex/\n.crewforge/\nnode_modules/\n");
fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "disposable-browser-fixture", private: true, scripts: { check: "node verify.cjs", wait: "node wait.cjs" } }));
fs.writeFileSync(path.join(workspace, "verify.cjs"), "const fs = require('node:fs'); require('node:assert/strict').ok(fs.readFileSync('calculator.ts', 'utf8').includes('return a + b;')); console.log('calculator check passed');\n");
fs.writeFileSync(path.join(workspace, "wait.cjs"), "console.log('session ready'); const timer = setInterval(() => console.log('heartbeat'), 1000); process.stdin.on('data', value => { console.log('input: ' + value); if (String(value).trim() === 'exit') { clearInterval(timer); process.exit(0); } });\n");
fs.writeFileSync(path.join(workspace, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Preview fixture</title><style>body{font:16px system-ui;padding:32px;background:#eef4ff}button{padding:12px 20px;margin:8px;border-radius:12px;border:0;background:#2563eb;color:white}</style></head><body><h1>Preview fixture</h1><button id="save" onclick="document.querySelector(\'#status\').textContent=\'Saved\'">Save</button><button id="fail" onclick="throw new Error(\'Fixture preview error\')">Test error</button><p id="status">Ready</p></body></html>');
for (const args of [["init"], ["config", "user.email", "fixture@localhost"], ["config", "user.name", "Browser fixture"], ["add", "."], ["commit", "-m", "Disposable fixture baseline"]]) {
  const result = spawnSync("git", args, { cwd: workspace, stdio: "ignore" });
  if (result.status !== 0) throw new Error("Could not initialize disposable fixture repository");
}
fs.writeFileSync(path.join(fixture, "users.json"), JSON.stringify({ allowedRoots: [workspace], users: [{ username: "fixture", password: "local-fixture-only", defaultWorkspace: workspace, isAdmin: true }], pendingRegistrations: [] }));

const model = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const requested = messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("FIXTURE_EDIT"));
    const toolResults = messages.filter((message) => message.role === "tool");
    const tool = (name, args, id) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const reviewRequested = messages.some((entry) => entry.role === "user" && JSON.stringify(entry.content).includes("FIXTURE_REVIEW"));
    let message = { role: "assistant", content: "Local browser fixture ready." };
    if (reviewRequested) {
      if (!toolResults.some((entry) => entry.tool_call_id === "fixture-review-read")) message = tool("read_file", { path: "review-doc.md" }, "fixture-review-read");
      else if (!toolResults.some((entry) => entry.tool_call_id === "fixture-review-edit")) message = tool("edit_file", { path: "review-doc.md", old_text: reviewOriginal, new_text: reviewModified }, "fixture-review-edit");
      else if (!toolResults.some((entry) => entry.tool_call_id === "fixture-notes-read")) message = tool("read_file", { path: "review-notes.md" }, "fixture-notes-read");
      else if (!toolResults.some((entry) => entry.tool_call_id === "fixture-notes-edit")) message = tool("edit_file", { path: "review-notes.md", old_text: "Notes draft", new_text: "Notes ready" }, "fixture-notes-edit");
      else if (!toolResults.some((entry) => entry.tool_call_id === "fixture-checklist-read")) message = tool("read_file", { path: "review-checklist.md" }, "fixture-checklist-read");
      else if (!toolResults.some((entry) => entry.tool_call_id === "fixture-checklist-edit")) message = tool("edit_file", { path: "review-checklist.md", old_text: "Checklist draft", new_text: "Checklist ready" }, "fixture-checklist-edit");
      else message = { role: "assistant", content: "已完成格式调整，文件 `interview/q1_kv_engine/Technical_Interview_Task_Brief_With_A_Very_Long_Unbroken_Component_" + "long".repeat(24) + ".md` 的改动：\n\n- **添加标题**：使文档结构更清晰。\n- **修复列表语法**：`1.storage.py` → `1. storage.py`。\n- **代码标记**：统一标记类名和方法名。\n\n| 文件 | 状态 |\n| --- | --- |\n| `" + "long_path_".repeat(20) + "` | 已格式化 |\n\n```text\n" + "long_code_".repeat(35) + "\n```\n\n内容已保留。" };
      // Deliberately slow, deterministic SSE makes waiting/reasoning/tool phases
      // observable in the browser without contacting a real model provider.
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      const delta = (value) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 650));
      delta({ reasoning_content: "Fixture reasoning: inspect Markdown structure. " });
      await new Promise((resolve) => setTimeout(resolve, 650));
      delta({ reasoning_content: "Preserve content while adjusting headings and lists." });
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (message.tool_calls) delta({ tool_calls: message.tool_calls.map((entry, index) => ({ ...entry, index })) });
      else {
        for (let offset = 0; offset < message.content.length; offset += 90) {
          delta({ content: message.content.slice(offset, offset + 90) });
          await new Promise((resolve) => setTimeout(resolve, 35));
        }
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\ndata: [DONE]\n\n`);
      res.end();
      return;
    } else if (messages.some((entry) => entry.role === "user" && JSON.stringify(entry.content).includes("Return exactly ONE fenced code block"))) {
      message = { role: "assistant", content: "```typescript\n  return a + b;\n```" };
    } else if (messages.some((entry) => entry.role === "user" && JSON.stringify(entry.content).includes("FIXTURE_QUESTION"))) {
      message = toolResults.some((entry) => entry.tool_call_id === "fixture-question")
        ? { role: "assistant", content: "The fixture received your explicit answer." }
        : tool("ask_user", { questions: [{ prompt: "Which result should this fixture use?", options: ["Keep existing behavior", "Use the new behavior"] }] }, "fixture-question");
    } else if (requested) {
      if (!toolResults.some((entry) => entry.tool_call_id === "fixture-read")) {
        message = tool("read_file", { path: "calculator.ts" }, "fixture-read");
      } else if (!toolResults.some((entry) => entry.tool_call_id === "fixture-edit")) {
        message = tool("edit_file", { path: "calculator.ts", old_text: "return a - b;", new_text: "return a + b;" }, "fixture-edit");
      } else if (!toolResults.some((entry) => entry.tool_call_id === "fixture-check")) {
        message = tool("bash", { command: "npm run check" }, "fixture-check");
      } else {
        const output = String(toolResults.find((entry) => entry.tool_call_id === "fixture-edit")?.content || "");
        message = { role: "assistant", content: output.startsWith("Error:") ? `Fixture edit failed: ${output}` : "Changed calculator.ts. This deterministic fixture does not claim to run model-driven validation." };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "fixture-response", object: "chat.completion", choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  } catch {
    res.writeHead(400); res.end("Invalid fixture request");
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelPort = model.address().port;
fs.writeFileSync(path.join(fixture, "settings.json"), JSON.stringify({ schemaVersion: 1, llm: { modelName: "local-fixture", vllmApiUrl: `http://127.0.0.1:${modelPort}/v1`, vllmApiKey: "" }, mcp: { baseUrls: [], lazyUrls: [], disabledUrls: [], servers: [] }, delivery: { providers: [] } }));
const backend = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: path.join(root, "backend"), stdio: "inherit",
  env: { ...process.env, PORT: String(backendPort), USERS_CONFIG: path.join(fixture, "users.json"), APP_SETTINGS_CONFIG: path.join(fixture, "settings.json"), WORKSPACE_DIR: workspace, TEAM_STORE_ROOT: fixture, PLUGINS_DIR: path.join(fixture, "plugins"), CREWFORGE_DESKTOP: "0", CREWFORGE_FIXTURE_LOOPBACK: "1" },
});
const frontend = spawn(process.execPath, [path.join(root, "frontend/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
  cwd: frontendSnapshot, stdio: "inherit",
  env: { ...process.env, BACKEND_PROXY_URL: `http://127.0.0.1:${backendPort}` },
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${frontendPort}`, workspace, username: "fixture", password: "local-fixture-only", prompt: "FIXTURE_EDIT: fix add in calculator.ts" }));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  backend.kill("SIGTERM"); frontend.kill("SIGTERM"); model.close();
  setTimeout(() => {
    backend.kill("SIGKILL"); frontend.kill("SIGKILL");
    fs.rmSync(fixture, { recursive: true, force: true });
    process.exit(0);
  }, 1500);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
backend.on("exit", () => { if (!stopping) stop(); });
frontend.on("exit", () => { if (!stopping) stop(); });
