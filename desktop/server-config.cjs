const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

function parseUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeServerUrl(value) {
  const url = parseUrl(value);
  if (!url) return null;
  return url.origin;
}

function getCandidateConfigPaths(userDataDir, execPath = process.execPath) {
  const paths = [];
  if (execPath) {
    paths.push(path.join(path.dirname(execPath), "server.json"));
  }
  paths.push(path.join(__dirname, "server.json"));
  paths.push(path.join(process.cwd(), "server.json"));
  if (userDataDir) {
    paths.push(path.join(userDataDir, "server.json"));
  }
  return [...new Set(paths)];
}

function readServerConfig(userDataDir, fileSystem = fs, execPath = process.execPath) {
  // 1. Check CLI argument --server=<url>
  for (const arg of process.argv) {
    if (arg.startsWith("--server=")) {
      const candidate = arg.slice("--server=".length).trim();
      const normalized = normalizeServerUrl(candidate);
      if (normalized) return { serverUrl: normalized, source: "cli" };
    }
  }

  // 2. Check environment variable CROWNFORGE_SERVER_URL
  if (process.env.CROWNFORGE_SERVER_URL) {
    const normalized = normalizeServerUrl(process.env.CROWNFORGE_SERVER_URL.trim());
    if (normalized) return { serverUrl: normalized, source: "env" };
  }

  // 3. Check server.json files in candidate locations
  const candidatePaths = getCandidateConfigPaths(userDataDir, execPath);
  for (const filePath of candidatePaths) {
    try {
      if (!fileSystem.existsSync(filePath)) continue;
      const raw = fileSystem.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const urlCandidate = parsed.serverUrl || parsed.url;
        if (typeof urlCandidate === "string") {
          const normalized = normalizeServerUrl(urlCandidate);
          if (normalized) {
            return { serverUrl: normalized, source: filePath, filePath };
          }
        }
      }
    } catch {
      // Ignore unreadable or malformed files and check next candidate
    }
  }

  return null;
}

function writeServerConfig(userDataDir, serverUrl, fileSystem = fs) {
  const normalized = normalizeServerUrl(serverUrl);
  if (!normalized) {
    throw new Error("Invalid server URL: must be http:// or https:// without credentials");
  }
  const targetPath = path.join(userDataDir, "server.json");
  fileSystem.mkdirSync(userDataDir, { recursive: true });
  const content = `${JSON.stringify({ serverUrl: normalized }, null, 2)}\n`;
  fileSystem.writeFileSync(targetPath, content, "utf8");
  return { serverUrl: normalized, filePath: targetPath };
}

function testServerConnection(serverUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const parsed = parseUrl(serverUrl);
    if (!parsed) {
      return resolve({ ok: false, error: "Invalid URL format" });
    }
    const client = parsed.protocol === "https:" ? https : http;
    const testPath = "/api/health";
    const requestUrl = new URL(testPath, parsed.origin);

    const req = client.get(requestUrl, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      res.resume();
      if (status >= 200 && status < 400) {
        resolve({ ok: true, status });
      } else {
        resolve({ ok: false, status, error: `HTTP ${status}` });
      }
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Connection timed out" });
    });

    req.on("error", (err) => {
      resolve({ ok: false, error: err.message || "Connection refused or unreachable" });
    });
  });
}

module.exports = {
  parseUrl,
  normalizeServerUrl,
  getCandidateConfigPaths,
  readServerConfig,
  writeServerConfig,
  testServerConnection,
};
