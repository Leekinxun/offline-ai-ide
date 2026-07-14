import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSkillsPrompt,
  listWorkspaceSkills,
  loadWorkspaceSkill,
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

async function fsTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
