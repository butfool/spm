import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { sourcesDir } from "../config.js";
import { SpmError } from "../errors.js";
import { canonical, ensureSymlink, exists, isDirectory, isSymlink, readLink } from "../fsutil.js";
import { validGithubRepository, validRepositoryName } from "./coordinate.js";
import * as git from "./git.js";
import { MANIFEST_FILENAME } from "./manifest.js";
import { declarationPath, globalRepositories } from "./registry.js";
import { readRepoName } from "./repo-manifest.js";

export type SourceKind = "local" | "github";
export type CachedSourceKind = SourceKind | "path";

export interface CachedSource {
  kind: CachedSourceKind;
  id: string;
  path: string;
  target: string | null;
  managed: boolean;
  healthy: boolean;
}

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

/**
 * `<SPM_HOME>/sources/path`: one symlink per skill directory installed by a
 * `path:` coordinate.
 *
 * A path coordinate registers nothing and joins no search scope, so this is
 * not an entry in the machine-level registry: nothing reads the directory
 * except the link that points into it. It exists because "is this link spm's?"
 * is answered by asking whether the target sits inside the source cache, and a
 * link straight to the user's own directory would be indistinguishable from
 * one they made by hand.
 */
export function pathCacheDir(): string {
  return path.join(sourcesDir(), "path");
}

/** The cache entry for a skill directory installed by `path:`. */
export function pathSourceEntry(dir: string): string {
  const key = createHash("sha256").update(canonical(dir)).digest("hex").slice(0, 16);
  return path.join(pathCacheDir(), key);
}

/**
 * Makes sure a skill directory has its cache entry, and returns it.
 *
 * The entry is named after a hash of the directory, so two directories sharing
 * a basename cannot land on the same entry.
 */
export function ensurePathSource(dir: string): string {
  const entry = pathSourceEntry(dir);
  fs.mkdirSync(pathCacheDir(), { recursive: true });
  ensureSymlink(dir, entry);
  return entry;
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

/** Every physical cache entry, including path sources, broken links, and foreign entries. */
export async function listCachedSources(): Promise<CachedSource[]> {
  const out: CachedSource[] = [];

  for (const name of readAllEntries(localCacheDir())) {
    const entry = localSourcePath(name);
    const managed = isSymlink(entry);
    out.push({
      kind: "local",
      id: name,
      path: entry,
      target: managed ? readLink(entry) : null,
      managed,
      healthy: managed && isDirectory(entry),
    });
  }

  for (const key of readAllEntries(pathCacheDir())) {
    const entry = path.join(pathCacheDir(), key);
    const managed = isSymlink(entry);
    out.push({
      kind: "path",
      id: key,
      path: entry,
      target: managed ? readLink(entry) : null,
      managed,
      healthy: managed && isDirectory(entry),
    });
  }

  for (const owner of readAllEntries(githubCacheDir())) {
    const ownerPath = path.join(githubCacheDir(), owner);
    if (!isDirectory(ownerPath) || isSymlink(ownerPath)) {
      out.push(foreignGithubEntry(owner, ownerPath));
      continue;
    }

    const repositories = readAllEntries(ownerPath);
    if (repositories.length === 0) {
      out.push(foreignGithubEntry(owner, ownerPath));
      continue;
    }

    for (const repo of repositories) {
      const id = `${owner}/${repo}`;
      const entry = githubSourcePath(id);
      const managed = isDirectory(entry) && !isSymlink(entry);
      out.push({
        kind: "github",
        id,
        path: entry,
        target: null,
        managed,
        healthy: managed && (await git.currentCommit(entry)) !== null,
      });
    }
  }

  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** Removes one cache entry after verifying its path and expected filesystem shape. */
export function removeCachedSource(source: CachedSource): void {
  if (!source.managed) {
    throw new Error(`refusing to remove foreign cache entry ${source.path}`);
  }

  const expected = cachePathFor(source);
  if (path.resolve(source.path) !== path.resolve(expected)) {
    throw new Error(`cache entry path does not match its identity: ${source.path}`);
  }

  if (source.kind === "local" || source.kind === "path") {
    if (!isSymlink(source.path)) {
      throw new Error(`cache entry is no longer a symlink: ${source.path}`);
    }
    fs.unlinkSync(source.path);
    return;
  }

  if (!isDirectory(source.path) || isSymlink(source.path)) {
    throw new Error(`github cache entry is no longer a directory: ${source.path}`);
  }
  fs.rmSync(source.path, { recursive: true, force: true });

  const ownerDir = path.dirname(source.path);
  if (fs.readdirSync(ownerDir).length === 0) fs.rmdirSync(ownerDir);
}

/** The default name for a local repository: its own declaration, else the directory name. */
export function defaultRepositoryName(absPath: string): string {
  return readRepoName(absPath) ?? path.basename(absPath);
}

/** A name that cannot be used for a directory, and what to do about it. */
export interface RepositoryNameConflict {
  message: string;
  hint?: string | undefined;
}

/**
 * Why `name` cannot identify the directory at `abs`, or null when it can.
 *
 * A local repository's name is its machine-level identity: it is what every
 * project refers to and what every installed link resolves through. Two
 * directories cannot hold one name without one of them quietly taking over the
 * other's meaning, so a name that already leads somewhere else is refused
 * rather than reused.
 */
export function repositoryNameConflict(
  name: string,
  abs: string,
): RepositoryNameConflict | null {
  if (!validRepositoryName(name)) {
    return {
      message:
        `"${name}" is not a usable repository name — use letters, digits, dots, ` +
        "dashes and underscores, without a leading dot",
    };
  }

  const registered = describeLocal(name);
  if (
    registered !== null &&
    registered.target !== null &&
    canonical(registered.target) !== canonical(abs)
  ) {
    return {
      message: `local repository "${name}" is already registered`,
      hint:
        `It points at ${registered.target}. Register this directory under ` +
        `another name, or forget the old one with \`spm repository remove ${name}\`.`,
    };
  }

  const declared = globalRepositories().get(name);
  if (
    declared !== undefined &&
    canonical(declarationPath(declared)) !== canonical(abs)
  ) {
    return {
      message: `local repository "${name}" is already declared in the global ${MANIFEST_FILENAME}`,
      hint:
        `It points at ${declared.path}. Register this directory under another ` +
        `name, or forget the old one with \`spm repository remove ${name}\`.`,
    };
  }

  return null;
}

/**
 * Registers a local directory by symlinking it into the source cache. The
 * directory itself is never modified — that's the whole point of registering
 * rather than copying, since a change in the repository is picked up at once.
 *
 * A directory holding SKILL.md is itself one skill, and a source is a
 * *directory of skills*: registering it would create a name that carries no
 * information and would let the same directory be reached twice under two
 * names. Such a directory is installed by path instead, which records no
 * source at all.
 *
 * A name already held by another directory is an error, never a silent
 * rebinding: the name is the identity projects refer to, so it changes only
 * when the user decides it should.
 */
export function registerLocal(
  inputPath: string,
  name: string,
): { name: string; status: "created" | "unchanged" } {
  const abs = path.resolve(inputPath);

  if (!isDirectory(abs)) {
    throw new SpmError(`not a directory: ${abs}`);
  }
  if (exists(path.join(abs, "SKILL.md"))) {
    throw new SpmError(
      `${abs} is a skill directory, not a repository`,
      `A source is a directory of skills. Install this one with \`spm add path:${abs}\`, or register the directory above it.`,
    );
  }

  const conflict = repositoryNameConflict(name, abs);
  if (conflict !== null) {
    throw new SpmError(conflict.message, conflict.hint);
  }

  const entry = localSourcePath(name);
  fs.mkdirSync(localCacheDir(), { recursive: true });

  if (exists(entry)) {
    return { name, status: "unchanged" };
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

function foreignGithubEntry(id: string, entryPath: string): CachedSource {
  return {
    kind: "github",
    id,
    path: entryPath,
    target: null,
    managed: false,
    healthy: false,
  };
}

function cachePathFor(source: CachedSource): string {
  switch (source.kind) {
    case "local":
      return localSourcePath(source.id);
    case "github":
      return githubSourcePath(source.id);
    case "path":
      return path.join(pathCacheDir(), source.id);
  }
}

function readEntries(dir: string): string[] {
  return readAllEntries(dir).filter((name) => !name.startsWith("."));
}

function readAllEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}
