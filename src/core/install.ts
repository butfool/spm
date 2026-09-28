import fs from "node:fs";
import path from "node:path";
import { isInside, resolveInstallDirs, sourcesDir } from "../config.js";
import { SpmError } from "../errors.js";
import {
  ensureSymlink,
  exists,
  isDirectory,
  isSymlink,
  linkPointsTo,
  readLink,
} from "../fsutil.js";
import type { Manifest } from "./manifest.js";
import { registerProjectManifest } from "./project-registry.js";
import type { Scope, SkillTarget } from "./resolve.js";

/** What happened to one target link during an install pass. */
export type LinkAction = "created" | "replaced" | "unchanged" | "blocked";

export interface LinkResult {
  skillName: string;
  installDir: string;
  linkPath: string;
  action: LinkAction;
  /** Set when action is "blocked": why we refused to touch it. */
  reason?: string;
}

export interface InstallResult {
  links: LinkResult[];
  removed: { skillName: string; linkPath: string }[];
  installDirs: string[];
}

export interface InstallOptions {
  /** Overwrite non-symlink entries that block a target. */
  force?: boolean;
  /** Remove links in installDirs that the manifest no longer declares. */
  prune?: boolean;
}

/**
 * The effective install directories for a scope: the manifest's own list when
 * it declares one, otherwise the global settings, otherwise the default.
 */
export function installDirsFor(manifest: Manifest, scope: Scope): string[] {
  return resolveInstallDirs(manifest.installDirs, scope.installBaseDir);
}

/**
 * Makes the filesystem match the manifest: every declared skill is linked
 * into every install directory, and links the manifest no longer declares are
 * removed.
 *
 * The operation is idempotent by construction — a link that already points at
 * the right place is reported "unchanged" and never touched. Running it twice
 * leaves the second run with nothing to do.
 *
 * Ordering follows the project's saga convention: there is no cross-resource
 * transaction to speak of, but every link operation is individually atomic
 * (symlink replace is unlink+symlink, and a failure between the two leaves a
 * missing link that the next run repairs).
 */
export function installSkills(
  targets: SkillTarget[],
  manifest: Manifest,
  scope: Scope,
  opts: InstallOptions = {},
): InstallResult {
  const installDirs = installDirsFor(manifest, scope);
  const links: LinkResult[] = [];

  for (const dir of installDirs) {
    for (const target of targets) {
      links.push(linkSkill(target, dir, opts.force ?? false));
    }
  }

  const removed = opts.prune === false
    ? []
    : pruneOrphans(installDirs, targets);

  if (scope.kind === "project") registerProjectManifest(scope.manifestDir);

  return { links, removed, installDirs };
}

/** Links one skill into one directory, reporting what changed. */
function linkSkill(target: SkillTarget, installDir: string, force: boolean): LinkResult {
  const linkPath = path.join(installDir, target.name);

  if (!isDirectory(target.skillDir)) {
    return {
      skillName: target.name,
      installDir,
      linkPath,
      action: "blocked",
      reason: `source directory is missing: ${target.skillDir}`,
    };
  }

  if (exists(linkPath) && !isSymlink(linkPath)) {
    if (!force) {
      return {
        skillName: target.name,
        installDir,
        linkPath,
        action: "blocked",
        reason: isDirectory(linkPath)
          ? "a real directory is already there — move it aside or re-run with --force"
          : "a real file is already there — move it aside or re-run with --force",
      };
    }
    removeEntry(linkPath);
    ensureSymlink(target.skillDir, linkPath);
    return { skillName: target.name, installDir, linkPath, action: "replaced" };
  }

  if (force && exists(linkPath) && !linkPointsTo(linkPath, target.skillDir)) {
    removeEntry(linkPath);
    ensureSymlink(target.skillDir, linkPath);
    return { skillName: target.name, installDir, linkPath, action: "replaced" };
  }

  const action = ensureSymlink(target.skillDir, linkPath);
  return { skillName: target.name, installDir, linkPath, action };
}

/**
 * Removes whatever occupies `p`. `recursive` is safe here even for symlinks:
 * Node's rmSync unlinks the link itself rather than following it.
 */
function removeEntry(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * The target of the symlink at `linkPath`, when that link is one spm made.
 *
 * The test is the target's location, and it is the whole reason `spm` needs no
 * ownership table: every link spm makes points into the source cache, whether
 * it belongs to a repository or to a `path:` coordinate. Anything else is
 * somebody else's link, and spm cannot know whether it is still wanted.
 *
 * Returns null for anything else, including a non-symlink.
 */
export function ownedLinkTarget(linkPath: string): string | null {
  const current = readLink(linkPath);
  if (current === null) return null;
  return isInside(current, sourcesDir()) ? current : null;
}

/**
 * Removes links in each install directory that spm made but this manifest no
 * longer declares.
 *
 * What counts as one of spm's links is `ownedLinkTarget`'s question, and the
 * answer is "its target lives in the source cache". A link the user made by
 * hand is therefore left alone: spm did not create it and cannot know whether
 * it is still wanted.
 */
export function pruneOrphans(
  installDirs: string[],
  targets: SkillTarget[],
): { skillName: string; linkPath: string }[] {
  const desired = new Set(targets.map((t) => t.name));
  const removed: { skillName: string; linkPath: string }[] = [];

  for (const dir of installDirs) {
    if (!isDirectory(dir)) continue;

    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      if (desired.has(name)) continue;

      const linkPath = path.join(dir, name);
      if (ownedLinkTarget(linkPath) === null) continue;

      fs.unlinkSync(linkPath);
      removed.push({ skillName: name, linkPath });
    }
  }

  return removed;
}

/** Uninstalls specific skill names from every install directory of a scope. */
export function uninstallSkills(
  skillNames: string[],
  manifest: Manifest,
  scope: Scope,
): { skillName: string; linkPath: string }[] {
  const installDirs = installDirsFor(manifest, scope);
  const removed: { skillName: string; linkPath: string }[] = [];

  for (const dir of installDirs) {
    if (!isDirectory(dir)) continue;
    for (const name of skillNames) {
      const linkPath = path.join(dir, name);
      if (ownedLinkTarget(linkPath) === null) continue;
      fs.unlinkSync(linkPath);
      removed.push({ skillName: name, linkPath });
    }
  }

  return removed;
}

/** Current state of one declared skill across a scope's install directories. */
export interface SkillState {
  name: string;
  skillDir: string;
  /** The repository it comes from, as `local:name` or `github:owner/repo`. */
  source: string;
  /** One entry per install dir: whether the link is present and correct. */
  dirs: { dir: string; linkPath: string; state: "ok" | "missing" | "wrong" | "foreign" }[];
}

/** Inspects what's on disk for each target without changing anything. */
export function inspectTargets(
  targets: SkillTarget[],
  manifest: Manifest,
  scope: Scope,
): SkillState[] {
  const installDirs = installDirsFor(manifest, scope);

  return targets.map((target) => ({
    name: target.name,
    skillDir: target.skillDir,
    source: target.source,
    dirs: installDirs.map((dir) => {
      const linkPath = path.join(dir, target.name);
      if (!exists(linkPath)) return { dir, linkPath, state: "missing" as const };
      if (linkPointsTo(linkPath, target.skillDir)) return { dir, linkPath, state: "ok" as const };
      if (isSymlink(linkPath)) return { dir, linkPath, state: "wrong" as const };
      return { dir, linkPath, state: "foreign" as const };
    }),
  }));
}

/** Guards against a manifest whose install dirs would swallow the sources tree. */
export function assertSaneInstallDirs(installDirs: string[]): void {
  const roots = sourcesDir();
  for (const dir of installDirs) {
    if (isInside(roots, dir)) {
      throw new SpmError(
        `install directory ${dir} contains the source cache`,
        `Installing there would link the sources tree into itself.`,
      );
    }
  }
}
