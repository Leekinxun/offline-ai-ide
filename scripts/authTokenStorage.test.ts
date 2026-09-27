import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_TOKEN_KEY, ISOLATED_AUTH_TOKEN_KEY, fetchCurrentAuthSession, persistVerifiedAuthToken } from "../frontend/src/hooks/authSession.js";

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
