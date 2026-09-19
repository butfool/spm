import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkills, installDirsFor, inspectTargets, uninstallSkills } from "../src/core/install.js";
import { readManifest, type Manifest } from "../src/core/manifest.js";
import {
  expandSelections,
  projectScope,
  resolveManifestEntries,
  resolveSpec,
  SkillResolutionError,
  type Scope,
} from "../src/core/resolve.js";
import { registerLocal, sourcePath } from "../src/core/source.js";
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

/** Registers the fixture repo and returns the manifest declaring it. */
async function setup(
  installDirs: string[] = [".agents/skills"],
  skills = ["fixture/*"],
): Promise<Manifest> {
  registerLocal(repo, "fixture");
  return { installDirs, sources: { fixture: { path: repo } }, skills };
}

async function link(manifest: Manifest): Promise<ReturnType<typeof installSkills>> {
  const { targets } = expandSelections(
    await resolveManifestEntries(manifest, { register: true }),
  );
  return installSkills(targets, manifest, scope, { prune: true });
}

describe("install", () => {
  it("links every declared skill into the install directory", async () => {
    const manifest = await setup();
    const result = await link(manifest);

    expect(result.links).toHaveLength(2);
    expect(result.links.every((l) => l.action === "created")).toBe(true);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha", "beta"]);
  });

  it("creates links that resolve to the skill's SKILL.md", async () => {
    await link(await setup());
    const skillFile = path.join(project, ".agents/skills/alpha/SKILL.md");

    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.readFileSync(skillFile, "utf8")).toContain("name: alpha");
  });

  it("is idempotent — a second run changes nothing", async () => {
    const manifest = await setup();
    await link(manifest);

    const before = entries(path.join(project, ".agents/skills"));
    const second = await link(manifest);

    expect(second.links.every((l) => l.action === "unchanged")).toBe(true);
    expect(second.removed).toEqual([]);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(before);
  });

  it("links into every declared install directory", async () => {
    const manifest = await setup([".agents/skills", ".claude/skills"]);
    await link(manifest);

    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha", "beta"]);
    expect(entries(path.join(project, ".claude/skills"))).toEqual(["alpha", "beta"]);
  });

  it("resolves relative install dirs against the manifest, not the cwd", async () => {
    const manifest = await setup(["nested/skills"]);
    expect(installDirsFor(manifest, scope)).toEqual([path.join(project, "nested/skills")]);
  });

  it("removes a link the manifest no longer declares", async () => {
    const manifest = await setup();
    await link(manifest);

    manifest.skills = ["fixture/alpha"];
    const result = await link(manifest);

    expect(result.removed.map((r) => r.skillName)).toEqual(["beta"]);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha"]);
  });

  it("prunes from every install directory when the scope has several", async () => {
    const manifest = await setup([".agents/skills", ".claude/skills"]);
    await link(manifest);

    manifest.skills = ["fixture/alpha"];
    await link(manifest);

    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha"]);
    expect(entries(path.join(project, ".claude/skills"))).toEqual(["alpha"]);
  });

  it("leaves hand-made links alone — only links into the source cache are pruned", async () => {
    const manifest = await setup();
    await link(manifest);

    const foreign = tmpdir("spm-foreign");
    writeSkill(foreign, "mine", "mine");
    const target = path.join(project, ".agents/skills/mine");
    fs.symlinkSync(path.join(foreign, "mine"), target);

    const result = await link(manifest);

    expect(result.removed).toEqual([]);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["alpha", "beta", "mine"]);
  });

  it("refuses to clobber a real directory, and reports it", async () => {
    const manifest = await setup();
    fs.mkdirSync(path.join(project, ".agents/skills/alpha"), { recursive: true });

    const result = await link(manifest);
    const blocked = result.links.filter((l) => l.action === "blocked");

    expect(blocked.map((l) => l.skillName)).toEqual(["alpha"]);
    expect(blocked[0]!.reason).toMatch(/real directory/);
  });

  it("overwrites a blocking entry under --force", async () => {
    const manifest = await setup();
    fs.mkdirSync(path.join(project, ".agents/skills/alpha"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agents/skills/alpha/junk"), "x");

    const { targets } = expandSelections(
      await resolveManifestEntries(manifest, { register: true }),
    );
    const result = installSkills(targets, manifest, scope, { force: true, prune: true });

    expect(result.links.find((l) => l.skillName === "alpha")!.action).toBe("replaced");
    expect(fs.existsSync(path.join(project, ".agents/skills/alpha/SKILL.md"))).toBe(true);
  });

  it("repoints a link stolen by another tool", async () => {
    const manifest = await setup();
    await link(manifest);

    const elsewhere = tmpdir("spm-elsewhere");
    const linkPath = path.join(project, ".agents/skills/alpha");
    fs.unlinkSync(linkPath);
    fs.symlinkSync(elsewhere, linkPath);

    const result = await link(manifest);
    expect(result.links.find((l) => l.skillName === "alpha")!.action).toBe("replaced");
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(path.join(repo, "alpha")));
  });
});

describe("inspectTargets", () => {
  it("reports ok, missing, and foreign states per install directory", async () => {
    const manifest = await setup([".agents/skills", ".claude/skills"]);
    const { targets } = expandSelections(
      await resolveManifestEntries(manifest, { register: true }),
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

    const beta = states.find((s) => s.name === "beta")!;
    expect(beta.dirs.map((d) => d.state)).toEqual(["ok", "missing"]);
  });
});

describe("uninstallSkills", () => {
  it("removes links for the named skills from every install directory", async () => {
    const manifest = await setup([".agents/skills", ".claude/skills"]);
    await link(manifest);

    const removed = uninstallSkills(["alpha"], manifest, scope);

    expect(removed).toHaveLength(2);
    expect(entries(path.join(project, ".agents/skills"))).toEqual(["beta"]);
    expect(entries(path.join(project, ".claude/skills"))).toEqual(["beta"]);
  });
});

describe("resolveSpec", () => {
  it("resolves a path spec and registers it under its repository name", async () => {
    fs.writeFileSync(path.join(repo, "skill-repository.yaml"), "name: mine\n", "utf8");

    const selection = await resolveSpec(repo, { manifest: null, register: true });

    expect(selection.alias).toBe("mine");
    expect(selection.entry).toBe("mine/*");
    expect(selection.decl).toEqual({ path: repo });
  });

  it("resolves alias specs against a declared source", async () => {
    const manifest = await setup();
    const selection = await resolveSpec("fixture/alpha", { manifest, register: true });

    expect(selection.alias).toBe("fixture");
    expect(selection.entry).toBe("fixture/alpha");
    expect(selection.skills).toEqual(["alpha"]);
  });

  it("treats a bare alias as the whole source", async () => {
    const manifest = await setup();
    const selection = await resolveSpec("fixture", { manifest, register: true });

    expect(selection.alias).toBe("fixture");
    expect(selection.entry).toBe("fixture/*");
    expect(selection.skills).toBe("*");
  });

  it("reuses an existing registration for a path instead of duplicating it", async () => {
    await setup(); // registers the repo under the alias "fixture"

    // The same directory, reached by its real path rather than the alias.
    const selection = await resolveSpec(repo, { manifest: null, register: true });

    expect(selection.alias).toBe("fixture");
    expect(selection.entry).toBe("fixture/*");
  });

  it("prefers a source alias over a same-named skill elsewhere", async () => {
    const manifest = await setup();
    const other = tmpdir("spm-other");
    writeSkill(other, "fixture", "fixture"); // a skill literally named "fixture"
    registerLocal(other, "other");

    const selection = await resolveSpec("fixture", { manifest, register: true });

    expect(selection.entry).toBe("fixture/*");
    expect(selection.skills).toBe("*");
  });

  it("looks up a bare skill name across registered sources", async () => {
    await setup();
    const selection = await resolveSpec("beta", { manifest: null, register: true });

    expect(selection.alias).toBe("fixture");
    expect(selection.skills).toEqual(["beta"]);
  });

  it("refuses an ambiguous bare name", async () => {
    await setup();
    const other = tmpdir("spm-other");
    writeSkill(other, "beta", "beta");
    registerLocal(other, "other");

    await expect(resolveSpec("beta", { manifest: null, register: true })).rejects.toThrow(
      /exists in 2 sources/,
    );
  });

  it("points at the enclosing source instead of double-registering a subdirectory", async () => {
    await setup();
    await expect(
      resolveSpec(path.join(repo, "alpha"), { manifest: null, register: true }),
    ).rejects.toThrow(/inside the already-registered source "fixture"/);
  });

  it("treats an unregistered two-segment spec as a github repository", async () => {
    // `nope/x` is ambiguous by construction; github wins because `nope` is
    // not a known alias. The failure must at least be about the clone, not a
    // confusing alias error.
    await expect(
      resolveSpec("nope/definitely-not-a-real-repo-xyz", { manifest: null, register: true }),
    ).rejects.toThrow(/clone failed|not found/i);
  }, 30_000);

  it("reports a skill that does not exist, listing what is available", async () => {
    const manifest = await setup();
    const run = resolveManifestEntries(
      { ...manifest, skills: ["fixture/ghost"] },
      { register: true },
    ).then(expandSelections);

    await expect(run).rejects.toThrow(/skill "ghost" not found in fixture\/ghost/);
    // The list of alternatives is a hint, so it survives `--quiet`.
    await run.catch((err: SpmError) => {
      expect(err.hint).toMatch(/Available: alpha, beta/);
    });
  });
});

describe("expandSelections", () => {
  it("fails when the same skill name comes from two sources", async () => {
    const twin = tmpdir("spm-twin");
    writeSkill(twin, "alpha", "alpha");
    registerLocal(repo, "one");
    registerLocal(twin, "two");

    const manifest: Manifest = {
      installDirs: [],
      sources: { one: { path: repo }, two: { path: twin } },
      skills: ["one/*", "two/*"],
    };

    await expect(
      resolveManifestEntries(manifest, { register: true }).then(expandSelections),
    ).rejects.toThrow(/provided by two sources/);
  });

  it("returns the usable skills and reports the skipped files", async () => {
    const manifest = await setup();
    writeSkillFile(repo, "broken", "---\nname: Broken\ndescription: x\n---\n");

    const { targets, skipped } = expandSelections(
      await resolveManifestEntries(manifest, { register: true }),
    );

    expect(targets.map((t) => t.name)).toEqual(["alpha", "beta"]);
    expect(skipped.map((s) => `${s.source}/${s.relativePath}`)).toEqual([
      "fixture/broken/SKILL.md",
    ]);
    expect(skipped[0]!.reason).toMatch(/may only contain lowercase letters/);
  });

  it("carries the skipped files on the error when a selection resolves to nothing", async () => {
    const onlyInvalid = tmpdir("spm-invalid-only");
    writeSkillFile(onlyInvalid, "broken", "---\nname: Broken\ndescription: x\n---\n");
    registerLocal(onlyInvalid, "broken-source");

    const manifest: Manifest = {
      installDirs: [],
      sources: { "broken-source": { path: onlyInvalid } },
      skills: ["broken-source/*"],
    };

    const run = resolveManifestEntries(manifest, { register: true }).then(expandSelections);

    await expect(run).rejects.toThrow(/broken-source\/\* contains no usable skills/);
    await run.catch((err: SkillResolutionError) => {
      expect(err).toBeInstanceOf(SkillResolutionError);
      expect(err.skipped.map((s) => s.relativePath)).toEqual(["broken/SKILL.md"]);
      expect(err.hint).toMatch(/broken\/SKILL\.md/);
    });
  });
});

describe("manifest persistence through install", () => {
  it("keeps the manifest readable after a reconcile", async () => {
    const manifest = await setup();
    await link(manifest);

    // The install path must not have rewritten the manifest.
    expect(manifest.skills).toEqual(["fixture/*"]);
    expect(sourcePath("fixture")).toBe(path.join(home, "sources", "fixture"));
    expect(readManifest(project)).toBeNull();
  });
});
