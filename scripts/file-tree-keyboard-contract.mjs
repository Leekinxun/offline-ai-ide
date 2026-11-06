import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loader = pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href;
const result = spawnSync(process.execPath, ["--import", loader, "--test", "scripts/fileTreeNavigation.test.ts"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
