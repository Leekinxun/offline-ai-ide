const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isTrustedUiUrl, isTrustedSender, externalUrl, createApplicationMenu } = require("./bridge-policy.cjs");

const origin = "http://127.0.0.1:43210";
const preview = `${origin}/preview/12345678-abcd-1234-abcd-123456789abc/${"a".repeat(64)}/`;

test("only the registered IDE main frame can call native bridge handlers", () => {
  const frame = { url: `${origin}/?vibe=1` };
  const contents = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const registered = new Set([contents]);
  const event = { sender: contents, senderFrame: frame };
  assert.equal(isTrustedSender(event, origin, registered), true);
  frame.url = `${origin}/login`;
  assert.equal(isTrustedSender(event, origin, registered), true);
  assert.equal(isTrustedSender({ ...event, senderFrame: { url: `${origin}/` } }, origin, registered), false);
  assert.equal(isTrustedSender({ ...event, senderFrame: null }, origin, registered), false);
  assert.equal(isTrustedSender(event, origin, new Set()), false);
  contents.isDestroyed = () => true;
  assert.equal(isTrustedSender(event, origin, registered), false);
  contents.isDestroyed = () => false;
  for (const url of [preview, `${origin}/api/config`, `${origin}/mobile`, "about:blank", "https://example.com/", "http://127.0.0.1:43211/", "http://admin@127.0.0.1:43210/"]) {
    frame.url = url;
    assert.equal(isTrustedSender(event, origin, registered), false, url);
    assert.equal(isTrustedUiUrl(url, origin), false, url);
  }
  frame.url = `${origin}/`;
  contents.getURL = () => preview;
  assert.equal(isTrustedSender(event, origin, registered), false);
});

test("external URLs admit only HTTPS sites or the current ticketed preview root", () => {
  assert.equal(externalUrl(preview, origin), preview);
  assert.equal(externalUrl("https://example.com/docs?q=desktop#prefs", origin), "https://example.com/docs?q=desktop#prefs");
  const rejected = [
    "file:///etc/passwd", "javascript:alert(1)", "http://example.com/", `${origin}/api/config`, `${origin}/`,
    preview.replace(":43210", ":43211"), preview.replace("127.0.0.1", "localhost"), preview.replace("/preview/", "/preview/%2e%2e/"),
    preview.replace("a".repeat(64), "short"), `${preview}?next=/`, `${preview}#hash`, `${preview}index.html`,
    `http://user:pass@127.0.0.1:43210${new URL(preview).pathname}`, "https://user:pass@example.com/",
    "https://localhost:8000/", "https://localhost.:8000/", "https://x.localhost:8000/", "https://127.1:8000/",
    "https://0.0.0.0/", "https://[::1]:8000/", "https://[::ffff:127.0.0.1]/", "https://example.com/\n",
  ];
  for (const url of rejected) assert.equal(externalUrl(url, origin), null, url);
});

test("native menu sends CSS zoom commands without native zoom roles or shortcut accelerators", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const commands = [];
    const template = createApplicationMenu(platform, (command, window) => commands.push([command, window]));
    assert.ok(template.some((item) => item.role === "editMenu"));
    assert.ok(template.some((item) => item.role === "windowMenu"));
    assert.equal(template.some((item) => item.role === "appMenu"), platform === "darwin");
    const items = template.flatMap((item) => item.submenu || [item]);
    assert.equal(items.some((item) => ["resetZoom", "zoomIn", "zoomOut", "viewMenu"].includes(item.role)), false);
    const zoom = items.filter((item) => item.click);
    assert.equal(zoom.length, 3);
    const window = {};
    for (const item of zoom) {
      assert.equal(item.accelerator, undefined);
      item.click({}, window);
    }
    assert.deepEqual(commands, [["reset", window], ["in", window], ["out", window]]);
  }
});
