const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const {
  normalizeServerUrl,
  readServerConfig,
  writeServerConfig,
  testServerConnection,
  getCandidateConfigPaths,
} = require("./server-config.cjs");

test("normalizeServerUrl validates protocol, origin and trailing slashes", () => {
  assert.equal(normalizeServerUrl("http://192.168.1.100:3000/"), "http://192.168.1.100:3000");
  assert.equal(normalizeServerUrl("https://ai-ide.company.internal/path?foo=1"), "https://ai-ide.company.internal");
  assert.equal(normalizeServerUrl("http://localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeServerUrl("ftp://192.168.1.100:3000"), null);
  assert.equal(normalizeServerUrl("http://user:pass@192.168.1.100:3000"), null);
  assert.equal(normalizeServerUrl("not-a-url"), null);
  assert.equal(normalizeServerUrl(""), null);
  assert.equal(normalizeServerUrl(null), null);
});

test("getCandidateConfigPaths includes app directory and userData directory", () => {
  const paths = getCandidateConfigPaths("/test/userData", "/test/app/CrownForge.exe");
  assert.ok(paths.includes("/test/app/server.json"));
  assert.ok(paths.includes("/test/userData/server.json"));
});

test("readServerConfig respects CLI, env and server.json file priorities", () => {
  const memoryFs = {
    files: new Map(),
    existsSync(file) { return this.files.has(file); },
    readFileSync(file) {
      if (!this.files.has(file)) throw new Error("ENOENT");
      return this.files.get(file);
    },
    mkdirSync() {},
    writeFileSync(file, content) { this.files.set(file, content); },
  };

  const appServerFile = "/opt/app/server.json";
  const userServerFile = "/home/user/.crownforge/server.json";

  // Case 1: Empty
  assert.equal(readServerConfig("/home/user/.crownforge", memoryFs, "/opt/app/crownforge"), null);

  // Case 2: server.json in userData
  memoryFs.writeFileSync(userServerFile, JSON.stringify({ serverUrl: "http://10.0.0.1:3000" }));
  const userResult = readServerConfig("/home/user/.crownforge", memoryFs, "/opt/app/crownforge");
  assert.equal(userResult.serverUrl, "http://10.0.0.1:3000");

  // Case 3: server.json in app directory overrides userData
  memoryFs.writeFileSync(appServerFile, JSON.stringify({ serverUrl: "http://192.168.1.50:8000" }));
  const appResult = readServerConfig("/home/user/.crownforge", memoryFs, "/opt/app/crownforge");
  assert.equal(appResult.serverUrl, "http://192.168.1.50:8000");

  // Case 4: Env var overrides server.json
  process.env.CROWNFORGE_SERVER_URL = "http://server-from-env.local:3000";
  try {
    const envResult = readServerConfig("/home/user/.crownforge", memoryFs, "/opt/app/crownforge");
    assert.equal(envResult.serverUrl, "http://server-from-env.local:3000");
    assert.equal(envResult.source, "env");
  } finally {
    delete process.env.CROWNFORGE_SERVER_URL;
  }
});

test("writeServerConfig writes normalized JSON to userData directory", () => {
  const files = new Map();
  const memoryFs = {
    mkdirSync() {},
    writeFileSync(file, content) { files.set(file, content); },
  };

  const result = writeServerConfig("/home/user/.crownforge", "http://192.168.1.200:3000/", memoryFs);
  assert.equal(result.serverUrl, "http://192.168.1.200:3000");
  assert.equal(result.filePath, "/home/user/.crownforge/server.json");
  const saved = JSON.parse(files.get("/home/user/.crownforge/server.json"));
  assert.deepEqual(saved, { serverUrl: "http://192.168.1.200:3000" });
});

test("testServerConnection reports success on reachable server and failure on unreachable", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const reachableUrl = `http://127.0.0.1:${port}`;

  try {
    const success = await testServerConnection(reachableUrl, 1000);
    assert.equal(success.ok, true);
    assert.equal(success.status, 200);

    const fail = await testServerConnection("http://127.0.0.1:1", 500);
    assert.equal(fail.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
