import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunRecorder } from "../chat/runHistory.js";
import {
  buildSkillsPrompt,
  getManagedWorkspaceSkill,
  listManagedWorkspaceSkills,
  listSkillUsage,
  listWorkspaceSkills,
  loadWorkspaceSkill,
  setWorkspaceSkillEnabled,
} from "./skills.js";

test("discovers workspace skills and exposes metadata without loading bodies", async () => {
  const workspaceDir = await fsTempDir("crownforge-skills-");
  try {
    await mkdir(path.join(workspaceDir, ".codex", "skills", "release"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".codex", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Prepare a release\ntrigger: release build\ntags: git,version\n---\n# Release workflow\n\nRun checks before tagging.\n"
    );

    const skills = listWorkspaceSkills(workspaceDir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "release");
    assert.equal(skills[0].trigger, "release build");
    assert.match(buildSkillsPrompt(workspaceDir), /skill_load/);
    assert.match(loadWorkspaceSkill(workspaceDir, "release"), /Run checks before tagging/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("supports skill management and excludes disabled skills from agent loading", async () => {
  const workspaceDir = await fsTempDir("crownforge-skills-");
  try {
    await mkdir(path.join(workspaceDir, "skills", "review"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\nparameters: focus, depth\n---\n# Review\n\nInspect the diff.\n"
    );

    const managed = listManagedWorkspaceSkills(workspaceDir);
    assert.equal(managed[0].enabled, true);
    assert.equal(managed[0].metadata.parameters, "focus, depth");
    assert.match(getManagedWorkspaceSkill(workspaceDir, "review").body, /Inspect the diff/);
    setWorkspaceSkillEnabled(workspaceDir, "review", false);
    assert.equal(listManagedWorkspaceSkills(workspaceDir)[0].enabled, false);
    assert.doesNotMatch(buildSkillsPrompt(workspaceDir), /Review changes/);
    assert.throws(() => loadWorkspaceSkill(workspaceDir, "review"), /disabled/);
    setWorkspaceSkillEnabled(workspaceDir, "review", true);
    assert.match(loadWorkspaceSkill(workspaceDir, "review"), /Inspect the diff/);

    const recorder = new AgentRunRecorder(workspaceDir, "run-review", "conversation-review", "code");
    await recorder.start();
    await recorder.event({ kind: "tool_call", label: "Skill loaded", toolName: "skill_load", detail: "review" });
    await recorder.finish("completed");
    assert.equal(listSkillUsage(workspaceDir, "review").length, 1);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

async function fsTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
