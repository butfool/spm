import fs from "node:fs";
import path from "node:path";
import { isInside } from "./config.js";

/** True if anything (file, dir, or dangling symlink) exists at `p`. */
export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * If `p` is a symlink, returns its target resolved to an absolute path
 * (without requiring the target to exist). Returns null otherwise.
 */
export function readLink(p: string): string | null {
  if (!isSymlink(p)) return null;
  const raw = fs.readlinkSync(p);
  return path.resolve(path.dirname(p), raw);
}

/**
 * Whether a symlink at `linkPath` already resolves to `target`, comparing
 * real paths so that symlinked source dirs (our own sources/ entries) compare
 * equal to their canonical location.
 */
export function linkPointsTo(linkPath: string, target: string): boolean {
  const current = readLink(linkPath);
  if (current === null) return false;
  return canonical(current) === canonical(target);
}

/**
 * Best-effort realpath. Falls back to a normalized absolute path when the
 * target doesn't exist, so callers can compare paths before creating them.
 */
export function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.normalize(path.resolve(p));
  }
}

/**
 * Idempotently makes `linkPath` a symlink to `target`.
 *
 * Returns what happened so callers can report accurately:
 *  - "unchanged" — already the right link, nothing touched
 *  - "created"   — link did not exist
 *  - "replaced"  — an existing link pointed somewhere else
 *
 * Refuses to clobber a real directory or file: that is someone else's data.
 */
export function ensureSymlink(
  target: string,
  linkPath: string,
): "unchanged" | "created" | "replaced" {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  if (exists(linkPath)) {
    if (!isSymlink(linkPath)) {
      throw new Error(
        `refusing to replace ${linkPath}: it exists and is not a symlink`,
      );
    }
    if (linkPointsTo(linkPath, target)) return "unchanged";
    fs.unlinkSync(linkPath);
    fs.symlinkSync(target, linkPath);
    return "replaced";
  }

  fs.symlinkSync(target, linkPath);
  return "created";
}

/**
 * Removes a symlink at `linkPath`, but only when its target lives under one of
 * `ownedRoots`. This is what stops `spm rm` from deleting links the user (or
 * another tool) created by hand.
 *
 * Returns true when a link was removed.
 */
export function removeOwnedSymlink(
  linkPath: string,
  ownedRoots: string[],
): boolean {
  const current = readLink(linkPath);
  if (current === null) return false;
  if (!ownedRoots.some((root) => isInside(current, root))) return false;
  fs.unlinkSync(linkPath);
  return true;
}

/** Reads directory entries, returning [] instead of throwing on ENOENT. */
export function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Lists the skill-shaped entries in `dir`: names that are directories or
 * symlinks-to-directories. Used for listing install targets.
 */
export function listSubdirectories(dir: string): string[] {
  return readDirNames(dir).filter((name) => {
    if (name.startsWith(".")) return false;
    return isDirectory(path.join(dir, name));
  });
}
