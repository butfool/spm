import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandPath, readSettings, sourcesDir } from "../config.js";
import { SpmError } from "../errors.js";
import { exists, isDirectory, isSymlink, readLink } from "../fsutil.js";
import * as git from "./git.js";
import type { SourceDecl } from "./manifest.js";
import { readRepoName } from "./repo-manifest.js";

export type SourceKind = "local" | "github";

export interface RegisteredSource {
  alias: string;
  /** Absolute path of the entry inside the spm sources directory. */
  path: string;
  kind: SourceKind;
  /** For local sources: where the symlink points. */
  target: string | null;
  /** Short commit SHA for github sources. */
  commit: string | null;
}

/** Where a source with `alias` is stored inside SPM_HOME/sources. */
export function sourcePath(alias: string): string {
  return path.join(sourcesDir(), alias);
}

export function isRegistered(alias: string): boolean {
  return exists(sourcePath(alias));
}

/** Classifies a single entry in the sources directory. */
export async function describeSource(alias: string): Promise<RegisteredSource | null> {
  const p = sourcePath(alias);
  if (!exists(p)) return null;
  const target = readLink(p);

  if (target !== null) {
    return { alias, path: p, kind: "local", target, commit: null };
  }
  if (fs.existsSync(path.join(p, ".git"))) {
    return {
      alias,
      path: p,
      kind: "github",
      target: null,
      commit: await git.currentCommit(p),
    };
  }
  return { alias, path: p, kind: "local", target: p, commit: null };
}

/** Every registered source, sorted by alias. */
export async function listSources(): Promise<RegisteredSource[]> {
  const dir = sourcesDir();
  if (!exists(dir)) return [];

  const names = fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith(".") && n !== "tmp");

  const out: RegisteredSource[] = [];
  for (const alias of names) {
    const source = await describeSource(alias);
    if (source) out.push(source);
  }
  return out.sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Derives the default alias for a local repository from its path. */
export function defaultLocalAlias(absPath: string): string {
  return readRepoName(absPath) ?? path.basename(absPath);
}

/**
 * Registers a local directory by symlinking it into the sources directory.
 * The source directory itself is never modified — that's the whole point of
 * registering rather than copying.
 */
export function registerLocal(
  inputPath: string,
  alias?: string,
  force = false,
): { alias: string; status: "created" | "unchanged" | "rebound" } {
  const abs = path.resolve(inputPath);

  if (!isDirectory(abs)) {
    throw new SpmError(`not a directory: ${abs}`);
  }

  const resolvedAlias = alias ?? defaultLocalAlias(abs);
  validateAlias(resolvedAlias);

  const linkPath = sourcePath(resolvedAlias);
  fs.mkdirSync(sourcesDir(), { recursive: true });

  if (exists(linkPath)) {
    const current = readLink(linkPath);
    if (current === abs) return { alias: resolvedAlias, status: "unchanged" };

    if (!force) {
      throw new SpmError(
        `source "${resolvedAlias}" is already registered`,
        current !== null
          ? `Currently points at ${current}. Re-run with --force to repoint it.`
          : `Currently a clone at ${linkPath}. Remove it first or pick another --alias.`,
      );
    }

    if (current !== null) fs.unlinkSync(linkPath);
    else fs.rmSync(linkPath, { recursive: true, force: true });
    fs.symlinkSync(abs, linkPath);
    return { alias: resolvedAlias, status: "rebound" };
  }

  fs.symlinkSync(abs, linkPath);
  return { alias: resolvedAlias, status: "created" };
}

/**
 * Registers a github repository by cloning it into the sources directory.
 *
 * The clone lands in a temporary directory first so we can read the repo's
 * own `skill-repository.yaml` and honour its declared name — the same alias
 * rule local sources use. The temp dir is renamed into place only once the
 * final alias is known.
 */
export async function registerGithub(
  repo: string,
  ref?: string,
  alias?: string,
  force = false,
): Promise<{ alias: string; status: "created" | "unchanged" | "rebound"; ref: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new SpmError(
      `"${repo}" is not a valid github repository`,
      "Expected the form owner/name.",
    );
  }

  const resolvedRef = ref ?? readSettings().defaultRef;
  const defaultAlias = alias ?? repo.split("/")[1]!;

  const existing = sourcePath(defaultAlias);
  if (exists(existing) && isDirectory(existing) && !isSymlink(existing)) {
    if (!alias && !force) {
      // Already cloned under the default alias: treat as an idempotent re-add
      // and just make sure it's up to date.
      return { alias: defaultAlias, status: "unchanged", ref: resolvedRef };
    }
  }

  fs.mkdirSync(sourcesDir(), { recursive: true });
  const tmp = path.join(
    sourcesDir(),
    `.tmp-${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    await git.clone(repo, tmp, resolvedRef);

    const resolvedAlias = alias ?? readRepoName(tmp) ?? defaultAlias;
    validateAlias(resolvedAlias);

    const dest = sourcePath(resolvedAlias);
    let status: "created" | "unchanged" | "rebound" = "created";

    if (exists(dest)) {
      const isClone = isDirectory(dest) && !isSymlink(dest);
      if (!force) {
        throw new SpmError(
          `source "${resolvedAlias}" is already registered`,
          `Remove it first (spm source remove ${resolvedAlias}) or re-run with --force.`,
        );
      }
      if (isClone) {
        await git.pull(dest, resolvedRef);
        fs.rmSync(tmp, { recursive: true, force: true });
        return { alias: resolvedAlias, status: "unchanged", ref: resolvedRef };
      }
      fs.unlinkSync(dest);
      status = "rebound";
    }

    fs.renameSync(tmp, dest);
    return { alias: resolvedAlias, status, ref: resolvedRef };
  } finally {
    if (exists(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Ensures the source described by `decl` exists locally under `alias`,
 * registering it on first use. This is what makes a fresh checkout able to
 * run `spm i` without a manual `spm source add`.
 */
export async function ensureDeclaredSource(
  alias: string,
  decl: SourceDecl,
  opts: { force?: boolean } = {},
): Promise<RegisteredSource> {
  const existing = await describeSource(alias);
  if (existing) return existing;

  if (decl.path !== undefined) {
    const abs = expandPath(decl.path, os.homedir());
    registerLocal(abs, alias, opts.force ?? false);
  } else if (decl.repo !== undefined) {
    await registerGithub(decl.repo, decl.ref, alias, opts.force ?? false);
  } else {
    throw new SpmError(`source "${alias}" declares neither path nor repo`);
  }

  const registered = await describeSource(alias);
  if (!registered) {
    throw new SpmError(`failed to register source "${alias}"`);
  }
  return registered;
}

/**
 * Reconstructs the manifest declaration for an already-registered source.
 *
 * This is what lets a manifest stay self-contained: when a skill is added via
 * a bare name or an alias that was never declared in `sources:`, we can still
 * write down where the source actually came from, so a fresh clone of the
 * project can bootstrap itself.
 */
export async function sourceDeclFor(source: RegisteredSource): Promise<SourceDecl> {
  if (source.kind === "local" && source.target !== null) {
    return { path: source.target };
  }

  const url = await git.remoteUrl(source.path);
  const repo = url === null ? null : git.parseGithubRepo(url);
  return repo !== null ? { repo } : { path: source.path };
}

/** Unregisters a source. Returns false when it wasn't registered. */export function removeSource(alias: string): boolean {
  const p = sourcePath(alias);
  if (!exists(p)) return false;
  if (isSymlink(p)) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
  return true;
}

/** Updates an immutable-anyway source to its remote tip (github only). */
export async function refreshSource(
  alias: string,
  ref?: string,
): Promise<"updated" | "local" | "missing"> {
  const p = sourcePath(alias);
  if (!exists(p)) return "missing";
  if (isSymlink(p)) return "local";

  await git.pull(p, ref ?? readSettings().defaultRef);
  return "updated";
}

function validateAlias(alias: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new SpmError(
      `"${alias}" is not a usable source alias`,
      "Aliases may contain letters, digits, dots, dashes and underscores.",
    );
  }
  if (alias.startsWith(".")) {
    throw new SpmError(`"${alias}" is not a usable source alias`, "Aliases may not start with a dot.");
  }
}
