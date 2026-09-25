import { subscribeRunEvents } from "../chat/runCoordinator.js";

export interface MobileInvalidation {
  type: "invalidate";
  sequence: number;
  reason: "run" | "task" | "approval" | "command" | "scope";
}

interface WorkspaceEvents {
  sequence: number;
  history: MobileInvalidation[];
  listeners: Set<(event: MobileInvalidation) => void>;
  stopRunBridge?: () => void;
  pendingRunTimer?: NodeJS.Timeout;
}

const states = new Map<string, WorkspaceEvents>();
const HISTORY_LIMIT = 100;

function state(workspaceDir: string): WorkspaceEvents {
  let current = states.get(workspaceDir);
  if (!current) {
    current = { sequence: 0, history: [], listeners: new Set() };
    states.set(workspaceDir, current);
  }
  return current;
}

export function mobileRevision(workspaceDir: string): number {
  return state(workspaceDir).sequence;
}

export function publishMobileInvalidation(
  workspaceDir: string,
  reason: MobileInvalidation["reason"],
): MobileInvalidation {
  const current = state(workspaceDir);
  const event: MobileInvalidation = { type: "invalidate", sequence: ++current.sequence, reason };
  current.history.push(event);
  if (current.history.length > HISTORY_LIMIT) current.history.shift();
  for (const listener of current.listeners) {
    try { listener(event); } catch { /* A disconnected device cannot disrupt a run. */ }
  }
  return event;
}

export function replayMobileInvalidations(workspaceDir: string, after: number): MobileInvalidation[] | null {
  const current = state(workspaceDir);
  if (!Number.isSafeInteger(after) || after < 0 || after > current.sequence) return null;
  const oldest = current.history[0]?.sequence;
  if (oldest !== undefined && after < oldest - 1) return null;
  if (oldest === undefined && after !== current.sequence) return null;
  return current.history.filter((event) => event.sequence > after);
}

export function subscribeMobileInvalidations(
  workspaceDir: string,
  listener: (event: MobileInvalidation) => void,
): () => void {
  const current = state(workspaceDir);
  if (!current.stopRunBridge) {
    // The coordinator retains the run. Browser connections only subscribe to
    // transport-safe invalidations and fetch their own authorized projection.
    // Coalesce token-level stream events so phones do not re-read the full
    // workspace snapshot for every streamed text fragment.
    current.stopRunBridge = subscribeRunEvents(workspaceDir, () => {
      if (current.pendingRunTimer) return;
      current.pendingRunTimer = setTimeout(() => {
        current.pendingRunTimer = undefined;
        publishMobileInvalidation(workspaceDir, "run");
      }, 400);
      current.pendingRunTimer.unref?.();
    });
  }
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.stopRunBridge?.();
      current.stopRunBridge = undefined;
      if (current.pendingRunTimer) clearTimeout(current.pendingRunTimer);
      current.pendingRunTimer = undefined;
    }
  };
}
