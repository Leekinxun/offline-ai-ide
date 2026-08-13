import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { listChangeSetReviewRuns, scheduleChangeSetReview, setChangeSetReviewRunnerForTests } from "./changeSetReviewRun.js";

export function releaseTestGit(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function releaseTestRepository(t: TestContext): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-change-set-release-"));
  const directory = path.join(parent, "repo");
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  releaseTestGit(directory, ["init"]);
  releaseTestGit(directory, ["config", "user.email", "test@example.com"]);
  releaseTestGit(directory, ["config", "user.name", "CrewForge Test"]);
  fs.writeFileSync(path.join(directory, "a.txt"), "base\n");
  releaseTestGit(directory, ["add", "."]);
  releaseTestGit(directory, ["commit", "-m", "base"]);
  return directory;
}

export function releaseTestCommit(worktree: string, text: string): void {
  fs.writeFileSync(path.join(worktree, "a.txt"), text);
  releaseTestGit(worktree, ["add", "a.txt"]);
  releaseTestGit(worktree, ["commit", "-m", "change"]);
}

export async function independentlyReviewForRelease(t: TestContext, directory: string, id: string): Promise<void> {
  setChangeSetReviewRunnerForTests(async () => []);
  t.after(() => setChangeSetReviewRunnerForTests(undefined));
  scheduleChangeSetReview(directory, id, "release-reviewer");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (listChangeSetReviewRuns(directory, id)[0]?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("release review did not complete");
}
