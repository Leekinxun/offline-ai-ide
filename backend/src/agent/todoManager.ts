import { TodoItem } from "./types.js";

export class TodoManager {
  items: TodoItem[] = [];

  update(newItems: unknown[]): string {
    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i] as Record<string, unknown>;
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase();
      const activeForm = String(item.activeForm || "").trim();

      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") inProgressCount++;

      validated.push({
        content,
        status: status as TodoItem["status"],
        activeForm,
      });
    }

    if (validated.length > 20) throw new Error("Max 20 todos");
    if (inProgressCount > 1) throw new Error("Only one in_progress allowed");

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) return "No todos.";
    const markers: Record<string, string> = {
      completed: "[x]",
      in_progress: "[>]",
      pending: "[ ]",
    };
    const lines = this.items.map((item) => {
      const m = markers[item.status] || "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      return `${m} ${item.content}${suffix}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}
