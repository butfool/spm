import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallDirs, sourcesDir } from "../src/config.js";
import type { SpmError } from "../src/errors.js";
import { clearHome, tmpdir, useTempHome } from "./helpers.js";

let home: string;

beforeEach(() => {
  ({ home } = useTempHome());
});

afterEach(clearHome);

function settings(contents: string): void {
  fs.writeFileSync(path.join(home, "settings.yaml"), contents, "utf8");
}

function capture(run: () => unknown): SpmError {
  try {
    run();
  } catch (err) {
    return err as SpmError;
  }
  throw new Error("expected the call to throw");
}

describe("sourcesDir", () => {
  it("resolves a relative value inside the spm home", () => {
    expect(sourcesDir()).toBe(path.join(home, "sources"));
  });

  it("refuses a value that climbs out of the spm home", () => {
    settings("sourcesDir: ..\n");
    const caught = capture(() => sourcesDir());
    expect(caught.message).toMatch(/outside the spm home/);
    expect(caught.hint).toContain("settings.yaml");
  });

  it("refuses an absolute value outside the spm home", () => {
    settings("sourcesDir: /tmp\n");
    expect(() => sourcesDir()).toThrow(/outside the spm home/);
  });
});

describe("resolveInstallDirs", () => {
  it("keeps a relative entry inside the base directory", () => {
    const base = tmpdir("spm-proj");
    expect(resolveInstallDirs([".agents/skills"], base)).toEqual([
      path.join(base, ".agents/skills"),
    ]);
  });

  it("accepts an absolute entry that stays inside the base directory", () => {
    const base = tmpdir("spm-proj");
    expect(resolveInstallDirs([path.join(base, "skills")], base)).toEqual([
      path.join(base, "skills"),
    ]);
  });

  it("refuses an absolute entry outside the base directory", () => {
    const base = tmpdir("spm-proj");
    const outside = tmpdir("spm-outside");
    const caught = capture(() => resolveInstallDirs([outside], base));
    expect(caught.message).toContain(outside);
    expect(caught.hint).toMatch(/must stay inside/);
  });

  it("refuses a relative entry that climbs out of the base directory", () => {
    const base = tmpdir("spm-proj");
    expect(() => resolveInstallDirs(["../elsewhere"], base)).toThrow(/is outside/);
  });

  it("refuses a home-relative entry for a project", () => {
    const base = tmpdir("spm-proj");
    expect(() => resolveInstallDirs(["~/.ssh"], base)).toThrow(/is outside/);
  });
});
