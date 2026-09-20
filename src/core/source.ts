import fs from "node:fs";
import path from "node:path";
import { sourcesDir } from "../config.js";
import { SpmError } from "../errors.js";
import { canonical, exists, isDirectory, readLink } from "../fsutil.js";
import { validGithubRepository, validRepositoryName } from "./coordinate.js";
import * as git from "./git.js";
import { readRepoName } from "./repo-manifest.js";

export type SourceKind = "local" | "github";

/**
 * A repository the machine can install from. It lives in one of two places
 * under the source cache; nothing else about it is recorded.
 */
export interface RegisteredSource {
  kind: SourceKind;
  /** A local repository name, or `owner/repo` for a github repository. */
  id: string;
  /** Absolute path of the cache entry. */
  path: string;
  /** Local repositories: what the symlink points at. */
  target: string | null;
  /** Github repositories: the checked-out commit. */
  commit: string | null;
}

/** `<SPM_HOME>/sources/local`: one symlink per registered local repository. */
export function localCacheDir(): string {
  return path.join(sourcesDir(), "local");
}

/** `<SPM_HOME>/sources/github`: one clone per `owner/repo`. */
export function githubCacheDir(): string {
  return path.join(sourcesDir(), "github");
}

export function localSourcePath(name: string): string {
  return path.join(localCacheDir(), name);
}

export function githubSourcePath(repo: string): string {
  return path.join(githubCacheDir(), repo);
}

/** The cache path of a repository, whichever kind it is. */
export function sourcePath(kind: SourceKind, id: string): string {
  return kind === "local" ? localSourcePath(id) : githubSourcePath(id);
}

export function describeLocal(name: string): RegisteredSource | null {
  const entry = localSourcePath(name);
  if (!exists(entry)) return null;
  const target = readLink(entry);
  return {
    kind: "local",
    id: name,
    path: entry,
    target: target ?? entry,
    commit: null,
  };
}

export async function describeGithub(repo: string): Promise<RegisteredSource | null> {
  const entry = githubSourcePath(repo);
  if (!exists(entry)) return null;
  return {
    kind: "github",
    id: repo,
    path: entry,
    target: null,
    commit: await git.currentCommit(entry),
  };
}

/** Every repository the machine has registered, sorted by kind then id. */
export async function listSources(): Promise<RegisteredSource[]> {
  const out: RegisteredSource[] = [];

  for (const name of readEntries(localCacheDir())) {
    const source = describeLocal(name);
    if (source) out.push(source);
  }

  for (const owner of readEntries(githubCacheDir())) {
    for (const repo of readEntries(path.join(githubCacheDir(), owner))) {
      const source = await describeGithub(`${owner}/${repo}`);
      if (source) out.push(source);
    }
  }

  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** The default name for a local repository: its own declaration, else the directory name. */
export function defaultRepositoryName(absPath: string): string {
  return readRepoName(absPath) ?? path.basename(absPath);
}

/**
 * Registers a local directory by symlinking it into the source cache. The
 * directory itself is never modified — that's the whole point of registering
 * rather than copying, since a change in the repository is picked up at once.
 */
export function registerLocal(
  inputPath: string,
  name: string,
  force = false,
): { name: string; status: "created" | "unchanged" | "rebound" } {
  const abs = path.resolve(inputPath);

  if (!isDirectory(abs)) {
    throw new SpmError(`not a directory: ${abs}`);
  }
  if (!validRepositoryName(name)) {
    throw new SpmError(
      `"${name}" is not a usable repository name`,
      "Names may contain letters, digits, dots, dashes and underscores, may not start with a dot, and may not be local or github.",
    );
  }

  const entry = localSourcePath(name);
  fs.mkdirSync(localCacheDir(), { recursive: true });

  if (exists(entry)) {
    const current = readLink(entry);
    if (current !== null && canonical(current) === canonical(abs)) {
      return { name, status: "unchanged" };
    }
    if (!force) {
      throw new SpmError(
        `local repository "${name}" is already registered`,
        current !== null
          ? `Currently points at ${current}. Re-run with --force to repoint it.`
          : `${entry} is in the way. Remove it or pick another name.`,
      );
    }
    fs.rmSync(entry, { recursive: true, force: true });
    fs.symlinkSync(abs, entry);
    return { name, status: "rebound" };
  }

  fs.symlinkSync(abs, entry);
  return { name, status: "created" };
}

/**
 * Makes sure the github repository is cloned, and returns its cache entry.
 *
 * The clone lands in a temporary directory and is renamed into place, so a
 * failed clone never leaves a half-populated repository behind. No ref is
 * involved: the clone follows the remote's default branch, and `spm update`
 * re-fetches that same branch.
 */
export async function ensureGithub(
  repo: string,
  force = false,
): Promise<RegisteredSource> {
  if (!validGithubRepository(repo)) {
    throw new SpmError(
      `"${repo}" is not a valid github repository`,
      "Expected the form owner/name.",
    );
  }

  const entry = githubSourcePath(repo);
  const existing = await describeGithub(repo);
  if (existing) {
    if (force && !exists(path.join(entry, ".git"))) {
      throw new SpmError(
        `${entry} is not a git checkout`,
        "Remove it and re-run `spm i`.",
      );
    }
    return existing;
  }

  fs.mkdirSync(githubCacheDir(), { recursive: true });
  const tmp = path.join(
    githubCacheDir(),
    `.tmp-${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    await git.clone(repo, tmp);
    if (exists(entry)) fs.rmSync(entry, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.renameSync(tmp, entry);
  } finally {
    if (exists(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }

  const registered = await describeGithub(repo);
  if (!registered) {
    throw new SpmError(`failed to clone ${repo}`);
  }
  return registered;
}

/** Re-fetches a github repository, following its default branch. */
export async function refreshGithub(repo: string): Promise<"updated" | "missing" | "local"> {
  const source = await describeGithub(repo);
  if (!source) return "missing";
  if (!exists(path.join(source.path, ".git"))) return "local";

  await git.pull(source.path);
  return "updated";
}

/** Unregisters a local repository. Returns false when it wasn't registered. */
export function removeLocalSource(name: string): boolean {
  const entry = localSourcePath(name);
  if (!exists(entry)) return false;
  fs.rmSync(entry, { recursive: true, force: true });
  return true;
}

/** Removes a github clone. Returns false when it wasn't there. */
export function removeGithubSource(repo: string): boolean {
  const entry = githubSourcePath(repo);
  if (!exists(entry)) return false;
  fs.rmSync(entry, { recursive: true, force: true });
  return true;
}

/** The registered local repository whose directory is exactly `abs`, if any. */
export function findLocalByPath(abs: string): RegisteredSource | null {
  const real = canonical(abs);
  for (const name of readEntries(localCacheDir())) {
    const source = describeLocal(name);
    if (!source || source.target === null) continue;
    if (canonical(source.target) === real) return source;
  }
  return null;
}

/** True when any registered source root contains `abs`. */
export function findEnclosingLocal(
  abs: string,
): { source: RegisteredSource; root: string } | null {
  const real = canonical(abs);
  for (const name of readEntries(localCacheDir())) {
    const source = describeLocal(name);
    if (!source || source.target === null) continue;
    const root = canonical(source.target);
    const rel = path.relative(root, real);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return { source, root };
    }
  }
  return null;
}

function readEntries(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}
