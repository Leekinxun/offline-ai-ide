export type RequestOutcome = "completed" | "stopped" | "failed";

export function recordRequestOutcome(current: Record<string, RequestOutcome>, requestId: string, outcome: RequestOutcome): Record<string, RequestOutcome> {
  const next = outcome === "completed" && ["stopped", "failed"].includes(current[requestId]) ? current[requestId] : outcome;
  return Object.fromEntries([...Object.entries(current).filter(([id]) => id !== requestId).slice(-299), [requestId, next]]);
}

export function inlineRequestStatus(outcome: RequestOutcome | undefined, cancelled: boolean): "streaming" | "completed" | "error" | "cancelled" {
  if (cancelled || outcome === "stopped") return "cancelled";
  if (outcome === "failed") return "error";
  return outcome === "completed" ? "completed" : "streaming";
}
