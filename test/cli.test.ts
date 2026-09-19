import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/index.js";
import { clearHome, tmpdir, useTempHome, writeSkill, writeSkillFile } from "./helpers.js";

let project: string;
let previousCwd: string;

/**
 * Runs the CLI the way `src/cli.ts` does, capturing both output streams.
 *
 * `run` returns the exit code instead of setting `process.exitCode`, so the
 * assertions here read exactly what a shell would see.
 */
async function spm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];

  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

  try {
    const code = await run(["node", "spm", ...args]);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

function writeManifest(projectDir: string, body: string): void {
  fs.writeFileSync(path.join(projectDir, "skills.yaml"), body, "utf8");
}

beforeEach(() => {
  useTempHome();
  project = tmpdir("spm-cli-project");
  previousCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  clearHome();
});

describe("reporting a skipped SKILL.md", () => {
  it("add: installs the usable skills, names the skipped file, and fails", async () => {
    const repo = tmpdir("spm-cli-mixed");
    writeSkill(repo, "good", "good");
    writeSkillFile(repo, "broken", "---\nname: Broken\ndescription: x\n---\n");
    writeManifest(project, "installDirs:\n  - .agents/skills\nskills: []\n");

    const result = await spm("add", repo);

    expect(result.code).toBe(1);
    expect(fs.existsSync(path.join(project, ".agents/skills/good"))).toBe(true);
    expect(result.stderr).toContain("broken/SKILL.md");
    expect(result.stderr).toMatch(/may only contain lowercase letters/);
    expect(result.stderr).toContain("1 SKILL.md file skipped");
  });

  it("source add: does not claim success for a source with no usable skill", async () => {
    const repo = tmpdir("spm-cli-unusable");
    writeSkillFile(repo, "broken", "---\nname: Broken\ndescription: x\n---\n");

    const result = await spm("source", "add", repo);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("registered");
    expect(result.stderr).toContain("broken/SKILL.md");
  });

  it("source add: registers a usable source without complaint", async () => {
    const repo = tmpdir("spm-cli-usable");
    writeSkill(repo, "good", "good");

    const result = await spm("source", "add", repo);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("registered");
    expect(result.stderr).toBe("");
  });

  it("source list --json: keeps stdout parseable and still fails", async () => {
    const repo = tmpdir("spm-cli-listed");
    writeSkill(repo, "good", "good");
    writeSkillFile(repo, "broken", "---\nname: Broken\ndescription: x\n---\n");
    await spm("source", "add", repo);

    const result = await spm("source", "list", "--json");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("broken/SKILL.md");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("doctor: reports a declared skill whose file became unusable and fails", async () => {
    const repo = tmpdir("spm-cli-doctor");
    writeSkillFile(repo, "ghost", "---\nname: Ghost\ndescription: x\n---\n");
    writeManifest(
      project,
      `installDirs:\n  - .agents/skills\nskills:\n  - path: "${repo}"\n    skill: ghost\n`,
    );

    const result = await spm("doctor");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ghost/SKILL.md");
    expect(result.stderr).toMatch(/may only contain lowercase letters/);
  });

  it("install: a manifest whose skills are all usable still succeeds", async () => {
    const repo = tmpdir("spm-cli-clean");
    writeSkill(repo, "good", "good");
    writeManifest(
      project,
      `installDirs:\n  - .agents/skills\nsources:\n  fixture:\n    path: "${repo}"\nskills:\n  - fixture/*\n`,
    );

    const result = await spm("install");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("linked");
    expect(result.stderr).toBe("");
  });
});
