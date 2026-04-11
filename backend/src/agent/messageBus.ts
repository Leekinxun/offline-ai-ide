import fs from "fs";
import path from "path";
import { InboxMessage } from "./types.js";

export class MessageBus {
  private inboxDir: string;

  constructor(workspaceDir: string) {
    this.inboxDir = path.join(workspaceDir, ".team", "inbox");
    try {
      fs.mkdirSync(this.inboxDir, { recursive: true });
    } catch {
      // Defer creation
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType: string = "message",
    extra?: Record<string, unknown>
  ): string {
    this.ensureDir();
    const msg: InboxMessage = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    fs.appendFileSync(
      path.join(this.inboxDir, `${to}.jsonl`),
      JSON.stringify(msg) + "\n"
    );
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): InboxMessage[] {
    this.ensureDir();
    const filePath = path.join(this.inboxDir, `${name}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return [];
    const msgs = content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InboxMessage);
    // Drain inbox
    fs.writeFileSync(filePath, "");
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const name of names) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}
