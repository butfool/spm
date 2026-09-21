import fs from "node:fs";
import path from "node:path";
import { isInside, sourcesDir } from "../config.js";
import { exists, isDirectory, isSymlink, linkPointsTo, readLink } from "../fsutil.js";
import { SpmError } from "../errors.js";
import { skippedLine, type SkippedSkill } from "./discover.js";
import { installDirsFor, ownedLinkTarget } from "./install.js";
import type { Manifest } from "./manifest.js";
import { declarationConflict, repositoryLayers } from "./registry.js";
import { describeLocal } from "./source.js";
import {
  expandSelections,
  resolveManifestEntries,
  SkillResolutionError,
  type Scope,
  type SkillTarget,
} from "./resolve.js";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  /** Stable identifier for the problem class. */
  kind: string;
  /** One-line description of what is wrong. */
  message: string;
  /** Suggested remedy. */
  fix?: string | undefined;
}

export interface DoctorReport {
  issues: Issue[];
  targets: SkillTarget[];
  installDirs: string[];
}

/**
 * Compares the manifest against what is actually on disk.
 *
 * Unlike `install`, this never registers repositories or writes anything — it
 * reports what `spm i` *would* do, plus problems `spm i` cannot fix on its
 * own (a hand-made directory squatting on a skill name, for instance).
 */
export async function diagnose(
  manifest: Manifest,
  scope: Scope,
  opts: { checkRemote?: boolean } = {},
): Promise<DoctorReport> {
  const issues: Issue[] = [];
  void opts;

  const layers = repositoryLayers(manifest, scope.manifestDir, scope.kind === "global");

  // 0. A local repository must be a directory of skills. A directory holding
  // SKILL.md is one skill, and `path:` coordinates exist so that such a
  // directory needs no registration at all. A registry entry that predates
  // that rule reports here, because nothing else looks at it again: the
  // registration is already in place, so no code path ever re-checks the path.
  for (const decl of layers.local.values()) {
    const registered = describeLocal(decl.name);
    if (registered === null || registered.target === null) continue;
    if (!exists(path.join(registered.target, "SKILL.md"))) continue;

    issues.push({
      level: "error",
      kind: "repository_is_a_skill",
      message: `local repository "${decl.name}" points at a skill directory: ${registered.target}`,
      fix:
        `Declare it as \`path:${registered.target}\` instead, and drop the registration ` +
        `with \`spm repository remove ${decl.name}\`.`,
    });
  }

  // 1. The two declaration layers must agree about a name. A repository whose
  // directory is gone is reported by the resolution step below, which is the
  // only place that still knows which repository it was — reporting it here as
  // well would count one root cause twice.
  for (const name of layers.local.keys()) {
    const conflict = declarationConflict(name, layers);
    if (!conflict) continue;

    issues.push({
      level: "error",
      kind: "repository_declared_twice",
      message: `local repository "${name}" is declared at two paths: ${conflict.local.path} (this manifest) and ${conflict.global.path} (global)`,
      fix: "Keep one declaration, or rename one of them.",
    });
  }

  // 2. Every declared skill must resolve to a real directory, and every
  // SKILL.md discovery skipped must be reported.
  let targets: SkillTarget[] = [];
  let resolved = true;
  try {
    const selections = await resolveManifestEntries(manifest, {
      manifestDir: scope.manifestDir,
      global: scope.kind === "global",
      register: false,
    });
    const expansion = expandSelections(selections);
    targets = expansion.targets;
    pushInvalidSkillIssues(issues, expansion.skipped);
  } catch (err) {
    // An entry that resolves to nothing aborts the expansion. The skipped
    // files explain why, so they are reported even though the walk stopped.
    resolved = false;
    if (err instanceof SkillResolutionError) pushInvalidSkillIssues(issues, err.skipped);
    issues.push({
      level: "error",
      kind: "unresolvable_manifest",
      message: (err as Error).message,
      fix: err instanceof SpmError ? err.hint : undefined,
    });
  }

  for (const target of targets) {
    if (!isDirectory(target.skillDir)) {
      issues.push({
        level: "error",
        kind: "missing_source_dir",
        message: `skill "${target.name}" points at a missing directory: ${target.skillDir}`,
        fix: `Fix ${target.source}, then run \`spm i\`.`,
      });
    }
  }

  // 3. Install directories must exist or be creatable, and hold correct links.
  const installDirs = installDirsFor(manifest, scope);

  for (const dir of installDirs) {
    if (isInside(sourcesDir(), dir)) {
      issues.push({
        level: "error",
        kind: "install_dir_inside_sources",
        message: `install directory ${dir} sits inside the source cache`,
      });
      continue;
    }
    if (isDirectory(dir) && !isWritable(dir)) {
      issues.push({
        level: "error",
        kind: "install_dir_not_writable",
        message: `install directory is not writable: ${dir}`,
      });
    }
  }

  const desired = new Set(targets.map((t) => t.name));

  for (const dir of installDirs) {
    if (!isDirectory(dir)) {
      if (targets.length > 0) {
        issues.push({
          level: "warning",
          kind: "install_dir_missing",
          message: `install directory does not exist yet: ${dir}`,
          fix: "spm i will create it",
        });
      }
      continue;
    }

    // 3a. Every declared skill must be correctly linked here. This check is
    // driven by the manifest, not by what's on disk — a link that was deleted
    // (or stolen and repointed by another tool) has no directory entry to
    // iterate over, and would otherwise go unnoticed.
    for (const target of targets) {
      const linkPath = path.join(dir, target.name);

      if (!exists(linkPath)) {
        issues.push({
          level: "warning",
          kind: "missing_link",
          message: `${linkPath} is missing`,
          fix: "spm i will create it",
        });
        continue;
      }

      if (linkPointsTo(linkPath, target.skillDir)) continue;

      if (isSymlink(linkPath)) {
        const current = readLink(linkPath);
        issues.push({
          level: "error",
          kind: "wrong_link_target",
          message: `${linkPath} points at ${current ?? "?"}, expected ${target.skillDir}`,
          fix: "spm i will repoint it",
        });
      } else {
        issues.push({
          level: "error",
          kind: "foreign_entry",
          message: `${linkPath} is a real directory squatting on the name of a declared skill`,
          fix: "move it aside, then re-run spm i (or spm i --force)",
        });
      }
    }

    // 3b. Links into the source cache that the manifest no longer declares.
    // Only meaningful once the declared set is known: an aborted expansion
    // leaves `targets` empty, and every link would look undeclared.
    if (!resolved) continue;

    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      if (desired.has(name)) continue;

      const entryPath = path.join(dir, name);
      if (ownedLinkTarget(entryPath) === null) continue;

      issues.push({
        level: "warning",
        kind: "orphan_link",
        message: `${entryPath} points into the source cache but is not declared`,
        fix: "spm i will remove it",
      });
    }
  }

  return { issues, targets, installDirs };
}

/**
 * One issue per SKILL.md that discovery refused to use.
 *
 * These count as errors: an entry whose file became unusable is a broken
 * manifest, not a cosmetic problem the next install pass can repair.
 */
function pushInvalidSkillIssues(issues: Issue[], skipped: readonly SkippedSkill[]): void {
  for (const item of skipped) {
    issues.push({
      level: "error",
      kind: "invalid_skill",
      message: skippedLine(item),
      fix: "fix the frontmatter, or exclude the directory in skill-repository.yaml",
    });
  }
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
