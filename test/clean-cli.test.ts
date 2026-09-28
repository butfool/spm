import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/index.js";
import { clearHome, entries, tmpdir, useTempHome, writeSkill } from "./helpers.js";

let home: string;
let project: string;
let previousCwd: string;

beforeEach(() => {
  ({ home } = useTempHome());
  project = tmpdir("spm-clean-cli-project");
  previousCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  clearHome();
});

describe("clean command", () => {
  it("registers project manifests only after install writes", async () => {
    const repo = tmpdir("spm-clean-cli-repo");
    writeSkill(repo, "good", "good");
    writeManifest(
      `installDirs:\n  - .agents/skills\nrepositories:\n  fixture:\n    type: local\n    path: "${repo}"\nskills:\n  - local:fixture:*\n`,
    );

    const installed = await spm("install");
    expect(installed.code).toBe(0);
    expect(entries(path.join(home, "projects"))).toHaveLength(1);

    for (const name of entries(path.join(home, "projects"))) {
      fs.unlinkSync(path.join(home, "projects", name));
    }
    const frozen = await spm("install", "--frozen");
    expect(frozen.code).toBe(0);
    expect(entries(path.join(home, "projects"))).toEqual([]);

    const listed = await spm("list");
    expect(listed.code).toBe(0);
    expect(entries(path.join(home, "projects"))).toEqual([]);
  });

  it("supports JSON preview, dry-run exit codes, and real cleanup", async () => {
    const skill = writeSkill(tmpdir("spm-clean-cli-path"), "solo", "solo");
    writeManifest(`skills:\n  - path:${skill}\n`);
    expect((await spm("install")).code).toBe(0);

    const pathEntries = entries(path.join(home, "sources", "path"));
    expect(pathEntries).toHaveLength(1);
    writeManifest("skills: []\n");
    expect((await spm("install")).code).toBe(0);

    const preview = await spm("clean", "--dry-run-code", "--json");
    expect(preview.code).toBe(1);
    const previewJson = JSON.parse(preview.stdout) as {
      dryRun: boolean;
      pending: number;
      roots: unknown[];
      entries: { state: string; action: string }[];
    };
    expect(previewJson.dryRun).toBe(true);
    expect(previewJson.pending).toBe(1);
    expect(previewJson.roots).toHaveLength(1);
    expect(previewJson.entries).toContainEqual(
      expect.objectContaining({ state: "unused", action: "would-remove" }),
    );
    expect(entries(path.join(home, "sources", "path"))).toEqual(pathEntries);

    const cleaned = await spm("clean", "--json");
    expect(cleaned.code).toBe(0);
    const cleanedJson = JSON.parse(cleaned.stdout) as { removed: string[] };
    expect(cleanedJson.removed).toEqual([`path:${pathEntries[0]}`]);
    expect(entries(path.join(home, "sources", "path"))).toEqual([]);
    expect(fs.existsSync(skill)).toBe(true);

    const second = await spm("clean", "--dry-run-code", "--json");
    expect(second.code).toBe(0);
  });

  it("shows the project registry in config output", async () => {
    const result = await spm("config", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ projectsDir: path.join(home, "projects") });
  });
});

function writeManifest(body: string): void {
  fs.writeFileSync(path.join(project, "skills.yaml"), body, "utf8");
}

async function spm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk): boolean => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });

  try {
    return { code: await run(["node", "spm", ...args]), stdout: out.join(""), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}
