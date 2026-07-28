import { spawn } from "node:child_process";
import { evaluateShellCommand } from "./toolPolicy.js";

const MAX_OUTPUT = 50_000;

export async function runWorkspaceCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  const policy = evaluateShellCommand(command);
  if (!policy.allowed) return `Error: Command blocked by workspace policy: ${policy.reason}`;
  if (signal?.aborted) return "Error: Stopped before shell execution";

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timeout: NodeJS.Timeout;

    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(result.slice(0, MAX_OUTPUT));
    };
    const abort = () => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKill.unref?.();
      finish("Error: Stopped during shell execution");
    };
    signal?.addEventListener("abort", abort, { once: true });

    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKill.unref?.();
      finish("Error: Timeout (120s)");
    }, 120_000);
    timeout.unref?.();

    child.on("error", (error) => finish(`Error: ${error.message}`));
    child.on("close", (code) => {
      const trimmed = output.trim();
      if (code === 0) finish(trimmed || "(no output)");
      else finish(
        `Error: Command exited with code ${code ?? "unknown"}${trimmed ? `\n${trimmed}` : ""}`
      );
    });
  });
}
