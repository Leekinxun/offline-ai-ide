import { spawn } from "child_process";
import path from "path";
import { rgPath } from "@vscode/ripgrep";
import { evaluateContextPath } from "../agent/contextPolicy.js";

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  column: number;
  matchLength: number;
  preview: string;
}

export interface WorkspaceSearchOptions {
  workspaceDir: string;
  query: string;
  scopePath?: string;
  isRegex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  include?: string;
  exclude?: string;
  useIgnoreFiles?: boolean;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface WorkspaceSearchResponse {
  results: WorkspaceSearchResult[];
  truncated: boolean;
}

interface RipgrepMatchEvent {
  type: "match";
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number?: number;
    submatches?: Array<{
      start: number;
      end: number;
    }>;
  };
}

export class WorkspaceSearchError extends Error {
  constructor(message: string, readonly code: "ABORTED" | "FAILED") {
    super(message);
    this.name = "WorkspaceSearchError";
  }
}

function splitGlobPatterns(value?: string): string[] {
  if (!value) return [];

  const patterns: string[] = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;

  for (const character of value) {
    if (character === "{") braceDepth += 1;
    if (character === "}" && braceDepth > 0) braceDepth -= 1;
    if (character === "[") bracketDepth += 1;
    if (character === "]" && bracketDepth > 0) bracketDepth -= 1;

    if (character === "," && braceDepth === 0 && bracketDepth === 0) {
      if (current.trim()) patterns.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) patterns.push(current.trim());
  return patterns;
}

function byteOffsetToColumn(text: string, byteOffset: number): number {
  return Buffer.from(text).subarray(0, byteOffset).toString("utf-8").length + 1;
}

function byteLengthBetween(text: string, start: number, end: number): number {
  return Buffer.from(text).subarray(start, end).toString("utf-8").length;
}

function normalizeResultPath(resultPath: string): string {
  return resultPath.replace(/^\.\//, "").split(path.sep).join("/");
}

function buildRipgrepArgs(options: WorkspaceSearchOptions): string[] {
  const args = [
    "--json",
    "--color=never",
    "--hidden",
    "--max-filesize=10M",
    "--glob=!.git",
    "--glob=!.svn",
    "--glob=!.hg",
  ];

  if (!options.isRegex) args.push("--fixed-strings");
  args.push(options.matchCase ? "--case-sensitive" : "--ignore-case");
  if (options.wholeWord) args.push("--word-regexp");
  if (options.useIgnoreFiles === false) args.push("--no-ignore");

  for (const pattern of splitGlobPatterns(options.include)) {
    args.push(`--glob=${pattern}`);
  }
  for (const pattern of splitGlobPatterns(options.exclude)) {
    args.push(`--glob=!${pattern.replace(/^!/, "")}`);
  }

  args.push("--", options.query, options.scopePath || ".");
  return args;
}

export function searchWorkspace(
  options: WorkspaceSearchOptions
): Promise<WorkspaceSearchResponse> {
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 1000, 5000));
  const results: WorkspaceSearchResult[] = [];
  let truncated = false;

  const buildResponse = (): WorkspaceSearchResponse => ({
    results: results.sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column
    ),
    truncated,
  });

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new WorkspaceSearchError("Search cancelled", "ABORTED"));
      return;
    }

    const child = spawn(rgPath, buildRipgrepArgs(options), {
      cwd: options.workspaceDir,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let finished = false;

    const finish = (
      outcome: { response: WorkspaceSearchResponse } | { error: WorkspaceSearchError }
    ) => {
      if (finished) return;
      finished = true;
      options.signal?.removeEventListener("abort", abortSearch);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.response);
    };

    const abortSearch = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abortSearch, { once: true });

    const consumeLine = (line: string) => {
      if (!line) return;
      let event: RipgrepMatchEvent;
      try {
        event = JSON.parse(line) as RipgrepMatchEvent;
      } catch {
        return;
      }
      if (event.type !== "match") return;
      if (results.length >= maxResults) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }

      const resultPath = event.data.path?.text;
      const lineText = event.data.lines?.text;
      const lineNumber = event.data.line_number;
      if (!resultPath || typeof lineText !== "string" || !lineNumber) return;
      const policy = evaluateContextPath(normalizeResultPath(resultPath));
      if (!policy.allowed) return;

      const preview = lineText.replace(/[\r\n]+$/, "").slice(0, 1000);
      for (const submatch of event.data.submatches || []) {
        if (results.length >= maxResults) {
          truncated = true;
          child.kill("SIGTERM");
          break;
        }
        results.push({
          path: policy.normalizedPath!,
          line: lineNumber,
          column: byteOffsetToColumn(lineText, submatch.start),
          matchLength: Math.max(1, byteLengthBetween(lineText, submatch.start, submatch.end)),
          preview,
        });
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        error: new WorkspaceSearchError(
          `Unable to start ripgrep: ${error.message}`,
          "FAILED"
        ),
      });
    });

    child.on("close", (code, signal) => {
      if (stdoutBuffer) consumeLine(stdoutBuffer);
      if (options.signal?.aborted) {
        finish({ error: new WorkspaceSearchError("Search cancelled", "ABORTED") });
        return;
      }
      if (truncated) {
        finish({ response: buildResponse() });
        return;
      }
      if (code === 0 || code === 1) {
        finish({ response: buildResponse() });
        return;
      }
      finish({
        error: new WorkspaceSearchError(
          stderr.trim() || `ripgrep exited with ${signal || code}`,
          "FAILED"
        ),
      });
    });
  });
}
