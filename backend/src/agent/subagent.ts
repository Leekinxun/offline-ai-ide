import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { safePath } from "../utils/safePath.js";
import { OpenAIMessage, OpenAIToolCall, OpenAIToolDef } from "./types.js";

const SUB_TOOLS_EXPLORE: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

const SUB_TOOLS_WRITE: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
];

const DANGEROUS_PATTERNS = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];

function subBash(command: string, cwd: string): string {
  if (DANGEROUS_PATTERNS.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const output = execSync(command, { cwd, timeout: 120_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return (output.trim() || "(no output)").slice(0, 50000);
  } catch (e: any) {
    return ((e.stdout || "") + (e.stderr || "")).trim().slice(0, 50000) || `Error: ${e.message}`;
  }
}

function subRead(filePath: string, cwd: string): string {
  try {
    return fs.readFileSync(safePath(filePath, cwd), "utf-8").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function subWrite(filePath: string, content: string, cwd: string): string {
  try {
    const full = safePath(filePath, cwd);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function subEdit(filePath: string, oldText: string, newText: string, cwd: string): string {
  try {
    const full = safePath(filePath, cwd);
    const c = fs.readFileSync(full, "utf-8");
    if (!c.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(full, c.replace(oldText, newText), "utf-8");
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function dispatchSubTool(name: string, args: Record<string, unknown>, cwd: string): string {
  switch (name) {
    case "bash":
      return subBash(args.command as string, cwd);
    case "read_file":
      return subRead(args.path as string, cwd);
    case "write_file":
      return subWrite(args.path as string, args.content as string, cwd);
    case "edit_file":
      return subEdit(args.path as string, args.old_text as string, args.new_text as string, cwd);
    default:
      return `Unknown tool: ${name}`;
  }
}

export async function runSubagent(
  prompt: string,
  agentType: string,
  workspaceDir: string,
  vllmApiUrl: string,
  modelName: string,
  vllmApiKey?: string
): Promise<string> {
  const tools =
    agentType === "Explore"
      ? SUB_TOOLS_EXPLORE
      : [...SUB_TOOLS_EXPLORE, ...SUB_TOOLS_WRITE];

  const messages: OpenAIMessage[] = [{ role: "user", content: prompt }];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (vllmApiKey) {
    headers["Authorization"] = `Bearer ${vllmApiKey}`;
  }

  for (let i = 0; i < 30; i++) {
    let resp: Response;
    try {
      resp = await fetch(`${vllmApiUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelName,
          messages,
          tools,
          max_tokens: 8000,
          temperature: 0.3,
        }),
      });
    } catch {
      return "(subagent: LLM request failed)";
    }

    if (!resp.ok) return `(subagent error: ${resp.status})`;

    let data: any;
    try {
      data = await resp.json();
    } catch {
      return "(subagent: failed to parse response)";
    }

    const choice = data.choices?.[0];
    if (!choice) return "(subagent: no response)";

    const msg = choice.message;
    messages.push({
      role: "assistant",
      content: msg.content,
      tool_calls: msg.tool_calls,
    });

    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) break;

    for (const tc of msg.tool_calls as OpenAIToolCall[]) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      const output = dispatchSubTool(tc.function.name, args, workspaceDir);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: output.slice(0, 50000),
      });
    }
  }

  // Extract final text
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return lastAssistant?.content || "(subagent produced no summary)";
}
