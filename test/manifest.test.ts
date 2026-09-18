import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addSkillEntry,
  entrySourceKey,
  entryToString,
  manifestPath,
  readManifest,
  removeSkillEntry,
  writeManifest,
} from "../src/core/manifest.js";
import { readRepoManifest } from "../src/core/repo-manifest.js";
import { tmpdir } from "./helpers.js";

describe("manifest round-trip", () => {
  it("preserves sources, skills, and installDirs", () => {
    const dir = tmpdir("spm-man");
    writeManifest(dir, {
      installDirs: [".agents/skills", ".claude/skills"],
      sources: { local: { path: "/tmp/x" }, remote: { repo: "a/b", ref: "v1" } },
      skills: ["local/*", "remote/skill"],
    });

    const back = readManifest(dir);
    expect(back).not.toBeNull();
    expect(back!.installDirs).toEqual([".agents/skills", ".claude/skills"]);
    expect(back!.sources["local"]).toEqual({ path: "/tmp/x" });
    expect(back!.sources["remote"]).toEqual({ repo: "a/b", ref: "v1" });
    expect(back!.skills).toEqual(["local/*", "remote/skill"]);
  });

  it("returns null when the file is absent", () => {
    expect(readManifest(tmpdir("spm-man"))).toBeNull();
  });

  it("writes deterministic output so diffs stay small", () => {
    const a = tmpdir("spm-man");
    const b = tmpdir("spm-man");

    writeManifest(a, {
      installDirs: [],
      sources: { zeta: { path: "/z" }, alpha: { path: "/a" } },
      skills: ["zeta/two", "alpha/one"],
    });
    writeManifest(b, {
      installDirs: [],
      sources: { alpha: { path: "/a" }, zeta: { path: "/z" } },
      skills: ["alpha/one", "zeta/two"],
    });

    expect(fs.readFileSync(manifestPath(a), "utf8")).toBe(
      fs.readFileSync(manifestPath(b), "utf8"),
    );
  });

  it("omits empty sections rather than writing them as null", () => {
    const dir = tmpdir("spm-man");
    writeManifest(dir, { installDirs: [], sources: {}, skills: [] });
    expect(fs.readFileSync(manifestPath(dir), "utf8").trim()).toBe("{}");
  });

  it("rejects a source with both path and repo", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(
      manifestPath(dir),
      "sources:\n  bad:\n    path: /x\n    repo: a/b\n",
      "utf8",
    );
    expect(() => readManifest(dir)).toThrow(/path.*repo|exactly one/i);
  });
});

describe("addSkillEntry", () => {
  const base = () => ({ installDirs: [], sources: {}, skills: [] });

  it("does not duplicate an identical entry", () => {
    const m = base();
    expect(addSkillEntry(m, "a/x")).toBe(true);
    expect(addSkillEntry(m, "a/x")).toBe(false);
    expect(m.skills).toEqual(["a/x"]);
  });

  it("skips a skill already covered by a whole-source entry", () => {
    const m = base();
    addSkillEntry(m, "a/*");
    expect(addSkillEntry(m, "a/x")).toBe(false);
    expect(m.skills).toEqual(["a/*"]);
  });

  it("replaces individual entries when the whole source is added", () => {
    const m = base();
    addSkillEntry(m, "a/x");
    addSkillEntry(m, "a/y");
    addSkillEntry(m, "b/z");
    addSkillEntry(m, "a/*");

    expect(m.skills).toContain("a/*");
    expect(m.skills).toContain("b/z");
    expect(m.skills).not.toContain("a/x");
    expect(m.skills).not.toContain("a/y");
  });

  it("treats different sources as independent", () => {
    const m = base();
    addSkillEntry(m, "a/*");
    expect(addSkillEntry(m, "b/x")).toBe(true);
    expect(m.skills).toEqual(["a/*", "b/x"]);
  });
});

describe("removeSkillEntry", () => {
  it("reports whether it changed anything", () => {
    const m = { installDirs: [], sources: {}, skills: ["a/x", "b/y"] };
    expect(removeSkillEntry(m, "a/x")).toBe(true);
    expect(removeSkillEntry(m, "a/x")).toBe(false);
    expect(m.skills).toEqual(["b/y"]);
  });
});

describe("entry helpers", () => {
  it("keys alias entries by their alias", () => {
    expect(entrySourceKey("repo/skill")).toBe("alias:repo");
    expect(entrySourceKey("repo/*")).toBe("alias:repo");
  });

  it("keys object entries by their origin", () => {
    expect(entrySourceKey({ repo: "a/b" })).toBe("repo:a/b");
    expect(entrySourceKey({ repo: "a/b", ref: "v1" })).toBe("repo:a/b#v1");
    expect(entrySourceKey({ path: "/x/y" })).toBe("path:/x/y");
  });

  it("renders object entries back to a readable form", () => {
    expect(entryToString({ repo: "a/b", ref: "v1", skill: "s" })).toBe("a/b#v1:s");
    expect(entryToString({ path: "/x" })).toBe("/x");
  });
});

describe("repository manifest", () => {
  it("defaults when absent", () => {
    expect(readRepoManifest(tmpdir("spm-repo"))).toEqual({ exclude: [], maxDepth: 0 });
  });

  it("reads name, excludes, and depth", () => {
    const dir = tmpdir("spm-repo");
    fs.writeFileSync(
      path.join(dir, "skill-repository.yaml"),
      "name: mine\nexclude:\n  - drafts\nmaxDepth: 2\n",
      "utf8",
    );
    expect(readRepoManifest(dir)).toEqual({ name: "mine", exclude: ["drafts"], maxDepth: 2 });
  });

  it("ignores unknown keys, including legacy uuid fields", () => {
    const dir = tmpdir("spm-repo");
    fs.writeFileSync(
      path.join(dir, "skill-repository.yaml"),
      "id: 7f89021c-13d7-4f70-8c26-ae983922324e\nname: mine\nskills:\n  alpha:\n    id: abc\n",
      "utf8",
    );
    expect(readRepoManifest(dir)).toEqual({ name: "mine", exclude: [], maxDepth: 0 });
  });
});
