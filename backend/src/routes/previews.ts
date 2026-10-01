import { Router } from "express";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { sessionManager } from "../auth/sessionManager.js";
import { canWriteActiveWorkspace } from "../team/sessionBridge.js";
import { matchesWorkspaceHeader, processOwner } from "./processSessions.js";
import { discoverPreviewTargets, issuePreviewTicket, listPreviews, previewBase, previewUpstreamBase, previewStatus, resolvePreviewTicket, startPreview, stopPreview, validatePreviewPath, verifyPreviewSource, type PreviewInstance } from "../run/previewService.js";

export const previewsRouter = Router();
previewsRouter.use((req, res, next) => {
  if (!(req as any).userSession?.username) return res.status(401).json({ error: "Unauthorized" });
  if (!matchesWorkspaceHeader(req)) return res.status(409).json({ error: "Workspace changed; reload before continuing" });
  if (req.method !== "GET" && !canWriteActiveWorkspace((req as any).userSession)) return res.status(403).json({ error: "Workspace is read-only" });
  next();
});
function failure(res: any, error: unknown) { const message = error instanceof Error ? error.message : "Preview request failed"; res.status(message.includes("not found") ? 404 : message.includes("not ready") ? 409 : 400).json({ error: (error as NodeJS.ErrnoException)?.code ? "Preview request failed" : message }); }
previewsRouter.get("/", (req, res) => { try { const owner = processOwner(req); res.json({ targets: discoverPreviewTargets(owner.workspaceDir), previews: listPreviews(owner) }); } catch (error) { failure(res, error); } });
previewsRouter.post("/", async (req, res) => {
  if (typeof req.body?.targetId !== "string" || Object.keys(req.body).some((key) => key !== "targetId")) return res.status(400).json({ error: "Select a discovered preview target" });
  try { res.status(202).json({ preview: await startPreview(processOwner(req), req.body.targetId) }); } catch (error) { failure(res, error); }
});
previewsRouter.get("/:id", (req, res) => { try { res.json({ preview: previewStatus(processOwner(req), req.params.id) }); } catch (error) { failure(res, error); } });
previewsRouter.post("/:id/ticket", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body || {};
  if (Object.keys(body).some((key) => key !== "ticket") || (body.ticket !== undefined && (typeof body.ticket !== "string" || body.ticket.length > 256))) return res.status(400).json({ error: "Invalid preview ticket request" });
  try { res.json(issuePreviewTicket(processOwner(req), req.params.id, body.ticket)); } catch (error) { failure(res, error); }
});
previewsRouter.post("/:id/source", (req, res) => { try { res.json({ sourceCandidates: [verifyPreviewSource(processOwner(req), req.params.id, req.body?.candidate)] }); } catch (error) { failure(res, error); } });
previewsRouter.delete("/:id", (req, res) => { try { res.json({ preview: stopPreview(processOwner(req), req.params.id) }); } catch (error) { failure(res, error); } });

type OwnerValidator = (item: PreviewInstance) => boolean;
function validOwner(item: PreviewInstance): boolean {
  const session = sessionManager.getSession(item.owner.sessionToken, { touch: false });
  return Boolean(session && session.username === item.owner.owner && session.workspaceDir === item.owner.workspaceDir && canWriteActiveWorkspace(session));
}
function authorized(request: IncomingMessage, validateOwner: OwnerValidator): { item: PreviewInstance; ticket: string; rawPath: string } | undefined {
  const match = (request.url || "").match(/^\/preview\/([a-f0-9-]{36})\/([a-f0-9]{64})(\/[^#]*)?$/);
  if (!match) return;
  const item = resolvePreviewTicket(match[1], match[2]);
  if (!item || !validateOwner(item)) return;
  const origin = request.headers.origin;
  if (origin && origin !== "null") {
    try { if (new URL(origin).host !== request.headers.host) return; } catch { return; }
  }
  return { item, ticket: match[2], rawPath: match[3] || "/" };
}
function headers(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
}
function bridge(item: PreviewInstance, publicBase: string): string {
  return `<script>(()=>{const id=${JSON.stringify(item.id)};const send=(kind,data)=>parent.postMessage({type:"crewforge:preview-event",previewId:id,kind,...data},"*");const text=v=>{try{return typeof v==="string"?v:JSON.stringify(v)}catch{return String(v)}};const safeUrl=value=>{try{return new URL(value,location.href).pathname.replace(${JSON.stringify(publicBase)},"/")}catch{return ""}};addEventListener("error",e=>send("error",{message:e.message?String(e.message).slice(0,2000):"Resource failed: "+safeUrl(e.target?.src||e.target?.href||""),filename:safeUrl(e.filename||""),line:e.lineno}),true);const fetchOriginal=window.fetch;window.fetch=async(...args)=>{const response=await fetchOriginal.apply(window,args);if(!response.ok)send("error",{message:"HTTP "+response.status+" "+safeUrl(response.url)});return response};addEventListener("unhandledrejection",e=>send("error",{message:text(e.reason).slice(0,2000)}));const error=console.error;console.error=(...args)=>{send("console",{message:args.map(text).join(" ").slice(0,2000)});error.apply(console,args)};let inspect=false;addEventListener("message",e=>{if(e.source===parent&&e.data?.type==="crewforge:preview-inspect"&&(!e.data.previewId||e.data.previewId===id))inspect=!!e.data.enabled});addEventListener("click",e=>{if(!inspect)return;e.preventDefault();e.stopPropagation();const el=e.target;if(!(el instanceof Element))return;const rect=el.getBoundingClientRect();let candidate;try{candidate=JSON.parse(el.closest("[data-crewforge-source]")?.getAttribute("data-crewforge-source")||"null")}catch{};send("selection",{sourceCandidates:candidate?[candidate]:[],sourceMapping:candidate?"candidate":"unknown",selector:el.id?"#"+CSS.escape(el.id):el.tagName.toLowerCase(),message:el.outerHTML.slice(0,2000),tagName:el.tagName,text:el.textContent?.slice(0,500),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});inspect=false},true)})();</script>`;
}
/** Mount before JSON/static middleware; requests authenticate by preview ticket, never IDE credentials. */
export function createPreviewContentRouter(validateOwner: OwnerValidator = validOwner): Router {
  const router = Router();
  router.use((req, res) => {
    const originalUrl = req.url; req.url = req.originalUrl;
    const auth = authorized(req, validateOwner); req.url = originalUrl;
    headers(res);
    if (!auth) { res.status(401).send("Preview ticket expired or unavailable"); return; }
    if (!["GET", "HEAD"].includes(req.method)) { res.status(405).end(); return; }
    let checked: ReturnType<typeof validatePreviewPath>;
    try { checked = validatePreviewPath(auth.rawPath, auth.item.owner.workspaceDir); } catch { res.status(403).send("Preview path denied"); return; }
    const publicBase = previewBase({ id: auth.item.id, ticket: auth.ticket });
    const upstreamBase = previewUpstreamBase(auth.item);
    const targetPath = auth.item.kind === "vite" ? `${upstreamBase.slice(0, -1)}${checked.pathname}${checked.search}` : `${checked.pathname}${checked.search}`;
    const upstream = http.request({ hostname: "127.0.0.1", port: auth.item.port, path: targetPath, method: req.method,
      headers: { Host: `127.0.0.1:${auth.item.port}`, Accept: typeof req.headers.accept === "string" ? req.headers.accept : "*/*", "Accept-Encoding": "identity", "x-crewforge-preview-proof": auth.item.proof },
      timeout: 15_000,
    }, (response) => {
      if (!resolvePreviewTicket(auth.item.id, auth.ticket) || !validateOwner(auth.item)) { response.resume(); res.status(401).send("Preview ticket expired or unavailable"); return; }
      if (response.headers["x-crewforge-preview-proof"] !== auth.item.proof || (response.statusCode! >= 300 && response.statusCode! < 400)) { response.resume(); res.status(502).send("Preview upstream identity or redirect rejected"); return; }
      res.status(response.statusCode || 502);
      const contentType = String(response.headers["content-type"] || "application/octet-stream");
      res.setHeader("Content-Type", contentType);
      const isHtml = contentType.includes("text/html");
      if (req.method !== "HEAD" && (isHtml || (auth.item.kind === "vite" && /^(?:text\/|application\/(?:javascript|x-javascript|json))/.test(contentType)))) {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) { upstream.destroy(); res.destroy(); } else chunks.push(chunk); });
        response.on("end", () => {
          if (res.destroyed) return;
          let content = Buffer.concat(chunks).toString("utf8");
          if (auth.item.kind === "vite") content = content.split(upstreamBase).join(publicBase);
          if (isHtml) {
            if (auth.item.kind === "static") content = content.replace(/\b(src|href)=(["'])\/(?!\/)/gi, `$1=$2${publicBase}`);
            const injection = `<base href="${publicBase}">${bridge(auth.item, publicBase)}`;
            content = /<head(?:\s[^>]*)?>/i.test(content) ? content.replace(/<head(?:\s[^>]*)?>/i, (head) => head + injection) : injection + content;
          }
          res.end(content);
        });
      } else response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Preview upstream timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.status(502).send("Preview server is unavailable"); else res.destroy(); });
    res.on("close", () => upstream.destroy()); upstream.end();
  });
  return router;
}
const proxyWebSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
export function handlePreviewUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, validateOwner: OwnerValidator = validOwner): boolean {
  if (!(request.url || "").startsWith("/preview/")) return false;
  const auth = authorized(request, validateOwner);
  if (!auth || auth.item.kind !== "vite" || request.headers["sec-websocket-protocol"] !== "vite-hmr") { socket.destroy(); return true; }
  let checked: ReturnType<typeof validatePreviewPath>;
  try { checked = validatePreviewPath(auth.rawPath, auth.item.owner.workspaceDir); } catch { socket.destroy(); return true; }
  const publicBase = previewBase({ id: auth.item.id, ticket: auth.ticket });
  const upstreamBase = previewUpstreamBase(auth.item);
  const target = `ws://127.0.0.1:${auth.item.port}${upstreamBase.slice(0, -1)}${checked.pathname}${checked.search}`;
  const upstream = new WebSocket(target, "vite-hmr", { headers: { "x-crewforge-preview-proof": auth.item.proof }, maxPayload: 1024 * 1024, handshakeTimeout: 5000 });
  const pending: Array<{ data: Buffer; binary: boolean }> = [];
  let client: WebSocket | undefined;
  const expiry = setInterval(() => { if (!resolvePreviewTicket(auth.item.id, auth.ticket) || !validateOwner(auth.item)) { upstream.terminate(); client?.terminate(); socket.destroy(); } }, 1000); expiry.unref();
  const readiness = setTimeout(() => { if (!client) { upstream.terminate(); socket.destroy(); } }, 5000); readiness.unref();
  auth.item.sockets.add(socket);
  const close = () => { clearTimeout(readiness); clearInterval(expiry); auth.item.sockets.delete(socket); upstream.terminate(); client?.terminate(); socket.destroy(); };
  upstream.on("message", (data, binary) => {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const bytes = binary ? raw : Buffer.from(raw.toString("utf8").split(upstreamBase).join(publicBase));
    if (!client) {
      let proof: any; try { proof = JSON.parse(bytes.toString()); } catch { /* buffered until identity arrives */ }
      if (proof?.type === "custom" && proof.event === "crewforge-preview-proof" && proof.data === auth.item.proof) {
        clearTimeout(readiness);
        proxyWebSockets.handleUpgrade(request, socket, head, (ws) => {
          client = ws; for (const item of pending) ws.send(item.data, { binary: item.binary }); pending.length = 0;
          ws.on("message", (message, isBinary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(isBinary ? message : String(message).split(publicBase).join(upstreamBase), { binary: isBinary }); });
          ws.on("close", close); ws.on("error", close);
        });
      } else if (pending.reduce((sum, event) => sum + event.data.length, 0) + bytes.length < 64_000) pending.push({ data: bytes, binary });
      else close();
    } else if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary });
  });
  upstream.on("error", close); upstream.on("close", close); socket.on("close", close);
  return true;
}
export const previewContentRouter = createPreviewContentRouter();
