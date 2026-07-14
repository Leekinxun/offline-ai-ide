import { createHash } from "node:crypto";
import { getMcpSettings, McpRuntimeSettings } from "../config.js";
import { OpenAIToolDef } from "./types.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_CLIENT_NAME = "crownforge";
const MCP_CLIENT_VERSION = "0.2.0";
const DISCOVERY_CACHE_TTL_MS = 10_000;

interface McpRawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

export interface McpServerPreview {
  endpoint: string;
  endpointKey: string;
  ok: boolean;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  error?: string;
}

export interface McpToolDiscovery {
  tools: OpenAIToolDef[];
  servers: McpServerPreview[];
  hasLazyEndpoints: boolean;
}

export interface McpLazyToolCandidate {
  endpoint: string;
  endpointKey: string;
  toolName: string;
  description: string;
}

export class McpToolSelection {
  readonly activatedEndpointKeys = new Set<string>();
  readonly activatedToolsByEndpoint = new Map<string, Set<string>>();

  activate(endpointKey: string, toolNames: string[]): void {
    this.activatedEndpointKeys.add(endpointKey);
    const selected = this.activatedToolsByEndpoint.get(endpointKey) || new Set<string>();
    for (const toolName of toolNames) selected.add(toolName);
    this.activatedToolsByEndpoint.set(endpointKey, selected);
  }

  isEndpointActivated(endpointKey: string): boolean {
    return this.activatedEndpointKeys.has(endpointKey);
  }

  isToolActivated(endpointKey: string, toolName: string): boolean {
    return this.activatedToolsByEndpoint.get(endpointKey)?.has(toolName) || false;
  }

  cacheKey(): string {
    return JSON.stringify({
      endpoints: [...this.activatedEndpointKeys].sort(),
      tools: [...this.activatedToolsByEndpoint.entries()]
        .map(([key, names]) => [key, [...names].sort()])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    });
  }
}

interface ToolBinding {
  endpoint: McpEndpointSession;
  actualName: string;
}

interface JsonRpcResponse {
  result?: {
    tools?: McpRawTool[];
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
  };
  error?: unknown;
}

class McpEndpointSession {
  private sessionId: string | undefined;
  private initialized = false;
  private requestId = 0;

  constructor(public readonly baseUrl: string, private readonly timeoutMs: number) {}

  async listTools(): Promise<McpRawTool[]> {
    await this.ensureInitialized();
    const response = await this.request("tools/list", {});
    if (response.error) {
      throw new Error(`MCP tools/list error: ${JSON.stringify(response.error)}`);
    }
    return Array.isArray(response.result?.tools) ? response.result.tools : [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    await this.ensureInitialized();
    const response = await this.request("tools/call", { name, arguments: arguments_ });
    if (response.error) {
      throw new Error(`MCP tools/call error: ${JSON.stringify(response.error)}`);
    }

    const content = response.result?.content;
    if (!Array.isArray(content) || content.length === 0) return "(no output)";

    const output = content
      .map((item) =>
        item.type === "text" && typeof item.text === "string"
          ? item.text
          : JSON.stringify(item)
      )
      .join("\n");
    return response.result?.isError ? `[MCP Error] ${output}` : output;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const response = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: MCP_CLIENT_NAME,
        version: MCP_CLIENT_VERSION,
      },
    });
    if (response.error) {
      throw new Error(`MCP initialize error: ${JSON.stringify(response.error)}`);
    }
    this.initialized = true;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.requestId,
          method,
          params,
        }),
        signal: controller.signal,
      });

      const sessionId = response.headers.get("mcp-session-id")?.trim();
      if (sessionId) this.sessionId = sessionId;

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`MCP request failed (${response.status}): ${body.slice(0, 500)}`);
      }
      return parseMcpResponse(body);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class McpClient {
  private readonly sessions = new Map<string, McpEndpointSession>();
  private readonly bindings = new Map<string, ToolBinding>();
  private cacheKey = "";
  private cachedAt = 0;
  private cachedDiscovery: McpToolDiscovery = { tools: [], servers: [], hasLazyEndpoints: false };

  constructor(
    private readonly settingsProvider: () => McpRuntimeSettings = getMcpSettings
  ) {}

  async discoverTools(force = false, selection = new McpToolSelection()): Promise<McpToolDiscovery> {
    const settings = this.settingsProvider();
    const baseUrls = uniqueUrls(settings.baseUrls);
    const lazyUrls = new Set(uniqueUrls(settings.lazyUrls));
    const disabledUrls = new Set(uniqueUrls(settings.disabledUrls));
    const activeUrls = baseUrls.filter((url) => !disabledUrls.has(url));
    const cacheKey = JSON.stringify({
      ...settings,
      baseUrls: activeUrls,
      selection: selection.cacheKey(),
    });
    if (
      !force &&
      cacheKey === this.cacheKey &&
      Date.now() - this.cachedAt < DISCOVERY_CACHE_TTL_MS
    ) {
      return this.cachedDiscovery;
    }

    if (cacheKey !== this.cacheKey) {
      this.sessions.clear();
    }
    this.cacheKey = cacheKey;
    const activeUrlSet = new Set(activeUrls);
    for (const url of this.sessions.keys()) {
      if (!activeUrlSet.has(url)) this.sessions.delete(url);
    }
    this.bindings.clear();

    const tools: OpenAIToolDef[] = [];
    const servers: McpServerPreview[] = [];
    for (const baseUrl of activeUrls) {
      const session = this.getSession(baseUrl, settings.timeout);
      const endpointKeyValue = endpointKey(baseUrl);
      try {
        const rawTools = await session.listTools();
        const previewTools: Array<{ name: string; description: string }> = [];
        const hideUnactivated =
          lazyUrls.has(baseUrl) && !selection.isEndpointActivated(endpointKeyValue);
        for (const rawTool of rawTools) {
          const actualName = typeof rawTool.name === "string" ? rawTool.name.trim() : "";
          if (!actualName) continue;
          const description =
            typeof rawTool.description === "string" ? rawTool.description.trim() : "";
          if (
            hideUnactivated ||
            (lazyUrls.has(baseUrl) && !selection.isToolActivated(endpointKeyValue, actualName))
          ) {
            previewTools.push({ name: actualName, description });
            continue;
          }
          const fullName = scopedToolName(baseUrl, actualName);
          const parameters = normalizeInputSchema(rawTool.inputSchema);
          tools.push({
            type: "function",
            function: {
              name: fullName,
              description: `[MCP ${baseUrl}] ${description}`.trim(),
              parameters,
            },
          });
          this.bindings.set(fullName, { endpoint: session, actualName });
          previewTools.push({ name: actualName, description });
        }
        servers.push({
          endpoint: baseUrl,
          endpointKey: endpointKeyValue,
          ok: true,
          toolCount: previewTools.length,
          tools: previewTools,
        });
      } catch (error) {
        servers.push({
          endpoint: baseUrl,
          endpointKey: endpointKeyValue,
          ok: false,
          toolCount: 0,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.cachedDiscovery = {
      tools,
      servers,
      hasLazyEndpoints: activeUrls.some((url) => lazyUrls.has(url)),
    };
    this.cachedAt = Date.now();
    return this.cachedDiscovery;
  }

  async inspectServers(): Promise<McpServerPreview[]> {
    const discovery = await this.discoverTools(true, new McpToolSelection());
    return discovery.servers;
  }

  async searchLazyTools(query: unknown, endpointKeyFilter?: unknown): Promise<string> {
    const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
    if (!normalizedQuery) throw new Error("mcp_search_tools requires a non-empty query");
    const endpointFilter = typeof endpointKeyFilter === "string" ? endpointKeyFilter.trim() : "";
    const settings = this.settingsProvider();
    const lazyUrls = new Set(uniqueUrls(settings.lazyUrls));
    const disabledUrls = new Set(uniqueUrls(settings.disabledUrls));
    const candidates: McpLazyToolCandidate[] = [];

    for (const baseUrl of uniqueUrls(settings.baseUrls)) {
      if (!lazyUrls.has(baseUrl) || disabledUrls.has(baseUrl)) continue;
      const key = endpointKey(baseUrl);
      if (endpointFilter && endpointFilter !== key) continue;
      try {
        const tools = await this.getSession(baseUrl, settings.timeout).listTools();
        for (const tool of tools) {
          const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
          const description = typeof tool.description === "string" ? tool.description.trim() : "";
          if (!toolName) continue;
          if (!`${baseUrl} ${toolName} ${description}`.toLowerCase().includes(normalizedQuery)) continue;
          candidates.push({ endpoint: baseUrl, endpointKey: key, toolName, description });
        }
      } catch {
        // Discovery errors are surfaced by the regular MCP status event.
      }
    }
    return JSON.stringify(candidates, null, 2);
  }

  async activateLazyTools(
    selection: McpToolSelection,
    endpointKeyValue: unknown,
    toolNames: unknown
  ): Promise<string> {
    if (typeof endpointKeyValue !== "string" || !endpointKeyValue.trim()) {
      throw new Error("mcp_activate_tools requires endpoint_key");
    }
    if (!Array.isArray(toolNames) || toolNames.length === 0) {
      throw new Error("mcp_activate_tools requires a non-empty tool_names array");
    }
    const names = toolNames.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) throw new Error("mcp_activate_tools requires at least one non-empty tool name");
    const settings = this.settingsProvider();
    const lazyUrls = new Set(uniqueUrls(settings.lazyUrls));
    const disabledUrls = new Set(uniqueUrls(settings.disabledUrls));
    const baseUrl = uniqueUrls(settings.baseUrls).find(
      (url) => endpointKey(url) === endpointKeyValue && lazyUrls.has(url) && !disabledUrls.has(url)
    );
    if (!baseUrl) throw new Error(`Lazy MCP endpoint not found: ${endpointKeyValue}`);

    const available = await this.getSession(baseUrl, settings.timeout).listTools();
    const availableNames = new Set(
      available.map((tool) => (typeof tool.name === "string" ? tool.name.trim() : "")).filter(Boolean)
    );
    const invalid = names.filter((name) => !availableNames.has(name));
    if (invalid.length > 0) throw new Error(`MCP tools not found: ${invalid.join(", ")}`);
    selection.activate(endpointKeyValue, names);
    return `Activated ${names.length} MCP tool(s) from ${baseUrl}. They will be available in the next reasoning round.`;
  }

  async callTool(toolName: string, arguments_: Record<string, unknown>): Promise<string> {
    if (!this.bindings.has(toolName)) await this.discoverTools(true);
    const binding = this.bindings.get(toolName);
    if (!binding) throw new Error(`MCP tool is no longer available: ${toolName}`);
    return binding.endpoint.callTool(binding.actualName, arguments_);
  }

  private getSession(baseUrl: string, timeoutSeconds: number): McpEndpointSession {
    const existing = this.sessions.get(baseUrl);
    if (existing) return existing;
    const session = new McpEndpointSession(baseUrl, timeoutSeconds * 1000);
    this.sessions.set(baseUrl, session);
    return session;
  }
}

let sharedClient: McpClient | undefined;

export function getMcpClient(): McpClient {
  sharedClient ||= new McpClient();
  return sharedClient;
}

function parseMcpResponse(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("MCP returned an empty response");
  try {
    return JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      const data = line.trim().startsWith("data:")
        ? line.trim().slice("data:".length).trim()
        : "";
      if (!data || data === "[DONE]") continue;
      try {
        return JSON.parse(data) as JsonRpcResponse;
      } catch {
        // Continue through SSE frames until a JSON-RPC frame is found.
      }
    }
  }
  throw new Error("MCP response was not valid JSON or SSE");
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

function uniqueUrls(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().replace(/\/+$/, ""))
        .filter(Boolean)
    )
  );
}

function endpointKey(baseUrl: string): string {
  const readable = baseUrl
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 14);
  const digest = createHash("sha1").update(baseUrl).digest("hex").slice(0, 8);
  return `${readable || "server"}_${digest}`;
}

function scopedToolName(baseUrl: string, toolName: string): string {
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "tool";
  return `mcp_${endpointKey(baseUrl)}__${safeName}`;
}
