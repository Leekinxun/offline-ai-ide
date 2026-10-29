const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

function normalizeServerUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) {
    throw new TypeError("请输入有效的 HTTP 或 HTTPS 服务器地址。");
  }
  const input = value.trim();
  // The shared frontend uses absolute /api and /ws routes. Do not silently
  // normalize a reverse-proxy subpath, credentials, or a pasted login URL.
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(input)) {
    throw new TypeError("请输入服务器根地址，例如 https://ide.example.com，不含路径、查询参数或片段。");
  }
  let url;
  try { url = new URL(input); } catch { throw new TypeError("服务器地址格式不正确。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("服务器地址不能包含账号、密码、路径、查询参数或片段。");
  }
  return url.origin;
}

function serverId(value) {
  return crypto.createHash("sha256").update(normalizeServerUrl(value)).digest("hex");
}
function serverPartition(value) { return `persist:crownforge-server-${serverId(value)}`; }

function createConnectionStore(file, fileSystem = fs) {
  let serverUrl = null;
  try {
    if (fileSystem.statSync(file).size <= 8192) serverUrl = normalizeServerUrl(JSON.parse(fileSystem.readFileSync(file, "utf8")).serverUrl);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
  }
  return {
    get: () => ({ serverUrl }),
    set(value) {
      const next = normalizeServerUrl(value);
      fileSystem.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
      try {
        fileSystem.writeFileSync(temporary, `${JSON.stringify({ serverUrl: next }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        fileSystem.renameSync(temporary, file);
      } finally { fileSystem.rmSync(temporary, { force: true }); }
      serverUrl = next;
      return { serverUrl };
    },
  };
}

module.exports = { normalizeServerUrl, serverId, serverPartition, createConnectionStore, RETRY_DELAYS };
