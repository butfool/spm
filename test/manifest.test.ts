import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRepositoryCoordinate, parseCoordinate } from "../src/core/coordinate.js";
import {
  addSkillEntry,
  manifestCoordinates,
  manifestPath,
  readManifest,
  removeSkillEntry,
  removeSkillEntries,
  upsertAlias,
  upsertRepository,
  writeManifest,
  type Manifest,
} from "../src/core/manifest.js";
import { readRepoManifest } from "../src/core/repo-manifest.js";
import { tmpdir } from "./helpers.js";

const empty = (): Manifest => ({
  installDirs: [],
  repositories: {},
  aliases: {},
  skills: [],
});

describe("manifest round-trip", () => {
  it("preserves repositories, skills, and installDirs", () => {
    const dir = tmpdir("spm-man");
    writeManifest(dir, {
      installDirs: [".agents/skills", ".claude/skills"],
      repositories: {
        mine: { type: "local", path: "/tmp/x" },
        other: { type: "local", path: "~/other" },
      },
      aliases: { pdf: "local:mine:pdf", "xmind-file": "path:~/xmind-file" },
      skills: ["local:mine:*", "github:a/b:pdf-fill"],
    });

    const back = readManifest(dir);
    expect(back).not.toBeNull();
    expect(back!.installDirs).toEqual([".agents/skills", ".claude/skills"]);
    expect(back!.repositories["mine"]).toEqual({ type: "local", path: "/tmp/x" });
    expect(back!.repositories["other"]).toEqual({ type: "local", path: "~/other" });
    expect(back!.aliases["pdf"]).toBe("local:mine:pdf");
    expect(back!.aliases["xmind-file"]).toBe("path:~/xmind-file");
    expect(back!.skills).toEqual(["github:a/b:pdf-fill", "local:mine:*"]);
  });

  it("parses the declared coordinates through the same reader everything else uses", () => {
    const dir = tmpdir("spm-man");
    writeManifest(dir, {
      installDirs: [],
      repositories: {},
      aliases: {},
      skills: ["local:mine:*", "github:a/b:pdf"],
    });

    expect(
      manifestCoordinates(readManifest(dir)!).map((c) =>
        isRepositoryCoordinate(c) ? c.skill : c.type,
      ),
    ).toEqual(["pdf", "*"]);
  });

  it("returns null when the file is absent", () => {
    expect(readManifest(tmpdir("spm-man"))).toBeNull();
  });

  it("keeps a long path on one line instead of folding it", () => {
    const dir = tmpdir("spm-man");
    const longPath =
      "/Users/someone/Library/Application Support/tool/plugins/managed/kimi-cu/skills";

    writeManifest(dir, {
      installDirs: [],
      repositories: { "kimi-cu": { type: "local", path: longPath } },
      aliases: {},
      skills: [],
    });

    expect(fs.readFileSync(manifestPath(dir), "utf8")).toContain(longPath);
    expect(readManifest(dir)!.repositories["kimi-cu"]!.path).toBe(longPath);
  });

  it("writes deterministic output so diffs stay small", () => {
    const a = tmpdir("spm-man");
    const b = tmpdir("spm-man");

    writeManifest(a, {
      installDirs: [],
      repositories: { zeta: { type: "local", path: "/z" }, alpha: { type: "local", path: "/a" } },
      aliases: { zulu: "path:/z", alpha2: "path:/a" },
      skills: ["local:zeta:two", "local:alpha:one"],
    });
    writeManifest(b, {
      installDirs: [],
      repositories: { alpha: { type: "local", path: "/a" }, zeta: { type: "local", path: "/z" } },
      aliases: { alpha2: "path:/a", zulu: "path:/z" },
      skills: ["local:alpha:one", "local:zeta:two"],
    });

    expect(fs.readFileSync(manifestPath(a), "utf8")).toBe(
      fs.readFileSync(manifestPath(b), "utf8"),
    );
  });

  it("omits empty sections rather than writing them as null", () => {
    const dir = tmpdir("spm-man");
    writeManifest(dir, empty());
    expect(fs.readFileSync(manifestPath(dir), "utf8").trim()).toBe("{}");
  });

  it("rejects a repository entry carrying a type other than local", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(
      manifestPath(dir),
      "repositories:\n  remote:\n    type: github\n    path: /x\n",
      "utf8",
    );
    expect(() => readManifest(dir)).toThrow(/invalid/);
  });

  it("rejects a repository entry with no path", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(manifestPath(dir), "repositories:\n  mine:\n    type: local\n", "utf8");
    expect(() => readManifest(dir)).toThrow(/invalid/);
  });

  it("rejects a repository name that would escape the source cache", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(
      manifestPath(dir),
      'repositories:\n  "../evil":\n    type: local\n    path: /x\n',
      "utf8",
    );
    expect(() => readManifest(dir)).toThrow(/unusable repository name/);
  });

  it("rejects an unknown top-level key, naming it", () => {
    // The old format's `sources:` block: stripping it silently would drop
    // every repository declaration the user wrote.
    const dir = tmpdir("spm-man");
    fs.writeFileSync(manifestPath(dir), "sources:\n  mine:\n    path: /x\n", "utf8");
    expect(() => readManifest(dir)).toThrow(/Unrecognized key: "sources"/);
  });

  it("rejects a skill entry that is not a coordinate", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(manifestPath(dir), "skills:\n  - mine:pdf-fill\n", "utf8");
    expect(() => readManifest(dir)).toThrow(
      /invalid skill coordinate "mine:pdf-fill": 2 segments instead of 3/,
    );
  });

  it("rejects a coordinate whose type mismatches its repository", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(manifestPath(dir), "skills:\n  - github:mine:pdf\n", "utf8");
    expect(() => readManifest(dir)).toThrow(/not a github repository — expected owner\/name/);
  });

  it("rejects an alias name that could not be a coordinate segment", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(
      manifestPath(dir),
      'aliases:\n  "../evil": path:/x\n',
      "utf8",
    );
    expect(() => readManifest(dir)).toThrow(/unusable alias name/);
  });

  it("rejects an alias that names a whole repository", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(manifestPath(dir), "aliases:\n  mine: local:other:*\n", "utf8");
    expect(() => readManifest(dir)).toThrow(/as a whole repository/);
  });

  it("rejects an alias that names another alias", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(manifestPath(dir), "aliases:\n  mine: alias:other\n", "utf8");
    expect(() => readManifest(dir)).toThrow(/as another alias/);
  });

  it("rejects an alias whose target is not a coordinate", () => {
    const dir = tmpdir("spm-man");
    fs.writeFileSync(manifestPath(dir), "aliases:\n  mine: /plain/dir\n", "utf8");
    expect(() => readManifest(dir)).toThrow(/declares the alias "mine" as "\/plain\/dir"/);
  });
});

describe("addSkillEntry", () => {
  it("does not duplicate an identical coordinate", () => {
    const m = empty();
    expect(addSkillEntry(m, parseCoordinate("local:a:x"))).toBe(true);
    expect(addSkillEntry(m, parseCoordinate("local:a:x"))).toBe(false);
    expect(m.skills).toEqual(["local:a:x"]);
  });

  it("skips a skill a whole-repository entry already covers", () => {
    const m = empty();
    addSkillEntry(m, parseCoordinate("local:a:*"));
    expect(addSkillEntry(m, parseCoordinate("local:a:x"))).toBe(false);
    expect(m.skills).toEqual(["local:a:*"]);
  });

  it("replaces individual entries when the whole repository is added", () => {
    const m = empty();
    addSkillEntry(m, parseCoordinate("local:a:x"));
    addSkillEntry(m, parseCoordinate("local:a:y"));
    addSkillEntry(m, parseCoordinate("local:b:z"));
    addSkillEntry(m, parseCoordinate("local:a:*"));

    expect(m.skills).toContain("local:a:*");
    expect(m.skills).toContain("local:b:z");
    expect(m.skills).not.toContain("local:a:x");
    expect(m.skills).not.toContain("local:a:y");
  });

  it("keeps a local and a github repository of the same name apart", () => {
    const m = empty();
    addSkillEntry(m, parseCoordinate("local:b:*"));
    expect(addSkillEntry(m, parseCoordinate("github:a/b:x"))).toBe(true);
    expect(m.skills).toEqual(["local:b:*", "github:a/b:x"]);
  });

  it("never lets one path entry stand for another", () => {
    const m = empty();
    expect(addSkillEntry(m, parseCoordinate("path:/x/skills/pdf"))).toBe(true);
    expect(addSkillEntry(m, parseCoordinate("path:/x/skills/pdf"))).toBe(false);
    expect(addSkillEntry(m, parseCoordinate("path:/x/skills/other"))).toBe(true);
    expect(addSkillEntry(m, parseCoordinate("local:mine:*"))).toBe(true);
    expect(m.skills).toEqual([
      "path:/x/skills/pdf",
      "path:/x/skills/other",
      "local:mine:*",
    ]);
  });
});

describe("removeSkillEntry", () => {
  it("reports whether it changed anything", () => {
    const m: Manifest = {
      installDirs: [],
      repositories: {},
      aliases: {},
      skills: ["local:a:x", "local:b:y"],
    };
    expect(removeSkillEntry(m, parseCoordinate("local:a:x"))).toBe(true);
    expect(removeSkillEntry(m, parseCoordinate("local:a:x"))).toBe(false);
    expect(m.skills).toEqual(["local:b:y"]);
  });

  it("removes every entry a predicate accepts", () => {
    const m: Manifest = {
      installDirs: [],
      repositories: {},
      aliases: {},
      skills: ["local:a:x", "local:a:y", "local:b:z"],
    };
    expect(removeSkillEntries(m, (entry) => entry.startsWith("local:a:"))).toBe(2);
    expect(m.skills).toEqual(["local:b:z"]);
  });
});

describe("upsertRepository", () => {
  it("adds, updates, and reports no-op writes", () => {
    const m = empty();
    expect(upsertRepository(m, "mine", { type: "local", path: "/x" })).toBe(true);
    expect(upsertRepository(m, "mine", { type: "local", path: "/x" })).toBe(false);
    expect(upsertRepository(m, "mine", { type: "local", path: "/y" })).toBe(true);
    expect(m.repositories["mine"]).toEqual({ type: "local", path: "/y" });
  });
});

describe("upsertAlias", () => {
  it("adds, retargets, and reports no-op writes", () => {
    const m = empty();
    expect(upsertAlias(m, "md-lint", "path:/x/md-lint")).toBe(true);
    expect(upsertAlias(m, "md-lint", "path:/x/md-lint")).toBe(false);
    expect(upsertAlias(m, "md-lint", "path:/y/md-lint")).toBe(true);
    expect(m.aliases["md-lint"]).toBe("path:/y/md-lint");
  });

  it("keeps a repository and an alias of the same name apart", () => {
    const m = empty();
    upsertRepository(m, "md-lint", { type: "local", path: "/x" });
    expect(upsertAlias(m, "md-lint", "path:/y/md-lint")).toBe(true);
    expect(m.repositories["md-lint"]).toEqual({ type: "local", path: "/x" });
    expect(m.aliases["md-lint"]).toBe("path:/y/md-lint");
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
