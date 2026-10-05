import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalModeClient, parseApprovalModeSnapshot, type ApprovalModeScope, type ApprovalModeSnapshot } from "../src/hooks/approvalModeClient.ts";

const scope: ApprovalModeScope = { token: "synthetic-session", workspaceDir: "/synthetic/work space", conversationId: "task-a" };
const snapshot = (overrides: Partial<ApprovalModeSnapshot> = {}): ApprovalModeSnapshot => ({ mode: "ask", workspaceDir: scope.workspaceDir, conversationId: "task-a", revision: 0, canEnable: true, ...overrides });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("default mode is unknown until a scoped authenticated server read confirms ask", async () => {
  const reads: { url: string; options: RequestInit }[] = [];
  const client = new ApprovalModeClient(scope, async (url, options) => {
    reads.push({ url: String(url), options: options! }); return response(snapshot());
  });
  assert.equal(client.getSnapshot().snapshot, null);
  assert.equal(client.getSnapshot().verified, false);
  assert.equal(await client.setMode("full_access", true), false);
  assert.equal(await client.refresh(), true);
  assert.deepEqual(client.getSnapshot().snapshot, snapshot());
  assert.equal(reads.length, 1);
  assert.equal(reads[0].url, "/api/chat/conversations/task-a/approval-mode");
  assert.deepEqual(reads[0].options.headers, { Authorization: "Bearer synthetic-session", "Content-Type": "application/json", "X-Workspace-Dir": "%2Fsynthetic%2Fwork%20space" });
  assert.equal(reads[0].options.cache, "no-store");
  assert.equal(reads[0].options.method, undefined);
});

test("default browser fetch is called with the Window receiver", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async function (this: unknown) {
    calls++;
    assert.equal(this, globalThis);
    return response(snapshot());
  }) as typeof fetch;
  try {
    const client = new ApprovalModeClient(scope);
    assert.equal(await client.refresh(), true);
    assert.equal(client.getSnapshot().verified, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit risk acknowledgement enables access; closing uses a confirmed revision and no extra acknowledgement", async () => {
  let server = snapshot();
  const writes: unknown[] = [];
  const client = new ApprovalModeClient(scope, async (_url, options) => {
    if (options?.method === "PUT") {
      const body = JSON.parse(String(options.body)); writes.push(body);
      assert.equal(body.expectedRevision, server.revision);
      server = snapshot({ mode: body.mode, revision: server.revision + 1 });
    }
    return response(server);
  });
  await client.refresh();
  assert.equal(await client.setMode("full_access"), false);
  assert.equal(writes.length, 0);
  assert.equal(await client.setMode("full_access", true), true);
  assert.equal(client.getSnapshot().snapshot?.mode, "full_access");
  assert.equal(await client.setMode("ask"), true);
  assert.equal(client.getSnapshot().snapshot?.mode, "ask");
  assert.deepEqual(writes, [{ mode: "full_access", expectedRevision: 0, acknowledgeRisk: true }, { mode: "ask", expectedRevision: 1 }]);
});

test("read-only or desktop sessions cannot enable and new tasks never send requests", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return response(snapshot({ canEnable: false })); };
  const readOnly = new ApprovalModeClient(scope, request);
  await readOnly.refresh();
  assert.equal(await readOnly.setMode("full_access", true), false);
  for (const missing of [{ conversationId: null }, { token: "" }, { workspaceDir: "" }]) {
    const unavailable = new ApprovalModeClient({ ...scope, ...missing }, request);
    assert.equal(await unavailable.refresh(), false);
    assert.equal(await unavailable.setMode("full_access", true), false);
    assert.equal(unavailable.getSnapshot().verified, false);
  }
  assert.equal(calls, 1);
});

test("refresh restores server mode and observes another tab's revocation and backend restart", async () => {
  let server = snapshot({ mode: "full_access", revision: 3 });
  const client = new ApprovalModeClient(scope, async () => response(server));
  await client.refresh();
  assert.equal(client.getSnapshot().snapshot?.mode, "full_access");
  server = snapshot({ revision: 4 }); await client.refresh();
  assert.equal(client.getSnapshot().snapshot?.mode, "ask");
  server = snapshot({ revision: 0 }); await client.refresh();
  assert.equal(client.getSnapshot().snapshot?.revision, 0);
});

test("in-flight disable retains the full-access warning and blocks concurrent writes until acknowledged", async () => {
  const write = deferred<Response>(); let writes = 0;
  const client = new ApprovalModeClient(scope, async (_url, options) => {
    if (options?.method === "PUT") { writes++; return write.promise; }
    return response(snapshot({ mode: "full_access", revision: 2 }));
  });
  await client.refresh();
  const closing = client.setMode("ask");
  assert.equal(client.getSnapshot().snapshot?.mode, "full_access");
  assert.equal(client.getSnapshot().busy, true);
  assert.equal(await client.setMode("ask"), false);
  assert.equal(await client.refresh(), false);
  assert.equal(writes, 1);
  write.resolve(response(snapshot({ revision: 3 })));
  assert.equal(await closing, true);
  assert.equal(client.getSnapshot().snapshot?.mode, "ask");
  assert.equal(client.getSnapshot().busy, false);
});

test("stale reads never override an acknowledged mutation", async () => {
  const oldRead = deferred<Response>(); let reads = 0;
  const client = new ApprovalModeClient(scope, async (_url, options) => {
    if (options?.method === "PUT") return response(snapshot({ mode: "full_access", revision: 1 }));
    return ++reads === 1 ? response(snapshot()) : oldRead.promise;
  });
  await client.refresh();
  const outdated = client.refresh();
  assert.equal(await client.setMode("full_access", true), true);
  oldRead.resolve(response(snapshot()));
  assert.equal(await outdated, false);
  assert.equal(client.getSnapshot().snapshot?.mode, "full_access");
});

test("disposed task, workspace and login scopes discard late responses and abort their requests", async () => {
  for (const nextScope of [{ ...scope, conversationId: "task-b" }, { ...scope, workspaceDir: "/another/workspace" }, { ...scope, token: "another-session" }]) {
    const oldRead = deferred<Response>(); let signal: AbortSignal | null | undefined;
    const old = new ApprovalModeClient(scope, async (_url, options) => { signal = options?.signal; return oldRead.promise; });
    const reading = old.refresh(); old.dispose();
    const next = new ApprovalModeClient(nextScope, async () => response(snapshot({ conversationId: nextScope.conversationId!, workspaceDir: nextScope.workspaceDir })));
    assert.equal(next.getSnapshot().snapshot, null);
    await next.refresh(); oldRead.resolve(response(snapshot({ mode: "full_access" })));
    assert.equal(await reading, false);
    assert.equal(signal?.aborted, true);
    assert.equal(old.getSnapshot().snapshot, null);
    assert.equal(next.getSnapshot().snapshot?.mode, "ask");
  }
});

test("a conflict re-reads authoritative mode without replaying the risk acknowledgement", async () => {
  let calls = 0; let writes = 0;
  const client = new ApprovalModeClient(scope, async (_url, options) => {
    calls++;
    if (options?.method === "PUT") { writes++; return response({ error: "conflict" }, 409); }
    return response(snapshot({ mode: calls === 1 ? "ask" : "full_access", revision: calls === 1 ? 0 : 1 }));
  });
  await client.refresh();
  assert.equal(await client.setMode("full_access", true), false);
  assert.equal(client.getSnapshot().snapshot?.mode, "full_access");
  assert.equal(client.getSnapshot().verified, true);
  assert.equal(client.getSnapshot().error, "conflict");
  assert.equal(client.getSnapshot().busy, false);
  assert.equal(writes, 1);
});

test("failed disable never claims ask, including when its follow-up read fails", async () => {
  for (const readFails of [false, true]) {
    let reads = 0;
    const client = new ApprovalModeClient(scope, async (_url, options) => {
      if (options?.method === "PUT") throw new Error("lost response");
      if (++reads > 1 && readFails) throw new Error("offline");
      return response(snapshot({ mode: "full_access", revision: 1 }));
    });
    await client.refresh();
    assert.equal(await client.setMode("ask"), false);
    assert.equal(client.getSnapshot().snapshot?.mode, "full_access");
    assert.equal(client.getSnapshot().verified, !readFails);
    assert.equal(client.getSnapshot().error, "update");
    assert.equal(client.getSnapshot().busy, false);
  }
});

test("a lost enable response is reconciled by GET without claiming success or repeating PUT", async () => {
  let server = snapshot(); let writes = 0;
  const client = new ApprovalModeClient(scope, async (_url, options) => {
    if (options?.method === "PUT") { server = snapshot({ mode: "full_access", revision: 1 }); writes++; throw new Error("lost response"); }
    return response(server);
  });
  await client.refresh();
  assert.equal(await client.setMode("full_access", true), false);
  assert.equal(client.getSnapshot().snapshot?.mode, "full_access");
  assert.equal(client.getSnapshot().verified, true);
  assert.equal(writes, 1);
});

test("malformed or other-scope responses cannot enable access", async () => {
  for (const body of [null, {}, snapshot({ mode: "bogus" as "ask" }), snapshot({ conversationId: "another-task" }), snapshot({ workspaceDir: "/another/workspace" }), snapshot({ revision: -1 }), snapshot({ revision: 0.5 }), snapshot({ canEnable: "true" as unknown as boolean })]) {
    assert.throws(() => parseApprovalModeSnapshot(body, scope));
    const client = new ApprovalModeClient(scope, async () => response(body));
    assert.equal(await client.refresh(), false);
    assert.equal(client.getSnapshot().verified, false);
    assert.equal(await client.setMode("full_access", true), false);
  }
});
