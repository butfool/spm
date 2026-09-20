import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/index.js";
import { registerLocal } from "../src/core/source.js";
import { clearHome, entries, tmpdir, useTempHome, writeSkill, writeSkillFile } from "./helpers.js";

let home: string;
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

function readManifest(projectDir: string): string {
  return fs.readFileSync(path.join(projectDir, "skills.yaml"), "utf8");
}

function globalManifest(): string {
  return fs.readFileSync(path.join(home, "skills.yaml"), "utf8");
}

beforeEach(() => {
  ({ home } = useTempHome());
  project = tmpdir("spm-cli-project");
  previousCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  clearHome();
});

describe("the machine-level registry", () => {
  it("records a local repository in the global manifest and serves every project from it", async () => {
    const repo = tmpdir("spm-cli-registry");
    writeSkill(repo, "good", "good");
    writeSkill(repo, "other", "other");

    const added = await spm("repository", "add", repo, "--name", "mine");

    expect(added.code).toBe(0);
    expect(added.stdout).toContain("registered");
    expect(globalManifest()).toContain("mine:");
    expect(globalManifest()).toContain("type: local");
    expect(globalManifest()).toContain(repo);

    // A project names the repository by name; the path is not repeated.
    writeManifest(project, "installDirs:\n  - .agents/skills\nskills:\n  - local:mine:*\n");
    const installed = await spm("install");

    expect(installed.code).toBe(0);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["good", "other"]);
  });

  it("writes only the coordinate when the repository is already registered globally", async () => {
    const repo = tmpdir("spm-cli-shared");
    writeSkill(repo, "good", "good");
    await spm("repository", "add", repo, "--name", "mine");

    const result = await spm("add", "mine:good");

    expect(result.code).toBe(0);
    expect(readManifest(project)).toContain("local:mine:good");
    expect(readManifest(project)).not.toContain("repositories:");
  });

  it("forgets a repository on request", async () => {
    const repo = tmpdir("spm-cli-forget");
    writeSkill(repo, "good", "good");
    await spm("repository", "add", repo, "--name", "mine");

    const removed = await spm("repository", "remove", "mine");

    expect(removed.code).toBe(0);
    expect(globalManifest()).not.toContain("mine:");
    expect(fs.existsSync(path.join(home, "sources", "local", "mine"))).toBe(false);
  });

  it("refuses a name already pointing elsewhere", async () => {
    const first = tmpdir("spm-cli-first");
    const second = tmpdir("spm-cli-second");
    writeSkill(first, "one", "one");
    writeSkill(second, "two", "two");
    await spm("repository", "add", first, "--name", "mine");

    const clash = await spm("repository", "add", second, "--name", "mine");

    expect(clash.code).toBe(1);
    expect(clash.stderr).toMatch(/already registered/);
  });

  it("names a repository that is not registered", async () => {
    const result = await spm("add", "mine:good");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown repository "mine"');
  });

  it("keeps the machine-level registry when a global skill is removed", async () => {
    const repo = tmpdir("spm-cli-global");
    writeSkill(repo, "good", "good");
    await spm("repository", "add", repo, "--name", "mine");
    await spm("add", "-g", "mine:good");

    const result = await spm("remove", "-g", "local:mine:good");

    expect(result.code).toBe(0);
    expect(globalManifest()).not.toContain("local:mine:good");
    // The registration is a machine-level statement, not a dependency.
    expect(globalManifest()).toContain("mine:");
    expect(globalManifest()).toContain("type: local");
  });
});

describe("declaring skills", () => {
  it("records the declaration next to the dependency for a local path", async () => {
    const repo = tmpdir("spm-cli-path");
    writeSkill(repo, "good", "good");

    const result = await spm("add", repo, "--name", "mine");

    expect(result.code).toBe(0);
    expect(readManifest(project)).toContain("repositories:");
    expect(readManifest(project)).toContain("type: local");
    expect(readManifest(project)).toContain("local:mine:*");
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["good"]);
  });

  it("drops a coordinate and its links on remove", async () => {
    const repo = tmpdir("spm-cli-remove");
    writeSkill(repo, "good", "good");
    writeSkill(repo, "other", "other");
    await spm("repository", "add", repo, "--name", "mine");
    writeManifest(
      project,
      "installDirs:\n  - .agents/skills\nskills:\n  - local:mine:good\n  - local:mine:other\n",
    );
    await spm("install");

    const result = await spm("remove", "local:mine:good");

    expect(result.code).toBe(0);
    expect(readManifest(project)).toContain("local:mine:other");
    expect(readManifest(project)).not.toContain("local:mine:good");
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["other"]);
  });

  it("reports a skill a whole-repository entry is providing", async () => {
    const repo = tmpdir("spm-cli-covered");
    writeSkill(repo, "good", "good");
    await spm("repository", "add", repo, "--name", "mine");
    writeManifest(project, "installDirs:\n  - .agents/skills\nskills:\n  - local:mine:*\n");

    const result = await spm("remove", "good");

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('comes from the whole-repository entry "local:mine:*"');
  });

  it("drops a project-level declaration nothing refers to any more", async () => {
    const repo = tmpdir("spm-cli-project-local");
    writeSkill(repo, "good", "good");
    await spm("add", repo, "--name", "mine");
    expect(readManifest(project)).toContain("repositories:");

    const result = await spm("remove", "local:mine:*");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dropped the unused local repository declaration");
    expect(readManifest(project)).not.toContain("repositories:");
    expect(entries(path.join(project, ".agents/skills"))).toEqual([]);
  });

  it("lists the declared skills with the repository each came from", async () => {
    const repo = tmpdir("spm-cli-list");
    writeSkill(repo, "good", "good");
    await spm("repository", "add", repo, "--name", "mine");
    writeManifest(project, "installDirs:\n  - .agents/skills\nskills:\n  - local:mine:*\n");
    await spm("install");

    const result = await spm("list", "--json");
    const parsed = JSON.parse(result.stdout) as {
      skills: { name: string; source: string }[];
    };

    expect(result.code).toBe(0);
    expect(parsed.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(parsed.skills[0]!.source).toBe("local:mine");
  });
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

  it("repository add: does not claim success for a directory with no usable skill", async () => {
    const repo = tmpdir("spm-cli-unusable");
    writeSkillFile(repo, "broken", "---\nname: Broken\ndescription: x\n---\n");

    const result = await spm("repository", "add", repo);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("registered");
    expect(result.stderr).toContain("broken/SKILL.md");
    expect(fs.existsSync(path.join(home, "sources"))).toBe(true);
    expect(fs.existsSync(path.join(home, "sources", "local"))).toBe(false);
  });

  it("repository add: registers a usable directory without complaint", async () => {
    const repo = tmpdir("spm-cli-usable");
    writeSkill(repo, "good", "good");

    const result = await spm("repository", "add", repo);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("registered");
    expect(result.stderr).toBe("");
  });

  it("repository list --json: keeps stdout parseable and still fails", async () => {
    const repo = tmpdir("spm-cli-listed");
    writeSkill(repo, "good", "good");
    writeSkillFile(repo, "broken", "---\nname: Broken\ndescription: x\n---\n");
    registerLocal(repo, "listed");

    const result = await spm("repository", "list", "--json");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("broken/SKILL.md");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("doctor: reports a declared skill whose file became unusable and fails", async () => {
    const repo = tmpdir("spm-cli-doctor");
    writeSkillFile(repo, "ghost", "---\nname: Ghost\ndescription: x\n---\n");
    registerLocal(repo, "broken");
    writeManifest(
      project,
      `installDirs:\n  - .agents/skills\nrepositories:\n  broken:\n    type: local\n    path: "${repo}"\nskills:\n  - local:broken:ghost\n`,
    );

    const result = await spm("doctor");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ghost/SKILL.md");
    expect(result.stderr).toMatch(/may only contain lowercase letters/);
  });

  it("doctor: reports a repository whose directory vanished exactly once", async () => {
    const repo = tmpdir("spm-cli-vanished");
    writeSkill(repo, "good", "good");
    await spm("add", repo, "--name", "gone");
    fs.rmSync(repo, { recursive: true, force: true });

    const result = await spm("doctor");

    // One root cause, one diagnosis: a declaration check plus a discovery
    // failure would report the same thing twice and make the totals lie.
    expect(result.stdout).toContain("1 error, 0 warnings");
    expect(result.stderr).toMatch(/local:gone:\* is not available/);
    expect(result.stderr).toContain("spm repository add <path> --name gone");
  });

  it("install: a manifest whose skills are all usable still succeeds", async () => {
    const repo = tmpdir("spm-cli-clean");
    writeSkill(repo, "good", "good");
    writeManifest(
      project,
      `installDirs:\n  - .agents/skills\nrepositories:\n  fixture:\n    type: local\n    path: "${repo}"\nskills:\n  - local:fixture:*\n`,
    );

    const result = await spm("install");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("linked");
    expect(result.stderr).toBe("");
  });
});
