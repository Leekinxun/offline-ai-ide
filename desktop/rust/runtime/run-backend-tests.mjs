import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backend = fileURLToPath(new URL("../../../backend/", import.meta.url));
const testDirectory = path.join(backend, "src/desktop");
const files = fs.readdirSync(testDirectory).filter((name) => name.endsWith(".test.ts")).sort().map((name) => path.join(testDirectory, name));
const bootstrapTest = path.join(backend, "src/auth/desktopBootstrap.test.ts");
if (fs.existsSync(bootstrapTest)) files.push(bootstrapTest);
if (!files.length) throw new Error("Desktop backend regression tests are missing");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { cwd: backend, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (!process.exitCode) {
  const cursorTest = fileURLToPath(new URL("../../../frontend/tests/workspaceChangeCursor.test.tsx", import.meta.url));
  const frontendResult = spawnSync(process.execPath, ["--import", "tsx", "--test", cursorTest], { cwd: backend, stdio: "inherit" });
  if (frontendResult.error) throw frontendResult.error;
  process.exitCode = frontendResult.status ?? 1;
}
