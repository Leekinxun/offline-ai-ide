import { WebSocket } from "ws";
import { wsSend } from "../agent/types.js";
import { runAgentLoop } from "../agent/loop.js";

export function handleChatWs(ws: WebSocket): void {
  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const userMessage: string = data.message || "";
      const context = data.context as
        | { path: string; content: string; language: string; selection?: string }
        | undefined;
      const history: { role: string; content: string }[] = data.history || [];

      if (!userMessage.trim()) {
        wsSend(ws, { type: "error", content: "Empty message" });
        return;
      }

      await runAgentLoop(ws, userMessage, context, history);
    } catch (e: any) {
      wsSend(ws, { type: "error", content: e.message || String(e) });
    }
  });
}
