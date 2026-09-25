import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { getMobileSessionFromUpgrade, type MobileSession } from "../mobile/pairing.js";
import { buildMobileSnapshot, getMobileContext } from "../mobile/data.js";
import { mobileRevision, publishMobileInvalidation, replayMobileInvalidations, subscribeMobileInvalidations, type MobileInvalidation } from "../mobile/events.js";

const connectedDevices = new Map<string, WebSocket>();

function send(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function fingerprint(session: MobileSession): string {
  const context = getMobileContext(session);
  const snapshot = buildMobileSnapshot(context, mobileRevision(context.scope.workspaceDir));
  return JSON.stringify({
    workspaceId: snapshot.workspace.id,
    role: snapshot.workspace.role,
    tasks: snapshot.tasks.map((task) => [task.id, task.status, task.updatedAt, task.version]),
    approvals: snapshot.approvals.map((approval) => [approval.id, approval.canDecide]),
    runs: snapshot.activeRuns.map((run) => [run.runId, run.status, run.sequence]),
  });
}

/** Mobile WebSocket sends only invalidation metadata, never raw run events or
 * tool inputs. The client fetches a fresh permission-filtered HTTP snapshot. */
export function handleMobileWs(ws: WebSocket, req: IncomingMessage, initial: MobileSession): void {
  const existing = connectedDevices.get(initial.id);
  if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
    existing.close(4008, "Another page connected");
  }
  connectedDevices.set(initial.id, ws);

  const workspaceDir = initial.workspaceDir;
  const scopeKey = initial.scopeKey;
  let lastFingerprint: string;
  try {
    lastFingerprint = fingerprint(initial);
  } catch {
    if (connectedDevices.get(initial.id) === ws) connectedDevices.delete(initial.id);
    ws.close(1008, "Workspace access expired");
    return;
  }

  const url = new URL(req.url || "/ws/mobile", "http://localhost");
  const afterText = url.searchParams.get("after");
  const after = afterText && /^\d+$/.test(afterText) ? Number(afterText) : null;
  if (after !== null && Number.isSafeInteger(after)) {
    const replay = replayMobileInvalidations(workspaceDir, after);
    if (replay === null) send(ws, { type: "resync", sequence: mobileRevision(workspaceDir) });
    else for (const event of replay) send(ws, event);
  } else {
    send(ws, { type: "resync", sequence: mobileRevision(workspaceDir) });
  }
  send(ws, { type: "ready", sequence: mobileRevision(workspaceDir), workspaceId: scopeKey });

  const unsubscribe = subscribeMobileInvalidations(workspaceDir, (event: MobileInvalidation) => {
    const current = getMobileSessionFromUpgrade(req);
    if (!current || current.id !== initial.id || current.scopeKey !== scopeKey) {
      ws.close(1008, "Mobile access expired");
      return;
    }
    send(ws, event);
  });

  const poll = setInterval(() => {
    const current = getMobileSessionFromUpgrade(req);
    if (!current || current.id !== initial.id || current.scopeKey !== scopeKey || current.workspaceDir !== workspaceDir) {
      ws.close(1008, "Mobile access expired");
      return;
    }
    try {
      const next = fingerprint(current);
      if (next !== lastFingerprint) {
        lastFingerprint = next;
        publishMobileInvalidation(workspaceDir, "task");
      }
    } catch {
      ws.close(1008, "Workspace access expired");
    }
  }, 5_000);
  poll.unref?.();

  ws.on("message", () => ws.close(1008, "Mobile commands use HTTP"));
  ws.on("close", () => {
    clearInterval(poll);
    unsubscribe();
    if (connectedDevices.get(initial.id) === ws) connectedDevices.delete(initial.id);
  });
}
