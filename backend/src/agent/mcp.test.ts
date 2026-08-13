import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient, McpToolSelection } from "./mcp.js";

test("discovers and calls tools through an MCP JSON-RPC endpoint", async () => {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { method: string; params?: { name?: string } };

    response.setHeader("Content-Type", "application/json");
    response.setHeader("mcp-session-id", "test-session");

    if (payload.method === "initialize") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
      return;
    }
    if (payload.method === "tools/list") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [
              {
                name: "lookup_weather",
                description: "Look up weather",
                inputSchema: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            ],
          },
        })
      );
      return;
    }
    if (payload.method === "tools/call" && payload.params?.name === "lookup_weather") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: "sunny" }] },
        })
      );
      return;
    }
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { message: "unknown method" } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  try {
    let lazyMode = false;
    const client = new McpClient(() => ({
      baseUrls: [endpoint],
      lazyUrls: lazyMode ? [endpoint] : [],
      disabledUrls: [],
      timeout: 5,
      connectTimeout: 1,
    }));
    const discovery = await client.discoverTools(true);
    assert.equal(discovery.servers[0].ok, true);
    assert.equal(discovery.tools.length, 1);
    const scopedToolName = discovery.tools[0].function.name;
    assert.match(scopedToolName, /^mcp_.*__lookup_weather$/);
    assert.equal(await client.callTool(scopedToolName, { city: "Shanghai" }), "sunny");

    lazyMode = true;
    const selection = new McpToolSelection();
    const hidden = await client.discoverTools(true, selection);
    assert.equal(hidden.tools.length, 0);
    assert.equal(hidden.hasLazyEndpoints, true);
    const candidates = JSON.parse(await client.searchLazyTools("weather")) as Array<{ endpointKey: string; toolName: string }>;
    assert.equal(candidates[0].toolName, "lookup_weather");
    await client.activateLazyTools(selection, candidates[0].endpointKey, [candidates[0].toolName]);
    const activated = await client.discoverTools(true, selection);
    assert.equal(activated.tools.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("signed-hook MCP binding requires configured server, exposed tool, origin, and secret grant", async (t) => {
  const secret = "hook-mcp-secret-value"; process.env.HOOK_MCP_TOKEN = secret;
  let calls = 0; let authorization = ""; let received: unknown;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { id: number; method: string; params?: unknown };
    authorization = String(request.headers.authorization || "");
    response.setHeader("content-type", "application/json");
    if (payload.method === "initialize") response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { capabilities: {} } }));
    else if (payload.method === "tools/list") response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "quality", inputSchema: { type: "object" } }] } }));
    else { calls += 1; received = payload.params; response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: `ok:${secret}` }] } })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  const client = new McpClient(() => ({ baseUrls: [], lazyUrls: [], disabledUrls: [], timeout: 2, connectTimeout: 2, servers: [{ id: "quality-server", transport: "remote", url: `${origin}/mcp`, oauthTokenEnv: "HOOK_MCP_TOKEN" }] }));
  t.after(async () => { client.dispose(); delete process.env.HOOK_MCP_TOKEN; await new Promise<void>((resolve) => server.close(() => resolve())); });

  await assert.rejects(client.callConfiguredTool("unknown", "quality", {}, { networkOrigins: [origin], secretEnv: ["HOOK_MCP_TOKEN"] }), /not configured/);
  await assert.rejects(client.callConfiguredTool("quality-server", "unknown", {}, { networkOrigins: [origin], secretEnv: ["HOOK_MCP_TOKEN"] }), /not exposed/);
  await assert.rejects(client.callConfiguredTool("quality-server", "quality", {}, { networkOrigins: [origin], secretEnv: [] }), /secret environment variable is not granted/);
  assert.equal(calls, 0);
  const output = await client.callConfiguredTool("quality-server", "quality", { revision: 2 }, { networkOrigins: [origin], secretEnv: ["HOOK_MCP_TOKEN"] });
  assert.equal(calls, 1); assert.equal(authorization, `Bearer ${secret}`); assert.deepEqual((received as any).arguments, { revision: 2 });
  assert.doesNotMatch(output, new RegExp(secret)); assert.match(output, /\[REDACTED\]/);
});

test("keeps built-in agent operation possible when an MCP endpoint is unavailable", async () => {
  const client = new McpClient(() => ({
    baseUrls: ["http://127.0.0.1:1/mcp"],
    lazyUrls: [],
    disabledUrls: [],
    timeout: 1,
    connectTimeout: 1,
  }));
  const discovery = await client.discoverTools(true);
  assert.equal(discovery.tools.length, 0);
  assert.equal(discovery.servers[0].ok, false);
});

test("reports disabled MCP servers without connecting or exposing tools", async () => {
  const endpoint = "http://127.0.0.1:1/mcp";
  const client = new McpClient(() => ({
    baseUrls: [endpoint],
    lazyUrls: [],
    disabledUrls: [endpoint],
    timeout: 1,
    connectTimeout: 1,
  }));
  const discovery = await client.discoverTools(true);
  assert.equal(discovery.tools.length, 0);
  assert.equal(discovery.servers.length, 1);
  assert.equal(discovery.servers[0].disabled, true);
  assert.equal(discovery.servers[0].endpoint, endpoint);
});

test("retries transient MCP discovery failures and reports endpoint health", async () => {
  let initializeAttempts = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { method: string };
    response.setHeader("Content-Type", "application/json");

    if (payload.method === "initialize" && initializeAttempts++ < 2) {
      response.statusCode = 503;
      response.end("temporarily unavailable");
      return;
    }
    if (payload.method === "initialize") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
      return;
    }
    if (payload.method === "tools/list") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
      return;
    }
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { message: "unknown method" } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  try {
    const client = new McpClient(() => ({
      baseUrls: [endpoint],
      lazyUrls: [],
      disabledUrls: [],
      timeout: 1,
      connectTimeout: 1,
    }));
    const discovery = await client.discoverTools(true);
    assert.equal(discovery.servers[0].ok, true);
    assert.equal(initializeAttempts, 3);
    assert.equal(discovery.servers[0].attempts, 4);
    assert.equal(typeof discovery.servers[0].lastCheckedAt, "number");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("adds configured remote headers and an OAuth bearer token from the environment", async () => {
  const seenHeaders: Array<{ custom?: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { id: number; method: string };
    seenHeaders.push({
      custom: request.headers["x-tenant"] as string | undefined,
      authorization: request.headers.authorization,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: payload.id,
      result: payload.method === "tools/list" ? { tools: [] } : { capabilities: {} },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const tokenVariable = "CROWNFORGE_TEST_MCP_TOKEN";
  process.env[tokenVariable] = "test-oauth-token";
  const client = new McpClient(() => ({
    baseUrls: [],
    lazyUrls: [],
    disabledUrls: [],
    servers: [{
      id: "remote-test",
      transport: "remote",
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { "X-Tenant": "crewforge" },
      oauthTokenEnv: tokenVariable,
    }],
    timeout: 2,
    connectTimeout: 2,
  }));
  try {
    const discovery = await client.discoverTools(true);
    assert.equal(discovery.servers[0].ok, true);
    assert(seenHeaders.length >= 2);
    assert(seenHeaders.every((headers) => headers.custom === "crewforge"));
    assert(seenHeaders.every((headers) => headers.authorization === "Bearer test-oauth-token"));
  } finally {
    client.dispose();
    delete process.env[tokenVariable];
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("never reflects an OAuth environment token in MCP errors", async () => {
  const tokenVariable = "CROWNFORGE_TEST_MCP_REFLECTION_TOKEN";
  const token = "opaque-token-value-not-for-model";
  process.env[tokenVariable] = token;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `upstream echoed ${token}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const client = new McpClient(() => ({
    baseUrls: [], lazyUrls: [], disabledUrls: [], timeout: 1, connectTimeout: 1,
    servers: [{ id: "token-reflection", transport: "remote", url: `http://127.0.0.1:${address.port}/mcp`, oauthTokenEnv: tokenVariable }],
  }));
  try {
    const discovery = await client.discoverTools(true);
    assert.equal(discovery.servers[0].ok, false);
    assert.doesNotMatch(discovery.servers[0].error || "", new RegExp(token));
    assert.match(discovery.servers[0].error || "", /\[REDACTED\]/);
  } finally {
    client.dispose();
    delete process.env[tokenVariable];
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects malformed, userinfo, wildcard, and unspecified remote MCP endpoints without connecting", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  const client = new McpClient(() => ({
    baseUrls: [], lazyUrls: [], disabledUrls: [], timeout: 1, connectTimeout: 1,
    servers: [
      { id: "userinfo", transport: "remote", url: `http://ignored@127.0.0.1:${port}/mcp` },
      { id: "empty-userinfo", transport: "remote", url: `http://@127.0.0.1:${port}/mcp` },
      { id: "wildcard", transport: "remote", url: "http://*.example.test/mcp" },
      { id: "unspecified", transport: "remote", url: `http://0.0.0.0:${port}/mcp` },
    ],
  }));
  try {
    const discovery = await client.discoverTools(true);
    assert.equal(discovery.tools.length, 0);
    assert(discovery.servers.every((server) => server.ok === false));
    assert.equal(requests, 0);
  } finally {
    client.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("does not follow MCP redirects to a different destination", async () => {
  let redirectedRequests = 0;
  const redirected = createServer((_request, response) => {
    redirectedRequests += 1;
    response.end("should not be reached");
  });
  await new Promise<void>((resolve) => redirected.listen(0, "127.0.0.1", resolve));
  const redirectAddress = redirected.address();
  assert(redirectAddress && typeof redirectAddress === "object");
  const source = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("Location", `http://127.0.0.1:${redirectAddress.port}/mcp`);
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourceAddress = source.address();
  assert(sourceAddress && typeof sourceAddress === "object");
  const client = new McpClient(() => ({
    baseUrls: [`http://127.0.0.1:${sourceAddress.port}/mcp`], lazyUrls: [], disabledUrls: [], timeout: 1, connectTimeout: 1,
  }));
  try {
    const discovery = await client.discoverTools(true);
    assert.equal(discovery.servers[0].ok, false);
    assert.match(discovery.servers[0].error || "", /redirect denied/i);
    assert.equal(redirectedRequests, 0);
  } finally {
    client.dispose();
    await Promise.all([source, redirected].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
});

test("uses a minimal stdio environment, rejects loader injection, and redacts secret MCP output", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mcp-env-"));
  const fixture = path.join(directory, "server.mjs");
  fs.writeFileSync(fixture, `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  const result = message.method === "initialize" ? { capabilities: {} }
    : message.method === "tools/list" ? { tools: [{ name: "env", inputSchema: { type: "object" } }] }
    : { content: [{ type: "text", text: "ambient=" + (process.env.AMBIENT_MCP_SECRET || "none") + "; explicit=" + (process.env.EXPLICIT_MCP_VALUE || "none") + "; token=Bearer abcdefghijklmnop" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`, "utf8");
  process.env.AMBIENT_MCP_SECRET = "must-not-leak";
  const client = new McpClient(() => ({
    baseUrls: [], lazyUrls: [], disabledUrls: [], timeout: 2, connectTimeout: 2,
    servers: [{ id: "env", transport: "stdio", command: process.execPath, args: [fixture], env: { EXPLICIT_MCP_VALUE: "allowed" } }],
  }));
  const blocked = new McpClient(() => ({
    baseUrls: [], lazyUrls: [], disabledUrls: [], timeout: 1, connectTimeout: 1,
    servers: [{ id: "blocked", transport: "stdio", command: process.execPath, args: [fixture], env: { NODE_OPTIONS: "--require evil" } }],
  }));
  try {
    const discovery = await client.discoverTools(true);
    const output = await client.callTool(discovery.tools[0].function.name, {});
    assert.match(output, /ambient=none; explicit=allowed/);
    assert.doesNotMatch(output, /abcdefghijklmnop/);
    assert.match(output, /\[REDACTED\]/);
    const blockedDiscovery = await blocked.discoverTools(true);
    assert.equal(blockedDiscovery.servers[0].ok, false);
    assert.match(blockedDiscovery.servers[0].error || "", /blocked or invalid/i);
  } finally {
    client.dispose();
    blocked.dispose();
    delete process.env.AMBIENT_MCP_SECRET;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("disposing a POSIX stdio MCP session terminates ordinary descendants", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mcp-group-"));
  const fixture = path.join(directory, "server.mjs");
  fs.writeFileSync(fixture, `
import { spawn } from "node:child_process";
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  let result;
  if (message.method === "initialize") result = { capabilities: {} };
  else if (message.method === "tools/list") result = { tools: [{ name: "child", inputSchema: { type: "object" } }] };
  else { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); result = { content: [{ type: "text", text: String(child.pid) }] }; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`, "utf8");
  const client = new McpClient(() => ({
    baseUrls: [], lazyUrls: [], disabledUrls: [], timeout: 2, connectTimeout: 2,
    servers: [{ id: "group", transport: "stdio", command: process.execPath, args: [fixture] }],
  }));
  try {
    const discovery = await client.discoverTools(true);
    const childPid = Number(await client.callTool(discovery.tools[0].function.name, {}));
    assert(Number.isSafeInteger(childPid) && childPid > 0);
    client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    client.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("discovers and calls tools through a local stdio MCP server", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-mcp-"));
  const fixture = path.join(directory, "server.mjs");
  fs.writeFileSync(fixture, `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = { capabilities: {} };
  if (message.method === "tools/list") result = { tools: [{ name: "local_echo", description: "Echo locally", inputSchema: { type: "object" } }] };
  if (message.method === "tools/call") result = { content: [{ type: "text", text: String(message.params.arguments.value) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`, "utf8");
  const client = new McpClient(() => ({
    baseUrls: [],
    lazyUrls: [],
    disabledUrls: [],
    servers: [{ id: "local-test", transport: "stdio", command: process.execPath, args: [fixture] }],
    timeout: 2,
    connectTimeout: 2,
  }));
  try {
    const discovery = await client.discoverTools(true);
    assert.equal(discovery.servers[0].ok, true);
    assert.equal(discovery.servers[0].endpoint, "stdio:local-test");
    assert.equal(discovery.tools.length, 1);
    assert.equal(await client.callTool(discovery.tools[0].function.name, { value: "hello" }), "hello");
  } finally {
    client.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
