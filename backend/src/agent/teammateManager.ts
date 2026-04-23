import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { execSync } from "child_process";
import { TeamConfig, TeamMember, OpenAIMessage, OpenAIToolCall, OpenAIToolDef } from "./types.js";
import { MessageBus } from "./messageBus.js";
import { TaskManager } from "./taskManager.js";
import { safePath } from "../utils/safePath.js";
import { callChatCompletion } from "./llm.js";

const POLL_INTERVAL = 5000; // ms
const IDLE_TIMEOUT = 60000; // ms

const TEAMMATE_TOOLS: OpenAIToolDef[] = [
  { type: "function", function: { name: "bash", description: "Run command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file", description: "Read file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Edit file.", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } } },
  { type: "function", function: { name: "send_message", description: "Send message.", parameters: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } } },
  { type: "function", function: { name: "idle", description: "Signal no more work.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "claim_task", description: "Claim task by ID.", parameters: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } } },
];

const DANGEROUS_PATTERNS = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];

function dispatchTeammateTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  agentName: string,
  bus: MessageBus,
  taskMgr: TaskManager
): string {
  switch (name) {
    case "bash": {
      const cmd = args.command as string;
      if (DANGEROUS_PATTERNS.some((d) => cmd.includes(d))) return "Error: Dangerous command blocked";
      try {
        const out = execSync(cmd, { cwd, timeout: 120_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        return (out.trim() || "(no output)").slice(0, 50000);
      } catch (e: any) {
        return ((e.stdout || "") + (e.stderr || "")).trim().slice(0, 50000) || `Error: ${e.message}`;
      }
    }
    case "read_file":
      try { return fs.readFileSync(safePath(args.path as string, cwd), "utf-8").slice(0, 50000); }
      catch (e: any) { return `Error: ${e.message}`; }
    case "write_file":
      try {
        const full = safePath(args.path as string, cwd);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, args.content as string, "utf-8");
        return `Wrote ${(args.content as string).length} bytes`;
      } catch (e: any) { return `Error: ${e.message}`; }
    case "edit_file":
      try {
        const full = safePath(args.path as string, cwd);
        const c = fs.readFileSync(full, "utf-8");
        if (!c.includes(args.old_text as string)) return "Error: Text not found";
        fs.writeFileSync(full, c.replace(args.old_text as string, args.new_text as string), "utf-8");
        return "Edited";
      } catch (e: any) { return `Error: ${e.message}`; }
    case "send_message":
      return bus.send(agentName, args.to as string, args.content as string);
    case "idle":
      return "Entering idle phase.";
    case "claim_task":
      return taskMgr.claim(args.task_id as number, agentName);
    default:
      return `Unknown tool: ${name}`;
  }
}

export class TeammateManager {
  private teamDir: string;
  private configPath: string;
  private config: TeamConfig;
  private bus: MessageBus;
  private taskMgr: TaskManager;
  private workspaceDir: string;
  private activeLoops: Map<string, { abort: boolean }> = new Map();

  constructor(workspaceDir: string, bus: MessageBus, taskMgr: TaskManager) {
    this.workspaceDir = workspaceDir;
    this.teamDir = path.join(workspaceDir, ".team");
    this.configPath = path.join(this.teamDir, "config.json");
    this.bus = bus;
    this.taskMgr = taskMgr;
    try {
      fs.mkdirSync(this.teamDir, { recursive: true });
    } catch { /* defer */ }
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      }
    } catch { /* default */ }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(this.teamDir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch { /* ignore */ }
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private setStatus(name: string, status: TeamMember["status"]): void {
    const member = this.findMember(name);
    if (member) {
      member.status = status;
      this.saveConfig();
    }
  }

  async spawn(name: string, role: string, prompt: string): Promise<string> {
    let member = this.findMember(name);
    if (member) {
      if (member.status === "working") return `Error: '${name}' is currently working`;
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();

    // Start background loop (non-blocking)
    const control = { abort: false };
    this.activeLoops.set(name, control);
    this.runTeammateLoop(name, role, prompt, control).catch(() => {
      this.setStatus(name, "shutdown");
    });

    return `Spawned '${name}' (role: ${role})`;
  }

  private async runTeammateLoop(
    name: string,
    role: string,
    prompt: string,
    control: { abort: boolean }
  ): Promise<void> {
    const sysPrompt = `You are '${name}', role: ${role}, team: ${this.config.team_name}, at ${this.workspaceDir}. Use idle when done with current work.`;
    const messages: OpenAIMessage[] = [{ role: "user", content: prompt }];
    const vllmUrl = config.vllmApiUrl;
    const vllmApiKey = config.vllmApiKey;
    const model = config.modelName;

    // Work phase
    for (let round = 0; round < 50 && !control.abort; round++) {
      // Check inbox
      const inbox = this.bus.readInbox(name);
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          this.setStatus(name, "shutdown");
          this.activeLoops.delete(name);
          return;
        }
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      let resp: Response;
      try {
        resp = await callChatCompletion({
          apiUrl: vllmUrl,
          apiKey: vllmApiKey,
          model,
          systemPrompt: sysPrompt,
          messages,
          tools: TEAMMATE_TOOLS,
          maxTokens: config.agentMaxTokens,
        });
      } catch {
        this.setStatus(name, "shutdown");
        this.activeLoops.delete(name);
        return;
      }

      if (!resp.ok) { this.setStatus(name, "shutdown"); this.activeLoops.delete(name); return; }

      let data: any;
      try { data = await resp.json(); } catch { this.setStatus(name, "shutdown"); this.activeLoops.delete(name); return; }

      const choice = data.choices?.[0];
      if (!choice) { this.setStatus(name, "shutdown"); this.activeLoops.delete(name); return; }

      messages.push({ role: "assistant", content: choice.message.content, tool_calls: choice.message.tool_calls });

      if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) break;

      let idleRequested = false;
      for (const tc of choice.message.tool_calls as OpenAIToolCall[]) {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        if (tc.function.name === "idle") idleRequested = true;
        const output = dispatchTeammateTool(tc.function.name, args, this.workspaceDir, name, this.bus, this.taskMgr);
        console.log(`  [${name}] ${tc.function.name}: ${output.slice(0, 120)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }

      if (idleRequested) break;
    }

    // Idle phase: poll for messages and unclaimed tasks
    this.setStatus(name, "idle");
    const pollStart = Date.now();

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (control.abort || Date.now() - pollStart > IDLE_TIMEOUT) {
          clearInterval(interval);
          this.setStatus(name, "shutdown");
          this.activeLoops.delete(name);
          resolve();
          return;
        }

        const inbox = this.bus.readInbox(name);
        if (inbox.length > 0) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              clearInterval(interval);
              this.setStatus(name, "shutdown");
              this.activeLoops.delete(name);
              resolve();
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          clearInterval(interval);
          this.setStatus(name, "working");
          // Restart work loop
          this.runTeammateLoop(name, role, "", { ...control }).catch(() => {
            this.setStatus(name, "shutdown");
          });
          resolve();
          return;
        }

        // Check for unclaimed tasks
        const unclaimed = this.taskMgr.getUnclaimed();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          this.taskMgr.claim(task.id, name);
          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`,
          });
          clearInterval(interval);
          this.setStatus(name, "working");
          this.runTeammateLoop(name, role, "", { ...control }).catch(() => {
            this.setStatus(name, "shutdown");
          });
          resolve();
        }
      }, POLL_INTERVAL);
    });
  }

  listAll(): string {
    if (this.config.members.length === 0) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}
