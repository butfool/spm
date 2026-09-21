import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spmHome } from "../src/config.js";
import {
  installDirsFor,
  installSkills,
  inspectTargets,
  uninstallSkills,
} from "../src/core/install.js";
import { readManifest, writeManifest, type Manifest } from "../src/core/manifest.js";
import {
  expandSelections,
  projectScope,
  resolveManifestEntries,
  resolveSpec,
  SkillResolutionError,
  type ResolveContext,
  type Scope,
} from "../src/core/resolve.js";
import { describeLocal, registerLocal, sourcePath } from "../src/core/source.js";
import type { SpmError } from "../src/errors.js";
import { clearHome, entries, tmpdir, useTempHome, writeSkill, writeSkillFile } from "./helpers.js";

let home: string;
let repo: string;
let project: string;
let scope: Scope;

beforeEach(() => {
  ({ home } = useTempHome());
  repo = tmpdir("spm-repo");
  writeSkill(repo, "alpha", "alpha");
  writeSkill(repo, "beta", "beta");
  project = tmpdir("spm-proj");
  scope = projectScope(project);
});

afterEach(clearHome);

/** The resolution context of a project that declares nothing of its own. */
function ctx(manifest: Manifest | null = null, register = true): ResolveContext {
  return { manifest, manifestDir: project, global: false, register };
}

/** Registers the fixture directory and returns a manifest declaring it. */
function setup(installDirs = [".agents/skills"], skills = ["local:fixture:*"]): Manifest {
  registerLocal(repo, "fixture");
  return {
    installDirs,
    repositories: { fixture: { type: "local", path: repo } },
    aliases: {},
    skills,
  };
}

/**
 * Writes the global manifest, which is where the alias table lives. The test
 * home doubles as SPM_HOME, so `$HOME` and the manifest directory agree.
 */
function writeAliasTable(aliases: Record<string, string>): void {
  writeManifest(spmHome(), {
    installDirs: [],
    repositories: {},
    aliases,
    skills: [],
  });
}

async function link(manifest: Manifest): Promise<ReturnType<typeof installSkills>> {
  const { targets } = expandSelections(
    await resolveManifestEntries(manifest, {
      manifestDir: project,
      global: false,
      register: true,
    }),
  );
  return installSkills(targets, manifest, scope, { prune: true });
}

describe("install", () => {
  it("links every declared skill into the install directory", async () => {
    const result = await link(setup());

    expect(result.links).toHaveLength(2);
    expect(result.links.every((l) => l.action === "created")).toBe(true);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha", "beta"]);
  });

  it("creates links that resolve to the skill's SKILL.md", async () => {
    await link(setup());
    const skillFile = path.join(project, ".agents/skills/alpha/SKILL.md");

    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.readFileSync(skillFile, "utf8")).toContain("name: alpha");
  });

  it("is idempotent — a second run changes nothing", async () => {
    const manifest = setup();
    await link(manifest);

    const before = entries(path.join(project, ".agents/skills"));
    const second = await link(manifest);

    expect(second.links.every((l) => l.action === "unchanged")).toBe(true);
    expect(second.removed).toEqual([]);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(before);
  });

  it("links into every declared install directory", async () => {
    await link(setup([".agents/skills", ".claude/skills"]));

    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha", "beta"]);
    expect(entries(path.join(project, ".claude/skills"))).toEqual(["alpha", "beta"]);
  });

  it("resolves relative install dirs against the manifest, not the cwd", () => {
    const manifest = setup(["nested/skills"]);
    expect(installDirsFor(manifest, scope)).toEqual([path.join(project, "nested/skills")]);
  });

  it("removes a link the manifest no longer declares", async () => {
    const manifest = setup();
    await link(manifest);

    manifest.skills = ["local:fixture:alpha"];
    const result = await link(manifest);

    expect(result.removed.map((r) => r.skillName)).toEqual(["beta"]);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha"]);
  });

  it("prunes from every install directory when the scope has several", async () => {
    const manifest = setup([".agents/skills", ".claude/skills"]);
    await link(manifest);

    manifest.skills = ["local:fixture:alpha"];
    await link(manifest);

    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha"]);
    expect(entries(path.join(project, ".claude/skills"))).toEqual(["alpha"]);
  });

  it("leaves hand-made links alone — only links into the source cache are pruned", async () => {
    const manifest = setup();
    await link(manifest);

    const foreign = tmpdir("spm-foreign");
    writeSkill(foreign, "mine", "mine");
    const target = path.join(project, ".agents/skills/mine");
    fs.symlinkSync(path.join(foreign, "mine"), target);

    const result = await link(manifest);

    expect(result.removed).toEqual([]);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha", "beta", "mine"]);
  });

  it("prunes a link to a skill directory the manifest dropped", async () => {
    // A `path:` coordinate links into the source cache like everything else,
    // so dropping the declaration is enough to have the link cleaned up.
    const lone = writeSkill(tmpdir("spm-lone"), "", "mine");
    const manifest: Manifest = {
      installDirs: [".agents/skills"],
      repositories: {},
      aliases: {},
      skills: [`path:${lone}`],
    };
    await link(manifest);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["mine"]);

    const after = await link({ ...manifest, skills: [] });

    expect(after.removed.map((r) => r.skillName)).toEqual(["mine"]);
    expect(entries(path.join(project, ".agents/skills"))).toEqual([]);
  });

  it("refuses to clobber a real directory, and reports it", async () => {
    const manifest = setup();
    fs.mkdirSync(path.join(project, ".agents/skills/alpha"), { recursive: true });

    const result = await link(manifest);
    const blocked = result.links.filter((l) => l.action === "blocked");

    expect(blocked.map((l) => l.skillName)).toEqual(["alpha"]);
    expect(blocked[0]!.reason).toMatch(/real directory/);
  });

  it("overwrites a blocking entry under --force", async () => {
    const manifest = setup();
    fs.mkdirSync(path.join(project, ".agents/skills/alpha"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agents/skills/alpha/junk"), "x");

    const { targets } = expandSelections(
      await resolveManifestEntries(manifest, {
        manifestDir: project,
        global: false,
        register: true,
      }),
    );
    const result = installSkills(targets, manifest, scope, { force: true, prune: true });

    expect(result.links.find((l) => l.skillName === "alpha")!.action).toBe("replaced");
    expect(fs.existsSync(path.join(project, ".agents/skills/alpha/SKILL.md"))).toBe(true);
  });

  it("repoints a link stolen by another tool", async () => {
    const manifest = setup();
    await link(manifest);

    const elsewhere = tmpdir("spm-elsewhere");
    const linkPath = path.join(project, ".agents/skills/alpha");
    fs.unlinkSync(linkPath);
    fs.symlinkSync(elsewhere, linkPath);

    const result = await link(manifest);
    expect(result.links.find((l) => l.skillName === "alpha")!.action).toBe("replaced");
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(path.join(repo, "alpha")));
  });

  it("registers a declared repository that isn't registered yet", async () => {
    // The directory is declared but nothing was registered: this is the state a
    // fresh machine starts from.
    const manifest: Manifest = {
      installDirs: [".agents/skills"],
      repositories: { fixture: { type: "local", path: repo } },
      aliases: {},
      skills: ["local:fixture:*"],
    };
    expect(describeLocal("fixture")).toBeNull();

    const result = await link(manifest);

    expect(describeLocal("fixture")).not.toBeNull();
    expect(result.links).toHaveLength(2);
  });

  it("refuses to resolve a declared but unregistered repository when told not to register", async () => {
    const manifest: Manifest = {
      installDirs: [],
      repositories: { fixture: { type: "local", path: repo } },
      aliases: {},
      skills: ["local:fixture:*"],
    };

    await expect(
      resolveManifestEntries(manifest, {
        manifestDir: project,
        global: false,
        register: false,
      }),
    ).rejects.toThrow(/declared but not registered on this machine/);
  });

  it("names the registered repository when a coordinate names an unknown one", async () => {
    await expect(resolveSpec("local:ghost:alpha", ctx())).rejects.toThrow(
      /unknown local repository "ghost"/,
    );
  });
});

describe("inspectTargets", () => {
  it("reports ok, missing, and foreign states per install directory", async () => {
    const manifest = setup([".agents/skills", ".claude/skills"]);
    const { targets } = expandSelections(
      await resolveManifestEntries(manifest, {
        manifestDir: project,
        global: false,
        register: true,
      }),
    );

    await link(manifest);
    fs.unlinkSync(path.join(project, ".claude/skills/beta"));
    // mkdir on a symlink-to-directory would succeed and follow the link, so
    // replace it explicitly to simulate a real directory squatting there.
    const squatted = path.join(project, ".claude/skills/alpha");
    fs.unlinkSync(squatted);
    fs.mkdirSync(squatted, { recursive: true });

    const states = inspectTargets(targets, manifest, scope);

    const alpha = states.find((s) => s.name === "alpha")!;
    expect(alpha.dirs.map((d) => d.state)).toEqual(["ok", "foreign"]);
    expect(alpha.source).toBe("local:fixture");

    const beta = states.find((s) => s.name === "beta")!;
    expect(beta.dirs.map((d) => d.state)).toEqual(["ok", "missing"]);
  });
});

describe("uninstallSkills", () => {
  it("removes links for the named skills from every install directory", async () => {
    const manifest = setup([".agents/skills", ".claude/skills"]);
    await link(manifest);

    const removed = uninstallSkills(["alpha"], manifest, scope);

    expect(removed).toHaveLength(2);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["beta"]);
    expect(entries(path.join(project, ".claude/skills"))).toEqual(["beta"]);
  });
});

describe("registerLocal", () => {
  it("registers a directory of skills", () => {
    expect(registerLocal(repo, "mine").status).toBe("created");
    expect(describeLocal("mine")?.target).toBe(repo);
  });

  it("refuses a directory that is itself one skill", () => {
    const lone = writeSkill(tmpdir("spm-lone-source"), "", "mine");

    expect(() => registerLocal(lone, "mine")).toThrow(
      /is a skill directory, not a repository/,
    );
    // Refused before anything was created.
    expect(describeLocal("mine")).toBeNull();
  });
});

describe("resolveSpec", () => {
  it("registers a path spec under its declared repository name", async () => {
    fs.writeFileSync(path.join(repo, "skill-repository.yaml"), "name: mine\n", "utf8");

    const selection = await resolveSpec(repo, ctx());

    expect(selection.type).toBe("local");
    expect(selection.id).toBe("mine");
    expect(selection.entry).toBe("local:mine:*");
    expect(selection.skills).toBe("*");
    expect(selection.declaration).toEqual({ name: "mine", path: repo });
  });

  it("resolves a coordinate against a declared repository", async () => {
    const manifest = setup();
    const selection = await resolveSpec("local:fixture:alpha", ctx(manifest));

    expect(selection.id).toBe("fixture");
    expect(selection.entry).toBe("local:fixture:alpha");
    expect(selection.skills).toEqual(["alpha"]);
    expect(selection.declaration).toBeNull();
  });

  it("accepts the type segment left out of a known repository name", async () => {
    const manifest = setup();

    expect((await resolveSpec("fixture", ctx(manifest))).entry).toBe("local:fixture:*");
    expect((await resolveSpec("fixture:alpha", ctx(manifest))).entry).toBe(
      "local:fixture:alpha",
    );
    expect((await resolveSpec("local:fixture", ctx(manifest))).entry).toBe("local:fixture:*");
  });

  it("reuses an existing registration for a path instead of duplicating it", async () => {
    const manifest = setup(); // registers the directory and declares it as "fixture"

    const selection = await resolveSpec(repo, ctx(manifest));

    expect(selection.id).toBe("fixture");
    expect(selection.entry).toBe("local:fixture:*");
    // Already declared for this scope, so nothing is written again.
    expect(selection.declaration).toBeNull();
  });

  it("prefers a repository name over a same-named skill elsewhere", async () => {
    const manifest = setup();
    const other = tmpdir("spm-other");
    writeSkill(other, "fixture", "fixture"); // a skill literally named "fixture"
    registerLocal(other, "other");

    const selection = await resolveSpec("fixture", ctx(manifest));

    expect(selection.entry).toBe("local:fixture:*");
    expect(selection.skills).toBe("*");
  });

  it("looks up a bare skill name across registered repositories", async () => {
    setup();
    const selection = await resolveSpec("beta", ctx());

    expect(selection.id).toBe("fixture");
    expect(selection.entry).toBe("local:fixture:beta");
    expect(selection.skills).toEqual(["beta"]);
  });

  it("refuses an ambiguous bare name", async () => {
    setup();
    const other = tmpdir("spm-other");
    writeSkill(other, "beta", "beta");
    registerLocal(other, "other");

    await expect(resolveSpec("beta", ctx())).rejects.toThrow(/exists in 2 repositories/);
  });

  it("installs a skill directory inside a registered repository by path", async () => {
    setup();

    const selection = await resolveSpec(path.join(repo, "alpha"), ctx());

    expect(selection.type).toBe("path");
    expect(selection.entry).toBe(`path:${path.join(repo, "alpha")}`);
    expect(selection.skills).toEqual(["alpha"]);
    // Nothing is registered: the directory is the skill.
    expect(selection.declaration).toBeNull();
  });

  it("refuses a path coordinate for a directory that is not a skill directory", async () => {
    const plain = tmpdir("spm-plain");
    writeSkill(plain, "one", "one");
    writeSkill(plain, "two", "two");

    await expect(resolveSpec(`path:${plain}`, ctx())).rejects.toThrow(
      /is not a skill directory — it holds 2 skills/,
    );
    await expect(resolveSpec(`path:${path.join(plain, "nowhere")}`, ctx())).rejects.toThrow(
      /is not a directory/,
    );
  });

  it("refuses a path coordinate for a repository that happens to hold one skill", async () => {
    const one = tmpdir("spm-one-skill");
    writeSkill(one, "solo", "solo");

    // The directory itself holds no SKILL.md, so it is a directory of skills
    // however few they are.
    const run = resolveSpec(`path:${one}`, ctx());

    await expect(run).rejects.toThrow(/is not a skill directory — it holds 1 skill/);
    await run.catch((err: SpmError) => {
      expect(err.hint).toMatch(/spm repository add/);
    });
  });

  it("refuses --name for a skill directory, which has no repository to name", async () => {
    await expect(
      resolveSpec(path.join(repo, "alpha"), { ...ctx(), name: "mine" }),
    ).rejects.toThrow(/--name does not apply/);
  });

  it("points at the enclosing repository instead of registering a subdirectory", async () => {
    setup();
    // A directory that is not itself a skill has no path form, so naming one
    // inside a registered repository stays an error.
    const nested = path.join(repo, "alpha", "references");
    fs.mkdirSync(nested, { recursive: true });

    await expect(resolveSpec(nested, ctx())).rejects.toThrow(
      /inside the registered local repository "fixture"/,
    );
  });

  it("refuses to register a path under a name that already points elsewhere", async () => {
    const elsewhere = tmpdir("spm-elsewhere");
    writeSkill(elsewhere, "gamma", "gamma");
    fs.writeFileSync(path.join(repo, "skill-repository.yaml"), "name: mine\n", "utf8");
    registerLocal(elsewhere, "mine");
    const manifest: Manifest = {
      installDirs: [],
      repositories: { mine: { type: "local", path: elsewhere } },
      aliases: {},
      skills: [],
    };

    await expect(resolveSpec(repo, ctx(manifest))).rejects.toThrow(
      /local repository "mine" already points at/,
    );
  });

  it("treats an unregistered two-segment spec as a github repository", async () => {
    // `nope/x` is a github coordinate by shape. The failure must be about the
    // clone, not a confusing repository-name error.
    await expect(
      resolveSpec("nope/definitely-not-a-real-repo-xyz", ctx()),
    ).rejects.toThrow(/clone failed|not found|Could not resolve/i);
  }, 30_000);

  it("reports a skill that does not exist, listing what is available", async () => {
    const manifest = setup();
    const run = resolveManifestEntries(
      { ...manifest, skills: ["local:fixture:ghost"] },
      { manifestDir: project, global: false, register: true },
    ).then(expandSelections);

    await expect(run).rejects.toThrow(/skill "ghost" not found in local:fixture:ghost/);
    // The list of alternatives is a hint, so it survives `--quiet`.
    await run.catch((err: SpmError) => {
      expect(err.hint).toMatch(/Available: alpha, beta/);
    });
  });
});

describe("alias coordinates", () => {
  it("installs the skill an alias names, recording the alias itself", async () => {
    const lone = writeSkill(tmpdir("spm-alias-one"), "", "mine");
    writeAliasTable({ mine: `path:${lone}` });

    const selection = await resolveSpec("alias:mine", ctx());

    expect(selection.type).toBe("alias");
    expect(selection.id).toBe("mine");
    expect(selection.entry).toBe("alias:mine");
    expect(selection.label).toBe("alias:mine");
    expect(selection.skills).toEqual(["mine"]);
    // Nothing is registered and nothing is declared: the table answers.
    expect(selection.declaration).toBeNull();
  });

  it("links the skill and stays idempotent", async () => {
    const lone = writeSkill(tmpdir("spm-alias-two"), "", "mine");
    writeAliasTable({ mine: `path:${lone}` });
    const manifest: Manifest = {
      installDirs: [".agents/skills"],
      repositories: {},
      aliases: {},
      skills: ["alias:mine"],
    };

    const first = await link(manifest);
    const second = await link(manifest);

    expect(first.links[0]!.action).toBe("created");
    expect(second.links[0]!.action).toBe("unchanged");
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["mine"]);
    expect(readManifest(project)).toBeNull();
  });

  it("resolves a relative target against $HOME, not against the project", async () => {
    const lone = writeSkill(path.join(os.homedir(), "aliased"), "", "mine");
    writeAliasTable({ mine: "path:aliased" });

    const selection = await resolveSpec("alias:mine", ctx());

    expect(selection.skills).toEqual(["mine"]);
    expect(fs.realpathSync(selection.root)).toBe(fs.realpathSync(lone));
  });

  it("names one skill out of a registered repository", async () => {
    registerLocal(repo, "fixture");
    writeAliasTable({ alpha: "local:fixture:alpha" });

    const selection = await resolveSpec("alias:alpha", ctx());

    expect(selection.type).toBe("alias");
    expect(selection.skills).toEqual(["alpha"]);
  });

  it("reports an unknown alias with a way forward", async () => {
    writeAliasTable({});

    const run = resolveSpec("alias:ghost", ctx());

    await expect(run).rejects.toThrow(/unknown alias "ghost"/);
    await run.catch((err: SpmError) => {
      expect(err.hint).toMatch(/spm alias add ghost/);
    });
  });

  it("reports an alias whose target directory is gone", async () => {
    writeAliasTable({ mine: "path:/nowhere/at/all" });

    await expect(resolveSpec("alias:mine", ctx())).rejects.toThrow(/is not a directory/);
  });

  it("keeps an alias and a repository of the same name apart", async () => {
    const lone = writeSkill(tmpdir("spm-alias-three"), "", "lone");
    registerLocal(repo, "mine");
    writeAliasTable({ mine: `path:${lone}` });

    // Two tables, two namespaces: the type segment decides which one answers.
    expect((await resolveSpec("local:mine:alpha", ctx())).skills).toEqual(["alpha"]);
    expect((await resolveSpec("alias:mine", ctx())).skills).toEqual(["lone"]);
  });
});

describe("expandSelections", () => {
  it("fails when the same skill name comes from two repositories", async () => {
    const twin = tmpdir("spm-twin");
    writeSkill(twin, "alpha", "alpha");
    registerLocal(repo, "one");
    registerLocal(twin, "two");

    const manifest: Manifest = {
      installDirs: [],
      repositories: {
        one: { type: "local", path: repo },
        two: { type: "local", path: twin },
      },
      aliases: {},
      skills: ["local:one:*", "local:two:*"],
    };

    await expect(
      resolveManifestEntries(manifest, {
        manifestDir: project,
        global: false,
        register: true,
      }).then(expandSelections),
    ).rejects.toThrow(/provided by two repositories/);
  });

  it("says so when two declarations reach the same skill directory", async () => {
    registerLocal(repo, "fixture");
    const manifest: Manifest = {
      installDirs: [],
      repositories: { fixture: { type: "local", path: repo } },
      aliases: {},
      // The same directory, named once through the repository and once
      // directly. "Pick a repository" would be the wrong advice here.
      skills: ["local:fixture:alpha", `path:${path.join(repo, "alpha")}`],
    };

    await expect(
      resolveManifestEntries(manifest, {
        manifestDir: project,
        global: false,
        register: true,
      }).then(expandSelections),
    ).rejects.toThrow(/declared twice for the same directory/);
  });

  it("keeps two different directories of the same skill name apart in the message", async () => {
    registerLocal(repo, "fixture");
    const twin = writeSkill(tmpdir("spm-twin-name"), "", "alpha");
    const manifest: Manifest = {
      installDirs: [],
      repositories: { fixture: { type: "local", path: repo } },
      aliases: {},
      skills: ["local:fixture:alpha", `path:${twin}`],
    };

    await expect(
      resolveManifestEntries(manifest, {
        manifestDir: project,
        global: false,
        register: true,
      }).then(expandSelections),
    ).rejects.toThrow(/provided by two repositories/);
  });

  it("returns the usable skills and reports the skipped files", async () => {
    const manifest = setup();
    writeSkillFile(repo, "broken", "---\nname: Broken\ndescription: x\n---\n");

    const { targets, skipped } = expandSelections(
      await resolveManifestEntries(manifest, {
        manifestDir: project,
        global: false,
        register: true,
      }),
    );

    expect(targets.map((t) => t.name)).toEqual(["alpha", "beta"]);
    expect(skipped.map((s) => `${s.source}/${s.relativePath}`)).toEqual([
      "local:fixture/broken/SKILL.md",
    ]);
    expect(skipped[0]!.reason).toMatch(/may only contain lowercase letters/);
  });

  it("carries the skipped files on the error when a selection resolves to nothing", async () => {
    const onlyInvalid = tmpdir("spm-invalid-only");
    writeSkillFile(onlyInvalid, "broken", "---\nname: Broken\ndescription: x\n---\n");
    registerLocal(onlyInvalid, "broken-source");

    const manifest: Manifest = {
      installDirs: [],
      repositories: { "broken-source": { type: "local", path: onlyInvalid } },
      aliases: {},
      skills: ["local:broken-source:*"],
    };

    const run = resolveManifestEntries(manifest, {
      manifestDir: project,
      global: false,
      register: true,
    }).then(expandSelections);

    await expect(run).rejects.toThrow(/local:broken-source:\* contains no usable skills/);
    await run.catch((err: SkillResolutionError) => {
      expect(err).toBeInstanceOf(SkillResolutionError);
      expect(err.skipped.map((s) => s.relativePath)).toEqual(["broken/SKILL.md"]);
      expect(err.hint).toMatch(/broken\/SKILL\.md/);
    });
  });
});

describe("manifest persistence through install", () => {
  it("keeps the manifest readable after a reconcile", async () => {
    const manifest = setup();
    await link(manifest);

    // The install path must not have rewritten the manifest.
    expect(manifest.skills).toEqual(["local:fixture:*"]);
    expect(sourcePath("local", "fixture")).toBe(path.join(home, "sources", "local", "fixture"));
    expect(readManifest(project)).toBeNull();
  });
});
