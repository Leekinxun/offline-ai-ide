import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_TOKEN_KEY, ISOLATED_AUTH_TOKEN_KEY, fetchCurrentAuthSession, persistVerifiedAuthToken, createWindowAuthSession, persistWindowWorkspace, WINDOW_WORKSPACE_KEY } from "../frontend/src/hooks/authSession.js";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("isolated session verification preserves the main window token", () => {
  const local = storage({ [AUTH_TOKEN_KEY]: "main" });
  const session = storage({ [ISOLATED_AUTH_TOKEN_KEY]: "isolated" });
  persistVerifiedAuthToken("isolated-renewed", "isolated", true, local, session);
  assert.equal(local.getItem(AUTH_TOKEN_KEY), "main");
  assert.equal(session.getItem(ISOLATED_AUTH_TOKEN_KEY), "isolated-renewed");
});

test("desktop main authentication persists its returned token", () => {
  const local = storage();
  const session = storage();
  persistVerifiedAuthToken("desktop", null, false, local, session);
  assert.equal(local.getItem(AUTH_TOKEN_KEY), "desktop");
  assert.equal(session.getItem(ISOLATED_AUTH_TOKEN_KEY), null);
});

test("a stale main token retries without credentials for server-controlled desktop authentication", async () => {
  const headers: Headers[] = [];
  const fetcher = (async (_url, init) => {
    headers.push(new Headers(init?.headers));
    return headers.length === 1 ? Response.json({ error: "Unauthorized" }, { status: 401 }) : Response.json({ username: "desktop", token: "new", isolated: false });
  }) as typeof fetch;
  const result = await fetchCurrentAuthSession("expired", false, fetcher);
  assert.equal(result.token, "new");
  assert.equal(headers[0].get("Authorization"), "Bearer expired");
  assert.equal(headers[1].get("Authorization"), null);
});

test("an expired isolated token never retries as the desktop administrator", async () => {
  let requests = 0;
  const fetcher = (async () => { requests++; return Response.json({ error: "Unauthorized" }, { status: 401 }); }) as typeof fetch;
  await assert.rejects(fetchCurrentAuthSession("expired-isolated", true, fetcher), /Invalid token/);
  assert.equal(requests, 1);
});

test("web authentication remains rejected when anonymous retry is unauthorized", async () => {
  const fetcher = (async () => Response.json({ error: "Unauthorized" }, { status: 401 })) as typeof fetch;
  await assert.rejects(fetchCurrentAuthSession("expired", false, fetcher), /Invalid token/);
});


test("new documents and copied tabs derive fresh API tokens without replacing the login token", async () => {
  const local = storage({ [AUTH_TOKEN_KEY]: "login" });
  const original = storage();
  persistWindowWorkspace("alice", "/workspace/nested", original);
  const copied = storage({ [WINDOW_WORKSPACE_KEY]: original.getItem(WINDOW_WORKSPACE_KEY)! });
  const parent = { username: "alice", token: "login", workspaceDir: "/workspace", isAdmin: false, isolated: false, desktop: false };
  let calls = 0;
  const fetcher = (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer login");
    assert.deepEqual(JSON.parse(String(init?.body)), { path: "/workspace/nested" });
    return Response.json({ ...parent, workspaceDir: "/workspace/nested", token: `window-${++calls}` });
  }) as typeof fetch;
  const a = await createWindowAuthSession(parent, "login", original, fetcher);
  const b = await createWindowAuthSession(parent, "login", copied, fetcher);
  const refreshed = await createWindowAuthSession(parent, "login", original, fetcher);
  assert.equal(new Set([a.token, b.token, refreshed.token]).size, 3);
  assert.equal(local.getItem(AUTH_TOKEN_KEY), "login");
  assert.doesNotMatch(original.getItem(WINDOW_WORKSPACE_KEY)!, /window-/);
});

test("invalid or another user's directory hints do not gain workspace access", async () => {
  const parent = { username: "alice", token: "login", workspaceDir: "/workspace", isAdmin: false, isolated: false, desktop: false };
  const session = storage();
  persistWindowWorkspace("alice", "/deleted", session);
  const bodies: unknown[] = [];
  const fetcher = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? Response.json({}, { status: 403 }) : Response.json({ ...parent, token: "window" });
  }) as typeof fetch;
  await createWindowAuthSession(parent, "login", session, fetcher);
  assert.deepEqual(bodies, [{ path: "/deleted" }, {}]);
  persistWindowWorkspace("bob", "/other-user", session);
  await createWindowAuthSession(parent, "login", session, (async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {});
    return Response.json({ ...parent, token: "another-window" });
  }) as typeof fetch);
});

test("isolated worktree authentication never requests an unlocked window session", async () => {
  const parent = { username: "alice", token: "isolated", workspaceDir: "/worktree", isAdmin: false, isolated: true, desktop: false };
  const result = await createWindowAuthSession(parent, "isolated", storage(), (async () => { throw new Error("must not derive"); }) as typeof fetch);
  assert.equal(result, parent);
});
