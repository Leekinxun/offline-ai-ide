import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http, { type Server } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { safePath } from "../utils/safePath.js";
import { discoverRunTasks } from "./service.js";
import { pollProcessSession, startPreviewProcessSession, stopProcessSession, type ProcessSessionOwner } from "./processSessions.js";

export interface PreviewTarget { id: string; label: string; kind: "vite" | "static"; taskId?: string; }
export interface PreviewSummary { id: string; targetId: string; label: string; kind: "vite" | "static"; status: "starting" | "ready" | "failed" | "stopped" | "interrupted"; processSessionId?: string; createdAt: number; error?: string; }
export interface PreviewInstance extends PreviewSummary { owner: ProcessSessionOwner; ticket: string; expiresAt: number; port?: number; proof: string; server?: Server; sockets: Set<import("node:stream").Duplex>; timer?: NodeJS.Timeout; }
const previews = new Map<string, PreviewInstance>();
const compilerPath = createRequire(import.meta.url).resolve("typescript");
export const PREVIEW_TICKET_MS = 5 * 60_000;
const publicSummary = ({ owner: _owner, ticket: _ticket, expiresAt: _expires, port: _port, proof: _proof, server: _server, sockets: _sockets, timer: _timer, ...record }: PreviewInstance): PreviewSummary => record;
function previewStore(owner: ProcessSessionOwner, id?: string): string {
  if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid preview id");
  const relative = `.history/previews${id ? `/${id}.json` : ""}`;
  const target = safePath(relative, owner.workspaceDir);
  let cursor = path.resolve(owner.workspaceDir);
  for (const part of relative.split("/")) { cursor = path.join(cursor, part); try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Unsafe preview storage"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; } }
  return target;
}
function persistPreview(item: PreviewInstance): void {
  const target = previewStore(item.owner, item.id); fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...publicSummary(item), ownerHash: crypto.createHash("sha256").update(item.owner.owner).digest("hex"), workspaceDir: path.resolve(item.owner.workspaceDir) }), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target);
}
function sameOwner(a: ProcessSessionOwner, b: ProcessSessionOwner): boolean { return path.resolve(a.workspaceDir) === path.resolve(b.workspaceDir) && a.owner === b.owner; }
function get(owner: ProcessSessionOwner, id: string): PreviewInstance {
  let item = previews.get(id);
  if (!item) {
    try {
      const target = previewStore(owner, id); if (fs.statSync(target).size > 16_384) throw new Error("Invalid preview metadata");
      const stored = JSON.parse(fs.readFileSync(target, "utf8"));
      if (stored.id !== id || stored.workspaceDir !== path.resolve(owner.workspaceDir) || stored.ownerHash !== crypto.createHash("sha256").update(owner.owner).digest("hex")) throw new Error("Preview not found");
      const { ownerHash: _hash, workspaceDir: _dir, ...record } = stored;
      item = { ...record, status: ["ready", "starting"].includes(record.status) ? "interrupted" : record.status, owner: { ...owner }, ticket: "", proof: "", expiresAt: 0, sockets: new Set() } as PreviewInstance;
      previews.set(id, item); persistPreview(item);
    } catch { throw new Error("Preview not found"); }
  }
  if (!item || !sameOwner(item.owner, owner)) throw new Error("Preview not found");
  if (item.processSessionId && item.status === "ready" && pollProcessSession(owner, item.processSessionId).session.status !== "running") { item.status = "interrupted"; item.expiresAt = 0; }
  return item;
}
function localVite(workspace: string): string | undefined {
  try { const require = createRequire(path.join(workspace, "package.json")); const root = path.dirname(require.resolve("vite/package.json")); const entry = path.join(root, "dist/node/index.js"); return fs.statSync(entry).isFile() ? entry : undefined; } catch { return undefined; }
}
export function discoverPreviewTargets(workspace: string): PreviewTarget[] {
  const targets: PreviewTarget[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(safePath("package.json", workspace), "utf8"));
    if (localVite(workspace)) for (const task of discoverRunTasks(workspace)) {
      const command = manifest.scripts?.[task.id.slice(4)];
      // Preview owns host/port/base. Arbitrary shell wrappers and configured proxies are excluded.
      if (task.kind === "run" && typeof command === "string" && /^vite(?:\s+(?:--host(?:\s+[\w.:-]+)?|--open|--strictPort|--port\s+\d+))*\s*$/.test(command)) targets.push({ id: `vite:${task.id}`, label: `Web preview · ${task.label}`, kind: "vite", taskId: task.id });
    }
  } catch { /* no package */ }
  try { const file = safePath("index.html", workspace); if (fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()) targets.push({ id: "static:index.html", label: "Static HTML preview", kind: "static" }); } catch { /* no entry */ }
  return targets;
}
export function listPreviews(owner: ProcessSessionOwner): PreviewSummary[] {
  const directory = previewStore(owner);
  const ids = new Set([...previews.values()].filter((item) => sameOwner(item.owner, owner)).map((item) => item.id));
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) if (/^[a-f0-9-]{36}\.json$/.test(name)) ids.add(name.slice(0, -5));
  return [...ids].flatMap((id) => { try { return [publicSummary(get(owner, id))]; } catch { return []; } }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
}
export function previewStatus(owner: ProcessSessionOwner, id: string): PreviewSummary { return publicSummary(get(owner, id)); }
export function previewBase(item: Pick<PreviewInstance, "id" | "ticket">): string { return `/preview/${item.id}/${item.ticket}/`; }
/** The dev server's routing prefix is stable across public ticket rotations. */
export function previewUpstreamBase(item: Pick<PreviewInstance, "id">): string { return `/__crewforge_preview__/${item.id}/`; }

/** Shared before either static serving or forwarding to Vite. Never accepts an absolute target URL. */
export function validatePreviewPath(raw: string, workspace: string): { pathname: string; search: string; relative: string } {
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f]/.test(raw)) throw new Error("Invalid preview path");
  const [rawPath, ...query] = raw.split("?");
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { throw new Error("Invalid preview encoding"); }
  if (/%|\\|[\u0000-\u001f]/.test(decoded) || decoded.startsWith("//")) throw new Error("Invalid preview encoding");
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) throw new Error("Preview path traversal denied");
  const relative = segments.join("/");
  if (segments.some((segment, index) => (segment.startsWith(".") && !(segment === ".vite" && segments[index - 1] === "node_modules")) || /^(?:node_modules)?(?:\.env.*|\.git|\.history|\.checkpoints|\.crewforge|\.ssh)$/i.test(segment))) throw new Error("Protected preview path");
  if (decoded.startsWith("/@fs/") || /(?:^|\/)(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|.*(?:secret|credential|private[-_]?key).*|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i.test(decoded)) throw new Error("Protected preview path");
  if (!decoded.startsWith("/@vite/") && !decoded.startsWith("/@id/") && decoded !== "/@react-refresh") {
    // Vite also serves public/ at the URL root, so check both candidate locations.
    for (const candidate of [relative || "index.html", `public/${relative || "index.html"}`]) {
      const target = safePath(candidate, workspace);
      let cursor = path.resolve(workspace);
      for (const segment of path.relative(cursor, target).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Preview cannot serve symbolic links"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
      }
    }
  }
  return { pathname: decoded, search: query.length ? `?${query.join("?")}` : "", relative };
}
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json" };
function staticServer(item: PreviewInstance): Server {
  return http.createServer((req, res) => {
    if (req.headers["x-crewforge-preview-proof"] !== item.proof) { res.writeHead(403).end(); return; }
    res.setHeader("x-crewforge-preview-proof", item.proof);
    try {
      const { relative } = validatePreviewPath(req.url || "/", item.owner.workspaceDir);
      const file = safePath(relative || "index.html", item.owner.workspaceDir);
      const stat = fs.lstatSync(file); const mime = MIME[path.extname(file).toLowerCase()];
      if (!stat.isFile() || stat.isSymbolicLink() || !mime || stat.size > 16 * 1024 * 1024) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", mime);
      fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
}
export async function startPreview(owner: ProcessSessionOwner, targetId: string): Promise<PreviewSummary> {
  const target = discoverPreviewTargets(owner.workspaceDir).find((entry) => entry.id === targetId);
  if (!target) throw new Error("Unknown or unavailable preview target");
  if (listPreviews(owner).filter((entry) => entry.status === "ready" || entry.status === "starting").length >= 3) throw new Error("Too many active previews");
  const item: PreviewInstance = { ...target, id: crypto.randomUUID(), targetId, status: "starting", createdAt: Date.now(), owner: { ...owner }, ticket: crypto.randomBytes(32).toString("hex"), proof: crypto.randomBytes(32).toString("hex"), expiresAt: 0, sockets: new Set() };
  previews.set(item.id, item);
  persistPreview(item);
  if (target.kind === "static") {
    item.server = staticServer(item);
    item.server.on("connection", (socket) => { item.sockets.add(socket); socket.on("close", () => item.sockets.delete(socket)); });
    try {
      await new Promise<void>((resolve, reject) => { item.server!.once("error", reject); item.server!.listen(0, "127.0.0.1", resolve); });
      const address = item.server.address(); if (!address || typeof address === "string") throw new Error("Preview listener failed");
      item.port = address.port; item.status = "ready";
    } catch { item.status = "failed"; item.error = "Static preview could not start"; }
  } else {
    const entry = localVite(owner.workspaceDir)!;
    const config = { root: fs.realpathSync(path.resolve(owner.workspaceDir)), base: previewUpstreamBase(item), proof: item.proof, id: item.id };
    const script = `
      import { createServer } from ${JSON.stringify(pathToFileURL(entry).href)};
      import { createRequire } from "node:module";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import crypto from "node:crypto";
      import net from "node:net";
      import ts from ${JSON.stringify(pathToFileURL(compilerPath).href)};
      const c = ${JSON.stringify(config)};
      const require = createRequire(path.join(c.root, "package.json"));
      const plugins = [];
      plugins.push({ name: "crewforge-source-locations", enforce: "pre", transform(code,id) {
        const clean = id.split("?")[0];
        const relative = path.relative(c.root, clean).split(path.sep).join("/");
        if (!/\\.[jt]sx$/.test(clean) || relative.startsWith("../") || path.isAbsolute(relative) || relative.split("/").includes("node_modules")) return;
        const source = ts.createSourceFile(clean, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const contentHash=crypto.createHash("sha256").update(code).digest("hex");
        const edits=[];
        function visit(node) {
          if ((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)) && /^[a-z]/.test(node.tagName.getText(source)) && !node.attributes.properties.some(p=>p.name?.getText(source)==="data-crewforge-source")) {
            const pos=source.getLineAndCharacterOfPosition(node.getStart(source));
            const candidate={path:relative,line:pos.line+1,column:pos.character+1,contentHash};
            candidate.signature=crypto.createHmac("sha256",c.proof).update(JSON.stringify([candidate.path,candidate.line,candidate.column,contentHash])).digest("hex");
            edits.push({offset:node.attributes.end,text:" data-crewforge-source={"+JSON.stringify(JSON.stringify(candidate))+"}"});
          }
          ts.forEachChild(node,visit);
        }
        visit(source);
        if(!edits.length)return;
        for(const edit of edits.sort((a,b)=>b.offset-a.offset))code=code.slice(0,edit.offset)+edit.text+code.slice(edit.offset);
        return {code,map:null};
      }});
      try { const entry = require.resolve("@vitejs/plugin-vue"); const p = await import(pathToFileURL(entry).href); plugins.push(p.default()); } catch {}
      plugins.unshift({ name: "crewforge-preview-proof", configureServer(server) { server.middlewares.use((req,res,next) => {
        if (req.headers["x-crewforge-preview-proof"] !== c.proof) { res.statusCode=403; res.end(); return; }
        res.setHeader("x-crewforge-preview-proof", c.proof); next();
      }); } });
      const reservation=net.createServer();
      await new Promise((resolve,reject)=>{reservation.once("error",reject);reservation.listen(0,"127.0.0.1",resolve)});
      const port=reservation.address().port;
      await new Promise(resolve=>reservation.close(resolve));
      const server = await createServer({ configFile: false, envFile: false, root: c.root, base: c.base, plugins,
        esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port, strictPort: true, open: false, cors: false,
          proxy: {}, fs: { strict: true, allow: [c.root], deny: [".env", ".env.*", "**/.git/**", "**/.history/**", "**/.checkpoints/**", "**/*.{crt,pem,key}"] } } });
      server.ws.on("connection",(client)=>client.send(JSON.stringify({type:"custom",event:"crewforge-preview-proof",data:c.proof})));
      await server.listen();
      const address=server.httpServer.address();
      console.log("CREWFORGE_PREVIEW_READY:" + c.id + ":" + address.port + ":" + c.proof);
      const close=async()=>{await server.close();process.exit(0);};
      process.on("SIGTERM",close); process.on("SIGINT",close);
    `;
    let output = "";
    try {
      const session = startPreviewProcessSession({ ...owner, executable: process.execPath, args: ["--input-type=module", "-e", script], targetId,
        onOutput: (event) => {
          output = (output + event.text).slice(-16_384);
          const match = output.match(new RegExp(`CREWFORGE_PREVIEW_READY:${item.id}:(\\d+):${item.proof}`));
          if (match && item.status === "starting") { const port = Number(match[1]); if (port > 0 && port <= 65535) { item.port = port; item.status = "ready"; if (item.timer) clearTimeout(item.timer); persistPreview(item); } }
        },
        onExit: () => { if (item.status !== "stopped" && item.status !== "failed") { item.status = item.status === "starting" ? "failed" : "interrupted"; item.error = "Preview process exited; inspect its process session output"; } item.expiresAt = 0; item.sockets.forEach((socket) => socket.destroy()); try { persistPreview(item); } catch { /* workspace removed */ } },
      });
      item.processSessionId = session.id;
      item.timer = setTimeout(() => { if (item.status === "starting") { stopProcessSession(owner, session.id); item.status = "failed"; item.error = "Preview did not become ready within 30 seconds"; } }, 30_000); item.timer.unref();
    } catch { item.status = "failed"; item.error = "Vite preview could not start"; }
  }
  try { persistPreview(item); } catch { /* stopping remains possible after workspace removal */ }
  return publicSummary(item);
}
export function issuePreviewTicket(owner: ProcessSessionOwner, id: string, existingTicket?: string): { url: string; ticket: string; expiresAt: number; renewed: boolean } {
  const item = get(owner, id);
  if (item.status !== "ready") throw new Error("Preview is not ready");
  const now = Date.now();
  const matchingTicket = existingTicket === undefined || (typeof existingTicket === "string" && /^[a-f0-9]{64}$/.test(existingTicket)
    && existingTicket.length === item.ticket.length
    && crypto.timingSafeEqual(Buffer.from(existingTicket), Buffer.from(item.ticket)));
  // Authenticated no-body reads are idempotent across StrictMode and same-owner tabs.
  const renewed = matchingTicket && item.expiresAt > now;
  if (!renewed) item.ticket = crypto.randomBytes(32).toString("hex");
  item.expiresAt = now + PREVIEW_TICKET_MS;
  return { url: previewBase(item), ticket: item.ticket, expiresAt: item.expiresAt, renewed };
}
export function verifyPreviewSource(owner: ProcessSessionOwner, id: string, value: unknown): { path: string; line: number; column: number; verified: true } {
  const item = get(owner, id);
  const candidate = value as { path?: unknown; line?: unknown; column?: unknown; contentHash?: unknown; signature?: unknown };
  if (!candidate || typeof candidate.path !== "string" || !Number.isSafeInteger(candidate.line) || Number(candidate.line) < 1 || !Number.isSafeInteger(candidate.column) || Number(candidate.column) < 1 || typeof candidate.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.contentHash) || typeof candidate.signature !== "string" || !/^[a-f0-9]{64}$/.test(candidate.signature) || !item.proof) throw new Error("Unverified preview source");
  validatePreviewPath(`/${candidate.path}`, owner.workspaceDir);
  const signature = crypto.createHmac("sha256", item.proof).update(JSON.stringify([candidate.path, candidate.line, candidate.column, candidate.contentHash])).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(candidate.signature))) throw new Error("Unverified preview source");
  const target = safePath(candidate.path, owner.workspaceDir);
  if (fs.statSync(target).size > 2 * 1024 * 1024 || crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== candidate.contentHash) throw new Error("Preview source changed; reload before locating the element");
  return { path: candidate.path, line: Number(candidate.line), column: Number(candidate.column), verified: true };
}
export function resolvePreviewTicket(id: string, ticket: string): PreviewInstance | undefined {
  const item = previews.get(id);
  if (!item || ticket.length !== item.ticket.length || !crypto.timingSafeEqual(Buffer.from(ticket), Buffer.from(item.ticket)) || item.expiresAt <= Date.now()) return undefined;
  try { return get(item.owner, id).status === "ready" ? item : undefined; } catch { return undefined; }
}
export function stopPreview(owner: ProcessSessionOwner, id: string): PreviewSummary {
  const item = get(owner, id); item.status = "stopped"; item.expiresAt = 0;
  if (item.timer) clearTimeout(item.timer);
  if (item.processSessionId) stopProcessSession(owner, item.processSessionId);
  item.sockets.forEach((socket) => socket.destroy()); item.server?.close();
  try { persistPreview(item); } catch { /* stopping remains possible after workspace removal */ }
  return publicSummary(item);
}
export function stopPreviewsForToken(token: string): void { for (const item of previews.values()) if (item.owner.sessionToken === token) { try { stopPreview(item.owner, item.id); } catch { item.expiresAt = 0; item.sockets.forEach((socket) => socket.destroy()); } } }
export function shutdownPreviews(): void { for (const item of previews.values()) { try { stopPreview(item.owner, item.id); } catch { item.expiresAt = 0; item.sockets.forEach((socket) => socket.destroy()); } } }
