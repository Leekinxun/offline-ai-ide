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
