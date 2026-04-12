import fs from "fs";
import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "child_process";
import type { UserSession } from "../auth/sessionManager.js";

// Try to load node-pty; it may fail on some platforms (e.g. macOS + Node 22)
let pty: typeof import("node-pty") | null = null;
try {
  pty = await import("node-pty");
} catch {
  console.warn("node-pty unavailable, will use child_process fallback for terminal");
}

function getShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  for (const s of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (fs.existsSync(s)) return s;
  }
  return "/bin/sh";
}

function spawnWithPty(ws: WebSocket, workspaceDir: string): boolean {
  if (!pty) return false;
  try {
    const shell = pty.spawn(getShell(), ["--login"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: workspaceDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

    shell.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    shell.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input") shell.write(msg.data);
        else if (msg.type === "resize") shell.resize(msg.cols || 80, msg.rows || 24);
      } catch {}
    });

    ws.on("close", () => { shell.kill(); });
    return true;
  } catch (e: any) {
    console.warn("node-pty spawn failed, falling back to child_process:", e.message);
    return false;
  }
}

function spawnWithChildProcess(ws: WebSocket, workspaceDir: string): void {
  const shellPath = getShell();

  // Use Python's pty module to allocate a real PTY for the shell.
  // This gives us echo, line editing, and job control without node-pty.
  const pyScript = [
    "import pty, os, sys, select, signal",
    `os.chdir(${JSON.stringify(workspaceDir)})`,
    `os.environ["TERM"]="xterm-256color"`,
    `os.environ["COLORTERM"]="truecolor"`,
    "master, slave = pty.openpty()",
    "pid = os.fork()",
    "if pid == 0:",
    "    os.setsid()",
    "    os.dup2(slave, 0)",
    "    os.dup2(slave, 1)",
    "    os.dup2(slave, 2)",
    "    os.close(master)",
    "    os.close(slave)",
    `    os.execvp(${JSON.stringify(shellPath)}, [${JSON.stringify(shellPath)}, "-i"])`,
    "else:",
    "    os.close(slave)",
    "    try:",
    "        while True:",
    "            r, _, _ = select.select([sys.stdin, master], [], [])",
    "            if sys.stdin in r:",
    "                d = os.read(sys.stdin.fileno(), 4096)",
    "                if not d: break",
    "                os.write(master, d)",
    "            if master in r:",
    "                d = os.read(master, 4096)",
    "                if not d: break",
    "                sys.stdout.buffer.write(d)",
    "                sys.stdout.buffer.flush()",
    "    except OSError:",
    "        pass",
    "    finally:",
    "        os.waitpid(pid, 0)",
  ].join("\n");

  const proc: ChildProcess = spawn("python3", ["-u", "-c", pyScript], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
  });

  proc.stderr?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
  });

  proc.on("exit", () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input") proc.stdin?.write(msg.data);
      // resize not supported in child_process mode
    } catch {}
  });

  ws.on("close", () => { proc.kill(); });
}

export function handleTerminalWs(ws: WebSocket, session: UserSession): void {
  try {
    fs.mkdirSync(session.workspaceDir, { recursive: true });

    // Try node-pty first (full PTY support), fall back to child_process
    if (!spawnWithPty(ws, session.workspaceDir)) {
      spawnWithChildProcess(ws, session.workspaceDir);
    }
  } catch (e: any) {
    console.error("Terminal spawn failed:", e.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n\x1b[31mTerminal error: ${e.message}\x1b[0m\r\n`);
      ws.close();
    }
  }
}
