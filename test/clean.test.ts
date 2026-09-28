import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectsDir } from "../src/config.js";
import { cleanSources } from "../src/core/clean.js";
import { writeManifest, type Manifest } from "../src/core/manifest.js";
import { registerProjectManifest } from "../src/core/project-registry.js";
import {
  ensurePathSource,
  githubSourcePath,
  localSourcePath,
  registerLocal,
} from "../src/core/source.js";
import { clearHome, tmpdir, useTempHome, writeSkill } from "./helpers.js";

let home: string;

beforeEach(() => {
  ({ home } = useTempHome());
});

afterEach(clearHome);

describe("source cache cleaning", () => {
  it("marks all source kinds and removes only unreachable managed entries", async () => {
    const project = tmpdir("spm-clean-project");
    const repo = tmpdir("spm-clean-repo");
    const globalRepo = tmpdir("spm-clean-global-repo");
    const orphanRepo = tmpdir("spm-clean-orphan-repo");
    const pathSkill = writeSkill(tmpdir("spm-clean-path"), "kept", "kept");
    const aliasSkill = writeSkill(tmpdir("spm-clean-alias-path"), "aliased", "aliased");
    const orphanSkill = writeSkill(tmpdir("spm-clean-orphan-path"), "orphan", "orphan");
    writeSkill(repo, "repo-skill", "repo-skill");
    writeSkill(globalRepo, "global-skill", "global-skill");
    writeSkill(orphanRepo, "old", "old");

    registerLocal(repo, "project-repo");
    registerLocal(globalRepo, "global-used");
    registerLocal(orphanRepo, "orphan-repo");
    const keptPathEntry = ensurePathSource(pathSkill);
    const aliasPathEntry = ensurePathSource(aliasSkill);
    const orphanPathEntry = ensurePathSource(orphanSkill);
    fs.mkdirSync(githubSourcePath("owner/shared"), { recursive: true });
    fs.mkdirSync(githubSourcePath("owner/orphan"), { recursive: true });
    const foreignLocal = localSourcePath("foreign-dir");
    fs.mkdirSync(foreignLocal, { recursive: true });

    writeManifest(project, manifest({
      repositories: { "project-repo": { type: "local", path: repo } },
      skills: [
        "local:project-repo:*",
        "local:global-used:*",
        `path:${pathSkill}`,
        "github:owner/shared:*",
        "alias:used",
      ],
    }));
    registerProjectManifest(project);

    const declaredRepo = tmpdir("spm-clean-declared-repo");
    writeSkill(declaredRepo, "declared", "declared");
    registerLocal(declaredRepo, "declared-only");
    writeManifest(home, manifest({
      repositories: {
        "global-used": { type: "local", path: globalRepo },
        "declared-only": { type: "local", path: declaredRepo },
      },
      aliases: { used: `path:${aliasSkill}`, spare: `path:${pathSkill}` },
    }));

    const preview = await cleanSources(true);
    expect(stateOf(preview, "local", "project-repo")).toBe("referenced");
    expect(stateOf(preview, "local", "global-used")).toBe("referenced");
    expect(stateOf(preview, "local", "declared-only")).toBe("declared");
    expect(stateOf(preview, "path", path.basename(keptPathEntry))).toBe("referenced");
    expect(stateOf(preview, "path", path.basename(aliasPathEntry))).toBe("referenced");
    expect(stateOf(preview, "github", "owner/shared")).toBe("broken");
    expect(stateOf(preview, "local", "orphan-repo")).toBe("unused");
    expect(stateOf(preview, "path", path.basename(orphanPathEntry))).toBe("unused");
    expect(stateOf(preview, "github", "owner/orphan")).toBe("unused");
    expect(stateOf(preview, "local", "foreign-dir")).toBe("foreign");
    expect(preview.unusedRepositories.map((entry) => entry.name)).toEqual(["declared-only"]);
    expect(preview.unusedAliases.map((entry) => entry.name)).toEqual(["spare"]);
    expect(fs.existsSync(localSourcePath("orphan-repo"))).toBe(true);
    expect(fs.existsSync(orphanPathEntry)).toBe(true);

    const cleaned = await cleanSources(false);
    expect(cleaned.removed).toEqual([
      "github:owner/orphan",
      "local:orphan-repo",
      `path:${path.basename(orphanPathEntry)}`,
    ]);
    expect(fs.existsSync(localSourcePath("orphan-repo"))).toBe(false);
    expect(fs.existsSync(orphanPathEntry)).toBe(false);
    expect(fs.existsSync(githubSourcePath("owner/orphan"))).toBe(false);
    expect(fs.existsSync(orphanRepo)).toBe(true);
    expect(fs.existsSync(orphanSkill)).toBe(true);
    expect(fs.existsSync(githubSourcePath("owner/shared"))).toBe(true);
    expect(fs.existsSync(localSourcePath("declared-only"))).toBe(true);
    expect(fs.existsSync(foreignLocal)).toBe(true);

    const second = await cleanSources(false);
    expect(second.pending).toBe(0);
    expect(second.removed).toEqual([]);
  });

  it("keeps a shared cache until its final project root disappears", async () => {
    const first = tmpdir("spm-clean-shared-first");
    const second = tmpdir("spm-clean-shared-second");
    writeManifest(first, manifest({ skills: ["github:owner/shared:*"] }));
    writeManifest(second, manifest({ skills: ["github:owner/shared:*"] }));
    registerProjectManifest(first);
    registerProjectManifest(second);
    fs.mkdirSync(githubSourcePath("owner/shared"), { recursive: true });

    const shared = await cleanSources(true);
    const entry = shared.entries.find((item) => item.id === "owner/shared");
    expect(entry?.state).toBe("broken");
    expect(entry?.references).toHaveLength(2);

    fs.rmSync(first, { recursive: true });
    await cleanSources(false);
    expect(fs.existsSync(githubSourcePath("owner/shared"))).toBe(true);

    fs.rmSync(second, { recursive: true });
    const final = await cleanSources(false);
    expect(final.removed).toEqual(["github:owner/shared"]);
    expect(fs.existsSync(githubSourcePath("owner/shared"))).toBe(false);
  });

  it("does not delete anything when a live root manifest is invalid", async () => {
    const project = tmpdir("spm-clean-invalid-project");
    const repo = tmpdir("spm-clean-invalid-orphan");
    writeSkill(repo, "old", "old");
    registerLocal(repo, "orphan");

    fs.writeFileSync(path.join(project, "skills.yaml"), "skills: [broken", "utf8");
    fs.mkdirSync(projectsDir(), { recursive: true });
    fs.symlinkSync(path.join(project, "skills.yaml"), path.join(projectsDir(), "invalid"));

    await expect(cleanSources(false)).rejects.toThrow(/not valid YAML/);
    expect(fs.existsSync(localSourcePath("orphan"))).toBe(true);
  });

  it("removes dangling project roots and preserves foreign registry entries", async () => {
    const missingManifest = path.join(tmpdir("spm-clean-missing"), "skills.yaml");
    fs.mkdirSync(projectsDir(), { recursive: true });
    const dangling = path.join(projectsDir(), "dangling");
    const foreign = path.join(projectsDir(), "foreign");
    fs.symlinkSync(missingManifest, dangling);
    fs.writeFileSync(foreign, "mine", "utf8");

    const preview = await cleanSources(true);
    expect(preview.danglingRoots).toHaveLength(1);
    expect(preview.foreignRoots).toEqual([foreign]);
    expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true);

    const cleaned = await cleanSources(false);
    expect(cleaned.danglingRoots[0]?.action).toBe("removed");
    expect(fs.existsSync(dangling)).toBe(false);
    expect(fs.readFileSync(foreign, "utf8")).toBe("mine");
  });
});

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    installDirs: [],
    repositories: {},
    aliases: {},
    skills: [],
    ...overrides,
  };
}

function stateOf(
  result: Awaited<ReturnType<typeof cleanSources>>,
  kind: string,
  id: string,
): string | undefined {
  return result.entries.find((entry) => entry.kind === kind && entry.id === id)?.state;
}
