import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { UserSession } from "../auth/sessionManager.js";
import type { PersistedChatMessage } from "../chat/history.js";
import type { OpenAIMessage, WsServerMessage } from "./types.js";

let runAgentLoop: typeof import("./loop.js").runAgentLoop;
let MessageBus: typeof import("./messageBus.js").MessageBus;
let TaskManager: typeof import("./taskManager.js").TaskManager;
let TeammateManager: typeof import("./teammateManager.js").TeammateManager;
let AgentRunRecorder: typeof import("../chat/runHistory.js").AgentRunRecorder;
let mutations: typeof import("../files/mutationRegistry.js");
let completion: typeof import("../chat/completionEvidence.js");
let runChanges: typeof import("../chat/runChanges.js");
let configRoot: string;
const originalEnvironment = new Map<string, string | undefined>();
const checkCommand = "python3 -B -m unittest discover";
const label = "O'Reilly 中文验收 – 合成事件";

test.before(async () => {
  configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-nul-loop-config-"));
  const workspace = path.join(configRoot, "workspace");
  fs.mkdirSync(workspace);
  const overrides = {
    APP_SETTINGS_CONFIG: path.join(configRoot, "app-settings.json"),
    USERS_CONFIG: path.join(configRoot, "users.json"),
    WORKSPACE_DIR: workspace,
    TEAM_STORE_ROOT: path.join(configRoot, "teams"),
    CREWFORGE_DESKTOP: "0",
  };
  fs.writeFileSync(overrides.APP_SETTINGS_CONFIG, "{}\n");
  fs.writeFileSync(overrides.USERS_CONFIG, JSON.stringify({ allowedRoots: [workspace], users: [] }));
  for (const [key, value] of Object.entries(overrides)) {
    originalEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
  ({ runAgentLoop } = await import("./loop.js"));
  ({ MessageBus } = await import("./messageBus.js"));
  ({ TaskManager } = await import("./taskManager.js"));
  ({ TeammateManager } = await import("./teammateManager.js"));
  ({ AgentRunRecorder } = await import("../chat/runHistory.js"));
  mutations = await import("../files/mutationRegistry.js");
  completion = await import("../chat/completionEvidence.js");
  runChanges = await import("../chat/runChanges.js");
});

test.after(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (configRoot) fs.rmSync(configRoot, { recursive: true, force: true });
});

function fixture(t: test.TestContext) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-nul-loop-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const databaseTests = `import pathlib, sqlite3, unittest
LABEL = ${JSON.stringify(label)}
def rows():
    with sqlite3.connect(pathlib.Path('delivery.sqlite').resolve().as_uri() + '?mode=ro', uri=True) as db:
        return db.execute('select id, label, status from events order by id').fetchall()
class DeliveryTests(unittest.TestCase):
    def test_database_header(self):
        self.assertEqual(pathlib.Path('delivery.sqlite').read_bytes()[:16], b'SQLite format 3\\0')
    def test_real_rows(self):
        self.assertEqual(len(rows()), 5)
    def test_quotes_and_unicode(self):
        self.assertEqual([row[1] for row in rows()], [LABEL] * 5)
    def test_statuses(self):
        self.assertEqual([row[2] for row in rows()], ['open', 'open', 'done', 'done', 'hold'])
`;
  const summaryTests = `import pathlib, unittest
class SummaryTests(unittest.TestCase):
    def test_summary_is_readable_text(self):
        raw = pathlib.Path('summary.md').read_bytes()
        self.assertNotIn(b'\\0', raw)
        self.assertEqual(raw.decode('utf8').encode('utf8'), raw)
    def test_binary_header_is_escaped(self):
        text = pathlib.Path('summary.md').read_text(encoding='utf8')
        self.assertIn('SQLite format 3', text)
        self.assertIn('\\\\x00', text)
`;
  fs.writeFileSync(path.join(workspaceDir, "producer.py"), `import pathlib, sqlite3
label = ${JSON.stringify(label)}
with sqlite3.connect('delivery.sqlite') as db:
    db.execute('create table events (id integer primary key, label text, status text)')
    db.executemany('insert into events values (?, ?, ?)', [(i + 1, label, status) for i, status in enumerate(['open', 'open', 'done', 'done', 'hold'])])
    db.commit()
header = pathlib.Path('delivery.sqlite').read_bytes()[:16].decode('ascii')
pathlib.Path('summary.md').write_text('# Delivery\\nHeader: ' + header + '\\nRows: 5\\n', encoding='utf8')
pathlib.Path('test_delivery.py').write_text(${JSON.stringify(databaseTests)}, encoding='utf8')
print('PRODUCER_FINISHED: SQLite rows and summary generated')
`);
  fs.writeFileSync(path.join(workspaceDir, "repair.py"), `import pathlib
header = pathlib.Path('delivery.sqlite').read_bytes()[:16]
pathlib.Path('summary.md').write_text('# Delivery\\nHeader: ' + repr(header) + '\\nHeader hex: ' + header.hex() + '\\nRows: 5\\n', encoding='utf8')
pathlib.Path('test_summary.py').write_text(${JSON.stringify(summaryTests)}, encoding='utf8')
print('SUMMARY_REGENERATED: binary header represented with repr and hex')
`);
  const taskManager = new TaskManager(workspaceDir);
  const messageBus = new MessageBus(workspaceDir);
  const session: UserSession = {
    token: "nul-recovery-token", username: "nul-recovery-user", workspaceDir, workspaceRoot: workspaceDir,
    isAdmin: false, isolated: false, taskManager, messageBus,
    teammateManager: new TeammateManager(workspaceDir, messageBus, taskManager),
  };
  return { workspaceDir, session };
}

function tool(id: string, name: string, args: Record<string, unknown>): OpenAIMessage {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
const stop = (): OpenAIMessage => ({ role: "assistant", content: "Delivery complete." });
const initialTurns = () => [
  tool("produce", "bash", { command: "python3 -B producer.py" }),
  tool("initial-check", "bash", { command: checkCommand }),
  tool("read-broken-summary", "read_file", { path: "summary.md" }),
  tool("inspect-database", "read_file", { path: "delivery.sqlite" }),
  stop(),
];

async function replay(f: ReturnType<typeof fixture>, turns: OpenAIMessage[]) {
  const priorFetch = globalThis.fetch;
  const bodies: string[] = [];
  const approvals: Array<{ name: string; command?: unknown }> = [];
  const events: WsServerMessage[] = [];
  const persisted: PersistedChatMessage[] = [];
  const recorder = new AgentRunRecorder(f.workspaceDir, "nul-recovery-run", "nul-recovery-conversation", "code", undefined, undefined, undefined, "local-replay-model");
  await recorder.start();
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "local-replay-model", max_output_tokens: 1024 }] });
    bodies.push(String(init?.body || ""));
    const message = turns[bodies.length - 1] || stop();
    return Response.json({ choices: [{ finish_reason: message.tool_calls?.length ? "tool_calls" : "stop", message }] });
  };
  try {
    const result = await runAgentLoop({ readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket,
      "Generate a SQLite database with synthetic quoted Unicode labels and a readable summary, verify the delivery, and repair any unreadable text.",
      "nul-recovery-request", f.session, undefined, undefined, (event) => events.push(event), undefined, undefined,
      (message) => { persisted.push(structuredClone(message)); }, {
        mode: "code", modelName: "local-replay-model", conversationId: recorder.conversationId,
        isStopped: () => false, createAbortSignal: () => undefined, runRecorder: recorder,
        requestToolApproval: async (request) => {
          approvals.push({ name: request.name, command: request.input.command });
          return "allow_once";
        },
      });
    return { result, bodies, approvals, events, persisted, recorder };
  } finally { globalThis.fetch = priorFetch; }
}

test("real SQLite delivery repairs NUL text through approval, rereads it, verifies fresh versions, and supports binary review", async (t) => {
  const f = fixture(t);
  const run = await replay(f, [...initialTurns(),
    tool("repair-summary", "bash", { command: "python3 -B repair.py" }),
    tool("read-repaired-summary", "read_file", { path: "summary.md" }),
    tool("full-check", "bash", { command: checkCommand }), stop(),
  ]);
  const tools = run.result.flatMap((message) => message.toolCalls || []);
  assert.equal(tools.find((item) => item.toolCallId === "produce")?.isError, false, tools.find((item) => item.toolCallId === "produce")?.result);
  const broken = tools.find((item) => item.toolCallId === "read-broken-summary");
  assert.equal(broken?.isError, true);
  assert.match(broken?.result || "", /^Error:.*NUL.*normal approved command.*repr or hex/);
  assert.equal((broken?.result || "").includes("\0"), false);
  assert.ok((broken?.result || "").length < 600);
  const feedback = run.recorder.snapshot().events.find((event) => event.kind === "tool_result" && event.toolName === "runtime_validation" && event.isError);
  assert.ok(feedback, "Nominal passing database checks cannot complete an unreadable text artifact");
  const feedbackText = (JSON.parse(run.bodies[5]).messages as OpenAIMessage[])
    .map((message) => message.content)
    .find((content) => typeof content === "string" && content.startsWith("Runtime validation feedback"));
  assert.equal(typeof feedbackText, "string");
  assert.match(feedbackText as string, /Runtime validation feedback.*NUL/s);
  assert.match(feedbackText as string, /"status":"passed"/);
  const inspected = tools.find((item) => item.toolCallId === "inspect-database");
  assert.equal(inspected?.isError, false);
  const metadata = JSON.parse(inspected!.result!);
  const bytes = fs.readFileSync(path.join(f.workspaceDir, "delivery.sqlite"));
  assert.equal(metadata.content_kind, "binary");
  assert.equal(metadata.format, "sqlite");
  assert.equal(metadata.read_only, true);
  assert.equal(metadata.inspection_only, true);
  assert.equal(metadata.size_bytes, bytes.length);
  assert.equal(metadata.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  for (const field of ["content", "preview", "header", "version", "complete"]) assert.equal(field in metadata, false);
  const reread = tools.find((item) => item.toolCallId === "read-repaired-summary");
  assert.equal(reread?.isError, false);
  assert.match(JSON.parse(reread!.result!).content, /\\x00/);
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, "summary.md")).includes(0), false);
  assert.deepEqual(run.approvals.filter((item) => item.name === "bash").map((item) => item.command), [
    "python3 -B producer.py", checkCommand, "python3 -B repair.py", checkCommand,
  ]);
  assert.match(tools.find((item) => item.toolCallId === "initial-check")?.result || "", /Ran 4 tests/);
  assert.match(tools.find((item) => item.toolCallId === "full-check")?.result || "", /Ran 6 tests/);
  const validation = run.result.at(-1)?.runtimeValidation;
  assert.equal(validation?.status, "passed", JSON.stringify(validation));
  assert.equal(validation?.repairAttempts, 1);
  assert.equal(validation?.verification[0].toolCallId, "full-check");
  assert.equal(run.persisted.at(-1)?.runtimeValidation?.status, "passed");
  const authoritative = completion.collectAuthoritativeChangeEvidence(f.workspaceDir, run.recorder.runId);
  assert.deepEqual(authoritative.mutationEvidenceGaps, []);
  assert.deepEqual(mutations.listMutationEvidenceGaps(f.workspaceDir), []);
  const evidence = completion.deriveCompletionEvidence({ messages: run.result, changedFiles: authoritative.changedFiles });
  assert.equal(evidence.outcome, "completed", JSON.stringify(evidence));
  const records = mutations.listFileMutations(f.workspaceDir, { runId: run.recorder.runId });
  const database = records.find((record) => record.path === "delivery.sqlite");
  assert.ok(database?.postimageBinary);
  assert.deepEqual(mutations.readMutationBytes(f.workspaceDir, database, "postimage"), bytes);
  const review = runChanges.readRunChanges(f.workspaceDir, run.recorder.runId, "delivery.sqlite");
  const binaryReview = review.files.find((file) => file.path === "delivery.sqlite");
  assert.equal(binaryReview?.isBinary, true);
  assert.equal(binaryReview?.modifiedHash, metadata.sha256);
  assert.equal(binaryReview?.modifiedSize, bytes.length);
  assert.equal(binaryReview?.modified, undefined);
  assert.equal(binaryReview?.reviewState, "pending");
  const kept = runChanges.keepAllRunChanges(f.workspaceDir, run.recorder.runId, review.revision);
  assert.ok(kept.kept.includes(database.id));
  assert.equal(kept.files.find((file) => file.path === "delivery.sqlite")?.reviewState, "kept");
  assert.ok(mutations.listFileMutations(f.workspaceDir, { path: "delivery.sqlite" })[0].keptAt);
  assert.deepEqual(fs.readFileSync(path.join(f.workspaceDir, "delivery.sqlite")), bytes);
  const query = spawnSync("python3", ["-B", "-c", "import json,pathlib,sqlite3,sys; db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); print(json.dumps(db.execute('select label,status from events order by id').fetchall(),ensure_ascii=False)); db.close()", path.join(f.workspaceDir, "delivery.sqlite")], { encoding: "utf8" });
  assert.equal(query.status, 0, query.stderr);
  assert.deepEqual(JSON.parse(query.stdout), ["open", "open", "done", "done", "hold"].map((status) => [label, status]));
  assert.ok(run.recorder.snapshot().toolExecutions.some((step) => step.toolCallId === "read-broken-summary" && step.status === "failed"));
  assert.ok(run.recorder.snapshot().toolExecutions.some((step) => step.toolCallId === "full-check" && step.status === "completed"));
});

test("unrepaired NUL summary cannot report completed even when full database checks passed", async (t) => {
  const f = fixture(t);
  const run = await replay(f, [...initialTurns(), stop()]);
  const produced = run.result.flatMap((message) => message.toolCalls || []).find((item) => item.toolCallId === "produce");
  assert.equal(produced?.isError, false, produced?.result);
  const validation = run.result.at(-1)?.runtimeValidation;
  assert.equal(validation?.status, "failed", JSON.stringify(validation));
  assert.deepEqual(validation?.artifactErrors, [{ path: "summary.md", reason: "nul_text" }]);
  assert.equal(validation?.verification[0].status, "passed");
  assert.equal(validation?.repairAttempts, 1);
  assert.equal(run.bodies.length, 6, "Unchanged damage receives one bounded repair opportunity");
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, "summary.md")).includes(0), true);
  const authoritative = completion.collectAuthoritativeChangeEvidence(f.workspaceDir, run.recorder.runId);
  assert.deepEqual(authoritative.mutationEvidenceGaps, []);
  assert.equal(completion.deriveCompletionEvidence({ messages: run.result, changedFiles: authoritative.changedFiles }).outcome, "validation_failed");
});
