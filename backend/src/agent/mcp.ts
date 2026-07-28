import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  getMcpSettings,
  type McpRuntimeSettings,
  type McpServerConfig,
} from "../config.js";
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
  latencyMs?: number;
  attempts?: number;
  lastCheckedAt?: number;
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
  id?: number;
  result?: {
    tools?: McpRawTool[];
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
  };
  error?: unknown;
}

interface RuntimeMcpServer {
  key: string;
  endpoint: string;
  config: McpServerConfig;
  lazy: boolean;
  disabled: boolean;
}

class McpEndpointSession {
  private sessionId: string | undefined;
  private initialized = false;
  private requestId = 0;
  private lastLatencyMs = 0;
  private lastAttempts = 0;
  private lastCheckedAt = 0;
  private stdioProcess: ChildProcessWithoutNullStreams | undefined;
  private stdioBuffer = "";
  private stdioError = "";
  private readonly stdioPending = new Map<
    number,
    { resolve: (response: JsonRpcResponse) => void; reject: (error: Error) => void }
  >();

  constructor(
    public readonly server: RuntimeMcpServer,
    private readonly timeoutMs: number,
    private readonly connectTimeoutMs: number
  ) {}

  get baseUrl(): string {
    return this.server.endpoint;
  }

  get health(): { latencyMs: number; attempts: number; lastCheckedAt: number } {
    return {
      latencyMs: this.lastLatencyMs,
      attempts: this.lastAttempts,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  async listTools(): Promise<McpRawTool[]> {
    const initializationHealth = await this.ensureInitialized();
    const response = await this.request("tools/list", {}, this.timeoutMs, true);
    if (response.error) {
      throw new Error(`MCP tools/list error: ${JSON.stringify(response.error)}`);
    }
    if (initializationHealth.attempts > 0) {
      this.lastLatencyMs += initializationHealth.latencyMs;
      this.lastAttempts += initializationHealth.attempts;
    }
    return Array.isArray(response.result?.tools) ? response.result.tools : [];
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    await this.ensureInitialized(signal);
    const response = await this.request(
      "tools/call",
      { name, arguments: arguments_ },
      this.timeoutMs,
      false,
      signal
    );
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

  private async ensureInitialized(signal?: AbortSignal): Promise<{ latencyMs: number; attempts: number }> {
    if (this.initialized) return { latencyMs: 0, attempts: 0 };

    const response = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: MCP_CLIENT_NAME,
        version: MCP_CLIENT_VERSION,
      },
    }, this.connectTimeoutMs, true, signal);
    if (response.error) {
      throw new Error(`MCP initialize error: ${JSON.stringify(response.error)}`);
    }
    this.initialized = true;
    if (this.server.config.transport === "stdio") {
      this.writeStdio({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    }
    return { latencyMs: this.lastLatencyMs, attempts: this.lastAttempts };
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    retryable: boolean,
    externalSignal?: AbortSignal
  ): Promise<JsonRpcResponse> {
    if (this.server.config.transport === "stdio") {
      return this.requestStdio(method, params, timeoutMs, externalSignal);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.server.config.headers || {}),
    };
    if (this.server.config.oauthTokenEnv) {
      const token = process.env[this.server.config.oauthTokenEnv];
      if (!token) {
        throw new Error(
          `MCP OAuth token environment variable is not set: ${this.server.config.oauthTokenEnv}`
        );
      }
      headers.Authorization = `Bearer ${token}`;
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const maxAttempts = retryable ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(this.server.config.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++this.requestId,
            method,
            params,
          }),
          signal: externalSignal
            ? AbortSignal.any([controller.signal, externalSignal])
            : controller.signal,
        });

        const sessionId = response.headers.get("mcp-session-id")?.trim();
        if (sessionId) this.sessionId = sessionId;

        const body = await response.text();
        if (!response.ok) {
          const error = new Error(`MCP request failed (${response.status}): ${body.slice(0, 500)}`);
          if (retryable && attempt < maxAttempts && isRetryableStatus(response.status)) {
            lastError = error;
            await delay(150 * 2 ** (attempt - 1));
            continue;
          }
          throw error;
        }
        this.lastLatencyMs = Date.now() - startedAt;
        this.lastAttempts = attempt;
        this.lastCheckedAt = Date.now();
        return parseMcpResponse(body);
      } catch (error) {
        lastError = error;
        if (retryable && attempt < maxAttempts && isRetryableNetworkError(error)) {
          await delay(150 * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("MCP request failed");
  }

  dispose(): void {
    this.initialized = false;
    const process = this.stdioProcess;
    this.stdioProcess = undefined;
    if (process && !process.killed) process.kill();
    this.rejectStdioPending(new Error("MCP stdio session closed"));
  }

  private requestStdio(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    externalSignal?: AbortSignal
  ): Promise<JsonRpcResponse> {
    const id = ++this.requestId;
    const startedAt = Date.now();
    this.ensureStdioProcess();
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", onAbort);
        this.stdioPending.delete(id);
        callback();
      };
      const timeout = setTimeout(
        () => finish(() => reject(new Error(`MCP stdio request timed out after ${timeoutMs}ms`))),
        timeoutMs
      );
      const onAbort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
      externalSignal?.addEventListener("abort", onAbort, { once: true });
      this.stdioPending.set(id, {
        resolve: (response) => finish(() => {
          this.lastLatencyMs = Date.now() - startedAt;
          this.lastAttempts = 1;
          this.lastCheckedAt = Date.now();
          resolve(response);
        }),
        reject: (error) => finish(() => reject(error)),
      });
      try {
        this.writeStdio({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  private ensureStdioProcess(): void {
    if (this.stdioProcess && !this.stdioProcess.killed) return;
    if (this.server.config.transport !== "stdio") {
      throw new Error("Cannot start stdio transport for a remote MCP server");
    }
    this.stdioBuffer = "";
    this.stdioError = "";
    const child = spawn(this.server.config.command, this.server.config.args || [], {
      env: { ...process.env, ...(this.server.config.env || {}) },
      stdio: "pipe",
    });
    this.stdioProcess = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdioOutput(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stdioError = `${this.stdioError}${chunk}`.slice(-1000);
    });
    child.once("error", (error) => {
      this.initialized = false;
      this.stdioProcess = undefined;
      this.rejectStdioPending(error);
    });
    child.once("exit", (code, signal) => {
      this.initialized = false;
      if (this.stdioProcess === child) this.stdioProcess = undefined;
      const detail = this.stdioError.trim();
      this.rejectStdioPending(
        new Error(
          `MCP stdio server exited (${signal || (code ?? "unknown")})${detail ? `: ${detail}` : ""}`
        )
      );
    });
  }

  private writeStdio(payload: Record<string, unknown>): void {
    this.ensureStdioProcess();
    if (!this.stdioProcess?.stdin.writable) throw new Error("MCP stdio stdin is not writable");
    this.stdioProcess.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private consumeStdioOutput(chunk: string): void {
    this.stdioBuffer += chunk;
    for (;;) {
      const newline = this.stdioBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdioBuffer.slice(0, newline).trim();
      this.stdioBuffer = this.stdioBuffer.slice(newline + 1);
      if (!line) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof response.id !== "number") continue;
      this.stdioPending.get(response.id)?.resolve(response);
    }
  }

  private rejectStdioPending(error: Error): void {
    const pending = [...this.stdioPending.values()];
    this.stdioPending.clear();
    for (const request of pending) request.reject(error);
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
    const configuredServers = runtimeServers(settings);
    const activeServers = configuredServers.filter((server) => !server.disabled);
    const cacheKey = JSON.stringify({
      ...settings,
      servers: activeServers.map((server) => server.config),
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
      for (const session of this.sessions.values()) session.dispose();
      this.sessions.clear();
    }
    this.cacheKey = cacheKey;
    const activeKeys = new Set(activeServers.map((server) => server.key));
    for (const [key, session] of this.sessions) {
      if (!activeKeys.has(key)) {
        session.dispose();
        this.sessions.delete(key);
      }
    }
    this.bindings.clear();

    const tools: OpenAIToolDef[] = [];
    const serverPreviews: McpServerPreview[] = [];
    for (const server of activeServers) {
      const session = this.getSession(server, settings.timeout, settings.connectTimeout);
      const endpointKeyValue = endpointKey(server.key);
      try {
        const rawTools = await session.listTools();
        const previewTools: Array<{ name: string; description: string }> = [];
        const hideUnactivated =
          server.lazy && !selection.isEndpointActivated(endpointKeyValue);
        for (const rawTool of rawTools) {
          const actualName = typeof rawTool.name === "string" ? rawTool.name.trim() : "";
          if (!actualName) continue;
          const description =
            typeof rawTool.description === "string" ? rawTool.description.trim() : "";
          if (
            hideUnactivated ||
            (server.lazy && !selection.isToolActivated(endpointKeyValue, actualName))
          ) {
            previewTools.push({ name: actualName, description });
            continue;
          }
          const fullName = scopedToolName(server.key, actualName);
          const parameters = normalizeInputSchema(rawTool.inputSchema);
          tools.push({
            type: "function",
            function: {
              name: fullName,
              description: `[MCP ${server.endpoint}] ${description}`.trim(),
              parameters,
            },
          });
          this.bindings.set(fullName, { endpoint: session, actualName });
          previewTools.push({ name: actualName, description });
        }
        serverPreviews.push({
          endpoint: server.endpoint,
          endpointKey: endpointKeyValue,
          ok: true,
          toolCount: previewTools.length,
          tools: previewTools,
          ...session.health,
        });
      } catch (error) {
        serverPreviews.push({
          endpoint: server.endpoint,
          endpointKey: endpointKeyValue,
          ok: false,
          toolCount: 0,
          tools: [],
          ...session.health,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.cachedDiscovery = {
      tools,
      servers: serverPreviews,
      hasLazyEndpoints: activeServers.some((server) => server.lazy),
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
    const candidates: McpLazyToolCandidate[] = [];

    for (const server of runtimeServers(settings)) {
      if (!server.lazy || server.disabled) continue;
      const key = endpointKey(server.key);
      if (endpointFilter && endpointFilter !== key) continue;
      try {
        const tools = await this.getSession(server, settings.timeout, settings.connectTimeout).listTools();
        for (const tool of tools) {
          const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
          const description = typeof tool.description === "string" ? tool.description.trim() : "";
          if (!toolName) continue;
          if (!`${server.endpoint} ${toolName} ${description}`.toLowerCase().includes(normalizedQuery)) continue;
          candidates.push({ endpoint: server.endpoint, endpointKey: key, toolName, description });
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
    const server = runtimeServers(settings).find(
      (candidate) => endpointKey(candidate.key) === endpointKeyValue && candidate.lazy && !candidate.disabled
    );
    if (!server) throw new Error(`Lazy MCP endpoint not found: ${endpointKeyValue}`);

    const available = await this.getSession(server, settings.timeout, settings.connectTimeout).listTools();
    const availableNames = new Set(
      available.map((tool) => (typeof tool.name === "string" ? tool.name.trim() : "")).filter(Boolean)
    );
    const invalid = names.filter((name) => !availableNames.has(name));
    if (invalid.length > 0) throw new Error(`MCP tools not found: ${invalid.join(", ")}`);
    selection.activate(endpointKeyValue, names);
    return `Activated ${names.length} MCP tool(s) from ${server.endpoint}. They will be available in the next reasoning round.`;
  }

  async callTool(
    toolName: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.bindings.has(toolName)) await this.discoverTools(true);
    const binding = this.bindings.get(toolName);
    if (!binding) throw new Error(`MCP tool is no longer available: ${toolName}`);
    return binding.endpoint.callTool(binding.actualName, arguments_, signal);
  }

  private getSession(
    server: RuntimeMcpServer,
    timeoutSeconds: number,
    connectTimeoutSeconds: number
  ): McpEndpointSession {
    const existing = this.sessions.get(server.key);
    if (existing) return existing;
    const session = new McpEndpointSession(
      server,
      timeoutSeconds * 1000,
      connectTimeoutSeconds * 1000
    );
    this.sessions.set(server.key, session);
    return session;
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.bindings.clear();
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

function runtimeServers(settings: McpRuntimeSettings): RuntimeMcpServer[] {
  const lazyUrls = new Set(uniqueUrls(settings.lazyUrls));
  const disabledUrls = new Set(uniqueUrls(settings.disabledUrls));
  const advancedServers = settings.servers || [];
  const advancedRemoteUrls = new Set(
    advancedServers
      .filter((server): server is Extract<McpServerConfig, { transport: "remote" }> =>
        server.transport === "remote"
      )
      .map((server) => server.url)
  );
  const servers: RuntimeMcpServer[] = uniqueUrls(settings.baseUrls)
    .filter((url) => !advancedRemoteUrls.has(url))
    .map((url) => ({
    key: `remote:${url}`,
    endpoint: url,
    config: { id: endpointKey(url), transport: "remote", url },
    lazy: lazyUrls.has(url),
    disabled: disabledUrls.has(url),
  }));
  for (const config of advancedServers) {
    servers.push({
      key: `server:${config.id}`,
      endpoint: config.transport === "remote" ? config.url : `stdio:${config.id}`,
      config,
      lazy: config.lazy === true,
      disabled: config.disabled === true,
    });
  }
  return servers;
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

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return error.name === "AbortError" || /fetch|network|timeout|socket|ECONN/i.test(error.message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
