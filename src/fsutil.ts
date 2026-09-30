import fs from "node:fs";
import path from "node:path";

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
 * Writes `contents` to `file` through a sibling temporary file, so a reader
 * never sees a half-written manifest.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Creates a symlink to `target`.
 *
 * On Windows the link type has to be stated: `junction` for a directory, which
 * needs no elevated privilege, and `file` otherwise. Every other platform
 * ignores the argument.
 */
export function symlink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, linkType(target));
}

function linkType(target: string): "file" | "junction" {
  try {
    return fs.statSync(target).isDirectory() ? "junction" : "file";
  } catch {
    return "file";
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
    symlink(target, linkPath);
    return "replaced";
  }

  symlink(target, linkPath);
  return "created";
}
