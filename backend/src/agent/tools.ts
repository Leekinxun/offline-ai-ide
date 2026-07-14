import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { safePath } from "../utils/safePath.js";
import {
  FileSelectionRange,
  OpenAIToolDef,
  ToolContext,
  ToolFileUpdate,
} from "./types.js";
import { TodoManager } from "./todoManager.js";
import { TaskManager } from "./taskManager.js";
import { MessageBus } from "./messageBus.js";
import { TeammateManager } from "./teammateManager.js";
import { runSubagent } from "./subagent.js";
import { recordKnownFileMutation } from "../files/mutationRegistry.js";
import { readMemory, writeMemory } from "./memory.js";
import { loadWorkspaceSkill } from "./skills.js";

// ---- Tool handler type ----

export interface ToolExecutionResult {
  output: string;
  fileUpdate?: ToolFileUpdate;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext & {
    todoManager: TodoManager;
    taskManager: TaskManager;
    messageBus: MessageBus;
    teammateManager: TeammateManager;
  }
) => Promise<string | ToolExecutionResult>;

// ---- Core tool implementations ----

const DANGEROUS_PATTERNS = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];

function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, safeOffset).split("\n");
  return {
    line: before.length,
    column: before[before.length - 1].length + 1,
  };
}

function createSelectionRange(
  text: string,
  startOffset: number,
  endOffset: number
): FileSelectionRange {
  const start = offsetToPosition(text, startOffset);
  const end = offsetToPosition(text, endOffset);
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

async function runBash(command: string, cwd: string): Promise<string> {
  if (DANGEROUS_PATTERNS.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd,
      timeout: 120_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = output.trim();
    return result ? result.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed) return "Error: Timeout (120s)";
    const output = ((e.stdout || "") + (e.stderr || "")).trim();
    return output ? output.slice(0, 50000) : `Error: ${e.message}`;
  }
}

async function runReadFile(
  filePath: string,
  limit: number | undefined,
  cwd: string
): Promise<string> {
  try {
    const full = safePath(filePath, cwd);
    const content = fs.readFileSync(full, "utf-8");
    const lines = content.split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
    }
    return content.slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runWriteFile(
  filePath: string,
  content: string,
  cwd: string,
  actorName?: string
): Promise<string | ToolExecutionResult> {
  try {
    const full = safePath(filePath, cwd);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    const stat = fs.statSync(full);
    recordKnownFileMutation({
      workspaceDir: cwd,
      path: filePath,
      source: "assistant_tool",
      actor: actorName,
      mtimeMs: stat.mtimeMs,
      content,
    });
    return {
      output: `Wrote ${content.length} bytes to ${filePath}`,
      fileUpdate: {
        path: filePath,
        content,
      },
    };
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function runEditFile(
  filePath: string,
  oldText: string,
  newText: string,
  cwd: string,
  actorName?: string
): Promise<string | ToolExecutionResult> {
  try {
    const full = safePath(filePath, cwd);
    const content = fs.readFileSync(full, "utf-8");
    const matchOffset = content.indexOf(oldText);
    if (matchOffset < 0) {
      return `Error: Text not found in ${filePath}`;
    }
    const updatedContent = content.replace(oldText, newText);
    fs.writeFileSync(full, updatedContent, "utf-8");
    const stat = fs.statSync(full);
    recordKnownFileMutation({
      workspaceDir: cwd,
      path: filePath,
      source: "assistant_tool",
      actor: actorName,
      mtimeMs: stat.mtimeMs,
      content: updatedContent,
    });
    return {
      output: `Edited ${filePath}`,
      fileUpdate: {
        path: filePath,
        content: updatedContent,
        selection: createSelectionRange(
          updatedContent,
          matchOffset,
          matchOffset + newText.length
        ),
      },
    };
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ---- Dispatch table ----

export const TOOL_DISPATCH: Record<string, ToolHandler> = {
  compress: async () =>
    "Context compaction requested. The agent will summarize the conversation before continuing.",

  memory_read: async (args, ctx) =>
    readMemory(ctx.workspaceDir, args.scope),

  memory_write: async (args, ctx) =>
    writeMemory(ctx.workspaceDir, args.scope, args.content),

  skill_load: async (args, ctx) =>
    loadWorkspaceSkill(ctx.workspaceDir, args.name),

  bash: async (args, ctx) =>
    runBash(args.command as string, ctx.workspaceDir),

  read_file: async (args, ctx) =>
    runReadFile(args.path as string, args.limit as number | undefined, ctx.workspaceDir),

  write_file: async (args, ctx) =>
    runWriteFile(
      args.path as string,
      args.content as string,
      ctx.workspaceDir,
      ctx.actorName
    ),

  edit_file: async (args, ctx) =>
    runEditFile(
      args.path as string,
      args.old_text as string,
      args.new_text as string,
      ctx.workspaceDir,
      ctx.actorName
    ),

  TodoWrite: async (args, ctx) =>
    ctx.todoManager.update(args.items as unknown[]),

  // --- Task tools ---
  task_create: async (args, ctx) =>
    ctx.taskManager.create(args.subject as string, (args.description as string) || ""),

  task_get: async (args, ctx) =>
    ctx.taskManager.get(args.task_id as number),

  task_update: async (args, ctx) =>
    ctx.taskManager.update(
      args.task_id as number,
      args.status as string | undefined,
      args.add_blocked_by as number[] | undefined,
      args.add_blocks as number[] | undefined
    ),

  task_list: async (_args, ctx) =>
    ctx.taskManager.listAll(),

  claim_task: async (args, ctx) =>
    ctx.taskManager.claim(args.task_id as number, "lead"),

  // --- Subagent ---
  task: async (args, ctx) =>
    runSubagent(
      args.prompt as string,
      (args.agent_type as string) || "Explore",
      ctx.workspaceDir,
      ctx.vllmApiUrl,
      ctx.modelName,
      ctx.vllmApiKey
    ),

  // --- Team tools ---
  spawn_teammate: async (args, ctx) =>
    ctx.teammateManager.spawn(args.name as string, args.role as string, args.prompt as string),

  list_teammates: async (_args, ctx) =>
    ctx.teammateManager.listAll(),

  send_message: async (args, ctx) =>
    ctx.messageBus.send("lead", args.to as string, args.content as string, (args.msg_type as string) || "message"),

  read_inbox: async (_args, ctx) =>
    JSON.stringify(ctx.messageBus.readInbox("lead"), null, 2),

  broadcast: async (args, ctx) =>
    ctx.messageBus.broadcast("lead", args.content as string, ctx.teammateManager.memberNames()),

  shutdown_request: async (args, ctx) => {
    const teammate = args.teammate as string;
    ctx.messageBus.send("lead", teammate, "Please shut down.", "shutdown_request");
    return `Shutdown request sent to '${teammate}'`;
  },
};

// ---- Tool definitions (OpenAI function-calling format) ----

export const CORE_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "compress",
      description: "Compact the current conversation context before continuing the task.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_read",
      description: "Read durable user or workspace memory. Use scope 'user' for preferences and 'workspace' for project conventions.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "workspace"] },
        },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Persist concise durable preferences, project conventions, or decisions. Never store secrets or transient task output.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "workspace"] },
          content: { type: "string", description: "Complete replacement Markdown content for the memory file" },
        },
        required: ["scope", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_load",
      description: "Load the full body of a relevant workspace SKILL.md workflow before following it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the Workspace Skills catalog" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace directory.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to execute" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from workspace root" },
          limit: { type: "integer", description: "Max lines to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file (creates parent directories).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from workspace root" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace the first occurrence of old_text with new_text in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path" },
          old_text: { type: "string", description: "Exact text to find" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description: "Update the task tracking checklist. Max 20 items, max 1 in_progress.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                activeForm: { type: "string" },
              },
              required: ["content", "status", "activeForm"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

export const TASK_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "task_create",
      description: "Create a persistent file task.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          description: { type: "string" },
        },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_get",
      description: "Get task details by ID.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "integer" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_update",
      description: "Update task status or dependencies.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "integer" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
          add_blocked_by: { type: "array", items: { type: "integer" } },
          add_blocks: { type: "array", items: { type: "integer" } },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_list",
      description: "List all tasks.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "claim_task",
      description: "Claim a task from the board.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "integer" } },
        required: ["task_id"],
      },
    },
  },
];

export const TEAM_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "task",
      description: "Spawn a subagent for isolated exploration or work. Returns a summary when done.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          agent_type: { type: "string", enum: ["Explore", "general-purpose"] },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_teammate",
      description: "Spawn a persistent autonomous teammate.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["name", "role", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_teammates",
      description: "List all teammates and their status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a message to a teammate.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          content: { type: "string" },
          msg_type: { type: "string", enum: ["message", "broadcast", "shutdown_request"] },
        },
        required: ["to", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_inbox",
      description: "Read and drain the lead agent's inbox.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "broadcast",
      description: "Send message to all teammates.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shutdown_request",
      description: "Request a teammate to shut down.",
      parameters: {
        type: "object",
        properties: { teammate: { type: "string" } },
        required: ["teammate"],
      },
    },
  },
];

export const MCP_CONTROL_TOOLS: OpenAIToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_lazy_mcp_tools",
      description: "Search hidden lazy MCP tools by capability before exposing them to the model.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Capability or tool keyword to search for" },
          endpoint_key: { type: "string", description: "Optional endpoint key to narrow the search" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_lazy_mcp_tools",
      description: "Expose selected tools from one lazy MCP endpoint for the next reasoning round.",
      parameters: {
        type: "object",
        properties: {
          endpoint_key: { type: "string", description: "Endpoint key returned by search_lazy_mcp_tools" },
          tool_names: { type: "array", items: { type: "string" }, description: "Exact MCP tool names to activate" },
        },
        required: ["endpoint_key", "tool_names"],
      },
    },
  },
];

const READ_ONLY_TOOL_NAMES = new Set(["compress", "memory_read", "skill_load", "read_file", "TodoWrite"]);

export function getAllTools(options?: { readOnly?: boolean; mode?: "ask" | "code" | "review" | "plan" }): OpenAIToolDef[] {
  const allTools = [...CORE_TOOLS, ...TASK_TOOLS, ...TEAM_TOOLS];
  if (!options?.readOnly && options?.mode !== "ask" && options?.mode !== "review" && options?.mode !== "plan") {
    return allTools;
  }
  return allTools.filter((tool) =>
    READ_ONLY_TOOL_NAMES.has(tool.function.name) ||
    (options?.mode === "review" && tool.function.name === "bash") ||
    (options?.mode === "plan" && ["task_create", "task_get", "task_list"].includes(tool.function.name))
  );
}
