import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backend = fileURLToPath(new URL("../../../backend/", import.meta.url));
const testDirectory = path.join(backend, "src/desktop");
const files = fs.readdirSync(testDirectory).filter((name) => name.endsWith(".test.ts")).sort().map((name) => path.join(testDirectory, name));
const bootstrapTest = path.join(backend, "src/auth/desktopBootstrap.test.ts");
if (fs.existsSync(bootstrapTest)) files.push(bootstrapTest);
const chatCheckpointTest = path.join(backend, "src/chat/desktopRunCheckpoint.test.ts");
if (fs.existsSync(chatCheckpointTest)) files.push(chatCheckpointTest);
for (const name of ["processTools.native.integration.test.ts", "delegatedEffects.native.integration.test.ts"]) {
  const nativeAgentTest = path.join(backend, "src/agent", name);
  if (fs.existsSync(nativeAgentTest)) files.push(nativeAgentTest);
}
if (!files.length) throw new Error("Desktop backend regression tests are missing");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { cwd: backend, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (!process.exitCode) {
  const frontendTests = ["workspaceChangeCursor.test.tsx", "editorAssistantFailure.test.ts", "runFailureNotice.test.ts", "runReviewPolicy.test.ts", "chatChangesSurface.test.ts"]
    .map((name) => fileURLToPath(new URL(`../../../frontend/tests/${name}`, import.meta.url)));
  const frontendResult = spawnSync(process.execPath, ["--import", "tsx", "--test", ...frontendTests], { cwd: backend, stdio: "inherit" });
  if (frontendResult.error) throw frontendResult.error;
  process.exitCode = frontendResult.status ?? 1;
}
