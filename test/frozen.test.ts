import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/index.js";
import { clearHome, tmpdir, useTempHome, writeSkill } from "./helpers.js";

let project: string;
let previousCwd: string;

beforeEach(() => {
  useTempHome();
  project = tmpdir("spm-frozen-project");
  previousCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  clearHome();
});

describe("the frozen install check", () => {
  it("fails with a clean error when a declared skill is not linked", async () => {
    const skill = writeSkill(tmpdir("spm-frozen-path"), "solo", "solo");
    writeManifest(`installDirs:\n  - .agents/skills\nskills:\n  - path:${skill}\n`);
    expect((await spm("install")).code).toBe(0);

    // The link is gone, so the install no longer matches the manifest.
    fs.unlinkSync(path.join(project, ".agents/skills/solo"));

    const frozen = await spm("install", "--frozen");

    expect(frozen.code).toBe(1);
    expect(frozen.stderr).toContain("1 link out of date");
    expect(frozen.stderr).toContain("Run `spm i` to fix them.");
  });

  it("passes when every declared skill is linked", async () => {
    const skill = writeSkill(tmpdir("spm-frozen-path"), "solo", "solo");
    writeManifest(`installDirs:\n  - .agents/skills\nskills:\n  - path:${skill}\n`);
    expect((await spm("install")).code).toBe(0);

    const frozen = await spm("install", "--frozen");

    expect(frozen.code).toBe(0);
    expect(frozen.stdout).toContain("everything is in sync");
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
