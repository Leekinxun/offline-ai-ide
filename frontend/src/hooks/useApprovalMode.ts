import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ApprovalModeClient, type ApprovalMode, type ApprovalModeScope } from "./approvalModeClient";

const APPROVAL_MODE_CHANGED = "crewforge:approval-mode-changed";
const APPROVAL_MODE_CHANNEL = "crewforge-approval-mode";

export function useApprovalMode(scope: ApprovalModeScope, connected: boolean) {
  const { token, workspaceDir, conversationId } = scope;
  const client = useMemo(() => new ApprovalModeClient({ token, workspaceDir, conversationId }), [token, workspaceDir, conversationId]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    client.activate();
    void client.refresh();
    const refresh = () => { void client.refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener(APPROVAL_MODE_CHANGED, refresh);
    document.addEventListener("visibilitychange", onVisible);
    // Messages only invalidate reads. Neither modes nor credentials are trusted
    // from another tab, and isolated login sessions read their own server scope.
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(APPROVAL_MODE_CHANNEL);
        channel.onmessage = refresh;
      }
    } catch { /* Focus and polling remain available if browser channels are blocked. */ }
    channelRef.current = channel;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, 15_000);
    return () => {
      client.dispose();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener(APPROVAL_MODE_CHANGED, refresh);
      document.removeEventListener("visibilitychange", onVisible);
      channel?.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [client]);

  useEffect(() => { if (connected) void client.refresh(); }, [client, connected]);
  const setMode = useCallback(async (mode: ApprovalMode, acknowledgeRisk = false) => {
    const updated = await client.setMode(mode, acknowledgeRisk);
    if (updated) {
      window.dispatchEvent(new Event(APPROVAL_MODE_CHANGED));
      try { channelRef.current?.postMessage({ type: "changed" }); } catch { /* Next server read reconciles the state. */ }
    }
    return updated;
  }, [client]);
  return { ...state, setMode, refresh: client.refresh };
}
