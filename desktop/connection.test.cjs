const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { normalizeServerUrl, serverPartition, createConnectionStore } = require("./connection.cjs");

test("server addresses accept root HTTP/HTTPS origins and normalize equivalent hosts", () => {
  assert.equal(normalizeServerUrl(" https://IDE.example.com:443/ "), "https://ide.example.com");
  assert.equal(normalizeServerUrl("http://192.168.1.3:3000"), "http://192.168.1.3:3000");
  assert.equal(normalizeServerUrl("http://[::1]:3000/"), "http://[::1]:3000");
  for (const value of [null, "", "ide.example.com", "file:///tmp/ide", "javascript:alert(1)",
    "https://user:secret@ide.example.com", "https://user@ide.example.com", "https://ide.example.com/ide",
    "https://ide.example.com/a/..", "https://ide.example.com/?token=secret", "https://ide.example.com#login",
    "https://ide.example.com?", "https://ide.example.com/\n", "https://ide.example.com\\evil", "http://a b/", "https://" + "a".repeat(2048)]) {
    assert.throws(() => normalizeServerUrl(value), TypeError, String(value));
  }
});

test("server sessions are persistent, stable, and isolated by full origin", () => {
  assert.match(serverPartition("https://ide.example.com"), /^persist:crownforge-server-[a-f0-9]{64}$/);
  assert.equal(serverPartition("https://IDE.example.com:443/"), serverPartition("https://ide.example.com"));
  for (const value of ["http://ide.example.com", "https://ide.example.com:8443", "https://other.example.com"]) {
    assert.notEqual(serverPartition(value), serverPartition("https://ide.example.com"));
  }
});

test("connection config survives relaunch and stores only a validated server URL", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crownforge-connection-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "connection.json");
  const store = createConnectionStore(file);
  assert.deepEqual(store.get(), { serverUrl: null });
  store.set("https://ide.example.com:443/");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { serverUrl: "https://ide.example.com" });
  assert.deepEqual(createConnectionStore(file).get(), { serverUrl: "https://ide.example.com" });
  assert.throws(() => store.set("https://user:secret@other.example.com"), TypeError);
  assert.deepEqual(store.get(), { serverUrl: "https://ide.example.com" });
  assert.equal(fs.readdirSync(directory).length, 1);
  fs.writeFileSync(file, "not JSON");
  assert.deepEqual(createConnectionStore(file).get(), { serverUrl: null });
  fs.writeFileSync(file, JSON.stringify({ serverUrl: "https://user:password@ide.example.com" }));
  assert.deepEqual(createConnectionStore(file).get(), { serverUrl: null });
});
