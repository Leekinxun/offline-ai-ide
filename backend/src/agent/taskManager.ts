import fs from "fs";
import path from "path";
import { Task } from "./types.js";

export class TaskManager {
  private tasksDir: string;

  constructor(workspaceDir: string) {
    this.tasksDir = path.join(workspaceDir, ".tasks");
    try {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    } catch {
      // Workspace may not be writable during import; defer creation
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  private nextId(): number {
    this.ensureDir();
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.match(/^task_\d+\.json$/));
    const ids = files.map((f) => parseInt(f.split("_")[1]));
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
  }

  private load(tid: number): Task {
    const filePath = path.join(this.tasksDir, `task_${tid}.json`);
    if (!fs.existsSync(filePath)) throw new Error(`Task ${tid} not found`);
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  private save(task: Task): void {
    this.ensureDir();
    fs.writeFileSync(
      path.join(this.tasksDir, `task_${task.id}.json`),
      JSON.stringify(task, null, 2)
    );
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
      blocks: [],
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid: number): string {
    return JSON.stringify(this.load(tid), null, 2);
  }

  update(
    tid: number,
    status?: string,
    addBlockedBy?: number[],
    addBlocks?: number[]
  ): string {
    const task = this.load(tid);

    if (status) {
      task.status = status as Task["status"];
      if (status === "completed") {
        // Remove this task from others' blockedBy
        this.ensureDir();
        for (const f of fs.readdirSync(this.tasksDir).filter((x) => x.match(/^task_\d+\.json$/))) {
          const other = JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), "utf-8")) as Task;
          if (other.blockedBy.includes(tid)) {
            other.blockedBy = other.blockedBy.filter((id) => id !== tid);
            this.save(other);
          }
        }
      }
      if (status === "deleted") {
        const filePath = path.join(this.tasksDir, `task_${tid}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return `Task ${tid} deleted`;
      }
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    this.ensureDir();
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.match(/^task_\d+\.json$/));
    if (files.length === 0) return "No tasks.";

    const tasks = files
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), "utf-8")) as Task);

    const markers: Record<string, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
    };

    return tasks
      .map((t) => {
        const m = markers[t.status] || "[?]";
        const owner = t.owner ? ` @${t.owner}` : "";
        const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
        return `${m} #${t.id}: ${t.subject}${owner}${blocked}`;
      })
      .join("\n");
  }

  claim(tid: number, owner: string): string {
    const task = this.load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this.save(task);
    return `Claimed task #${tid} for ${owner}`;
  }

  getUnclaimed(): Task[] {
    this.ensureDir();
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.match(/^task_\d+\.json$/));
    return files
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), "utf-8")) as Task)
      .filter((t) => t.status === "pending" && !t.owner && t.blockedBy.length === 0);
  }
}
