import { spawn } from "node:child_process";
import path from "node:path";

export interface PythonSemanticRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface PythonSemanticLocation {
  path: string;
  selection: PythonSemanticRange;
}

interface PythonBridgeResponse {
  available?: boolean;
  definitions?: Array<{ path: string; line: number; column: number; length: number }>;
  references?: Array<{ path: string; line: number; column: number; length: number }>;
}

const PYTHON_BRIDGE = String.raw`
import json, os, re, sys

request = json.load(sys.stdin)
try:
    import jedi
except Exception:
    print(json.dumps({"available": False}))
    raise SystemExit(0)

root = os.path.realpath(request["root"])
relative = request["path"].replace("\\\\", "/").lstrip("/")
target = os.path.realpath(os.path.join(root, relative))
if not (target == root or target.startswith(root + os.sep)):
    print(json.dumps({"available": True, "definitions": [], "references": []}))
    raise SystemExit(0)

try:
    source = open(target, "r", encoding="utf-8").read()
except Exception:
    print(json.dumps({"available": True, "definitions": [], "references": []}))
    raise SystemExit(0)

symbol = request["symbol"]
locations = [match.start() for match in re.finditer(r"(?<![A-Za-z0-9_])" + re.escape(symbol) + r"(?![A-Za-z0-9_])", source)]
project = jedi.Project(path=root)
script = jedi.Script(code=source, path=target, project=project)

def line_column(offset):
    before = source[:offset]
    return before.count("\\n") + 1, offset - (before.rfind("\\n") + 1)

def location(name):
    module_path = getattr(name, "module_path", None)
    line = getattr(name, "line", None)
    column = getattr(name, "column", None)
    if not module_path or not line or column is None:
        return None
    resolved = os.path.realpath(str(module_path))
    if not (resolved == root or resolved.startswith(root + os.sep)):
        return None
    return {"path": os.path.relpath(resolved, root).replace(os.sep, "/"), "line": int(line), "column": int(column), "length": len(symbol)}

definitions = []
references = []
for offset in locations:
    line, column = line_column(offset)
    try:
        definitions.extend(filter(None, (location(item) for item in script.goto(line, column, follow_imports=True, follow_builtin_imports=False))))
        references.extend(filter(None, (location(item) for item in script.get_references(line, column))))
    except Exception:
        continue

def unique(items):
    result, seen = [], set()
    for item in items:
        key = (item["path"], item["line"], item["column"])
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result

print(json.dumps({"available": True, "definitions": unique(definitions), "references": unique(references)}))
`;

function validRelativePath(root: string, value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = path.resolve(root, normalized);
  const canonicalRoot = path.resolve(root);
  return resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}${path.sep}`) ? normalized : null;
}

function toLocation(root: string, item: { path: string; line: number; column: number; length: number }): PythonSemanticLocation | null {
  const relative = validRelativePath(root, item.path);
  if (!relative || !Number.isInteger(item.line) || !Number.isInteger(item.column)) return null;
  return {
    path: relative,
    selection: {
      startLine: item.line,
      startColumn: item.column + 1,
      endLine: item.line,
      endColumn: item.column + item.length + 1,
    },
  };
}

async function queryPython(root: string, currentPath: string | undefined, symbol: string): Promise<PythonBridgeResponse> {
  if (!currentPath || path.extname(currentPath).toLowerCase() !== ".py") return {};
  const executable = process.env.PYTHON_EXECUTABLE || "python";
  return await new Promise((resolve) => {
    const child = spawn(executable, ["-c", PYTHON_BRIDGE], {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (value: PythonBridgeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({});
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk;
    });
    child.once("error", () => finish({}));
    child.once("close", () => {
      try { finish(JSON.parse(stdout.trim() || "{}") as PythonBridgeResponse); } catch { finish({}); }
    });
    child.stdin.end(JSON.stringify({ root, path: currentPath, symbol }));
  });
}

export async function findPythonDefinition(workspaceDir: string, currentPath: string | undefined, symbol: string): Promise<PythonSemanticLocation | null> {
  const root = path.resolve(workspaceDir);
  const response = await queryPython(root, currentPath, symbol);
  for (const item of response.definitions || []) {
    const location = toLocation(root, item);
    if (location) return location;
  }
  return null;
}

export async function findPythonReferences(workspaceDir: string, currentPath: string | undefined, symbol: string): Promise<PythonSemanticLocation[]> {
  const root = path.resolve(workspaceDir);
  const response = await queryPython(root, currentPath, symbol);
  return (response.references || []).flatMap((item) => {
    const location = toLocation(root, item);
    return location ? [location] : [];
  });
}
