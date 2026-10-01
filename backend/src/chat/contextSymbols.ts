import { searchWorkspace } from "../files/workspaceSearch.js";
import { readAuthorizedWorkspaceFile } from "../agent/contextPolicy.js";
import { indexLanguageFile } from "../indexing/languageAdapters.js";
import { buildFileVersion } from "../files/mutationRegistry.js";
import type { RepositoryRange } from "../indexing/types.js";

export interface ContextSymbolCandidate {
  kind: "symbol";
  path: string;
  symbol: string;
  range: RepositoryRange;
  version: string;
}

/** Reuse the repository index's language adapters on bounded, live, authorized candidates. */
export async function searchContextSymbols(workspaceDir: string, query: string, signal?: AbortSignal): Promise<{ symbols: ContextSymbolCandidate[]; truncated: boolean }> {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 128 || !/^[\w$]+$/.test(normalized)) return { symbols: [], truncated: false };
  const matches = await searchWorkspace({ workspaceDir, query: normalized, maxResults: 200, signal });
  const paths = [...new Set(matches.results.map((entry) => entry.path))];
  const symbols: ContextSymbolCandidate[] = [];
  let bytes = 0;
  let truncated = matches.truncated || paths.length > 40;
  for (const filePath of paths.slice(0, 40)) {
    signal?.throwIfAborted();
    try {
      const file = readAuthorizedWorkspaceFile(workspaceDir, filePath, 256 * 1024);
      bytes += file.size;
      if (bytes > 2 * 1024 * 1024) { truncated = true; break; }
      for (const symbol of indexLanguageFile(file.path, file.content).symbols) {
        if (!symbol.name.toLowerCase().includes(normalized.toLowerCase())) continue;
        symbols.push({ kind: "symbol", path: file.path, symbol: symbol.name, range: symbol.range, version: buildFileVersion(file.content) });
        if (symbols.length >= 30) return { symbols, truncated: true };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Ignore generated, secret, symlink and oversized search hits.
    }
  }
  return { symbols, truncated };
}
