import assert from "node:assert/strict";
import { createServer } from "node:http";
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
