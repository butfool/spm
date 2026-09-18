import fs from "node:fs";
import path from "node:path";
import { isInside, sourcesDir } from "../config.js";
import { exists, isDirectory, isSymlink, linkPointsTo, readLink } from "../fsutil.js";
import { installDirsFor } from "./install.js";
import type { Manifest } from "./manifest.js";
import {
  expandSelections,
  resolveManifestEntries,
  type Scope,
  type SkillTarget,
} from "./resolve.js";
import { listSources } from "./source.js";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  /** Stable identifier for the problem class. */
  kind: string;
  /** One-line description of what is wrong. */
  message: string;
  /** Suggested remedy. */
  fix?: string;
}

export interface DoctorReport {
  issues: Issue[];
  targets: SkillTarget[];
  installDirs: string[];
}

/**
 * Compares the manifest against what is actually on disk.
 *
 * Unlike `install`, this never registers sources or writes anything — it
 * reports what `spm i` *would* do, plus problems `spm i` cannot fix on its
 * own (a hand-made directory squatting on a skill name, for instance).
 */
export async function diagnose(
  manifest: Manifest,
  scope: Scope,
  opts: { checkRemote?: boolean } = {},
): Promise<DoctorReport> {
  const issues: Issue[] = [];

  // 1. Declared sources must be resolvable.
  const registered = await listSources();
  const registeredAliases = new Set(registered.map((s) => s.alias));

  for (const [alias, decl] of Object.entries(manifest.sources)) {
    if (registeredAliases.has(alias)) continue;
    issues.push({
      level: "warning",
      kind: "source_not_registered",
      message: `source "${alias}" is declared but not registered locally`,
      fix: `spm i will fetch it${decl.repo !== undefined ? ` from ${decl.repo}` : ""}`,
    });
  }

  // 2. Every declared skill must resolve to a real directory.
  let targets: SkillTarget[] = [];
  try {
    const selections = await resolveManifestEntries(manifest, { register: false });
    targets = expandSelections(selections);
  } catch (err) {
    issues.push({
      level: "error",
      kind: "unresolvable_manifest",
      message: (err as Error).message,
    });
  }

  for (const target of targets) {
    if (!isDirectory(target.skillDir)) {
      issues.push({
        level: "error",
        kind: "missing_source_dir",
        message: `skill "${target.name}" points at a missing directory: ${target.skillDir}`,
        fix: "spm source refresh, or re-register the source",
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
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      if (desired.has(name)) continue;

      const entryPath = path.join(dir, name);
      const link = readLink(entryPath);
      if (link === null || !isInside(link, sourcesDir())) continue;

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

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
