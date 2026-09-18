import os from "node:os";
import path from "node:path";
import { globalManifestPath, isInside, spmHome } from "../config.js";
import { SpmError } from "../errors.js";
import { isDirectory, canonical } from "../fsutil.js";
import { discoverSkills, type DiscoveredSkill, type DiscoverOptions } from "./discover.js";
import type { Manifest, SkillEntry, SourceDecl } from "./manifest.js";
import { readRepoManifest } from "./repo-manifest.js";
import {
  describeSource,
  ensureDeclaredSource,
  isRegistered,
  listSources,
  registerGithub,
  registerLocal,
  sourceDeclFor,
  sourcePath,
  type RegisteredSource,
} from "./source.js";

/** Which manifest a command operates on. */
export interface Scope {
  kind: "project" | "global";
  /** Directory holding skills.yaml. */
  manifestDir: string;
  /** Base for resolving relative installDirs. */
  installBaseDir: string;
}

export function projectScope(cwd: string): Scope {
  return { kind: "project", manifestDir: cwd, installBaseDir: cwd };
}

export function globalScope(): Scope {
  return {
    kind: "global",
    manifestDir: spmHome(),
    installBaseDir: os.homedir(),
  };
}

export function scopeLabel(scope: Scope): string {
  return scope.kind === "global" ? globalManifestPath() : path.join(scope.manifestDir, "skills.yaml");
}

/**
 * A source plus the subset of its skills to install. `skills: "*"` means
 * every skill the source exposes.
 */
export interface SourceSelection {
  /** Registered alias, or null for ad-hoc paths/repos. */
  alias: string | null;
  /** Absolute path of the source root on disk. */
  root: string;
  /**
   * Declaration to record under `sources:` in the manifest. Null when `entry`
   * is self-contained (the inline `path:`/`repo:` form), in which case no
   * named alias needs declaring.
   */
  decl: SourceDecl | null;
  /** The manifest entry that reproduces this selection. */
  entry: SkillEntry;
  skills: string[] | "*";
  /** How the user referred to this, for error messages and output. */
  label: string;
}

export interface ResolveContext {
  /** The manifest being edited, so declared aliases resolve before registration. */
  manifest: Manifest | null;
  /** Register sources on demand (install paths) or require them to exist (read-only paths). */
  register: boolean;
  force?: boolean;
}

/**
 * Resolves one CLI specifier into a concrete source selection.
 *
 * Accepted forms, in the order they're recognised:
 *
 *   ./path, /abs/path, ~/path   local directory (one skill if it holds a
 *                               SKILL.md itself, otherwise all it contains)
 *   alias/skill, alias/*        a source by alias
 *   owner/repo[#ref]            a github repo, all skills
 *   owner/repo/skill            a github repo, one skill
 *   skill-name                  a skill looked up across all registered sources
 */
export async function resolveSpec(
  spec: string,
  ctx: ResolveContext,
): Promise<SourceSelection> {
  const trimmed = spec.trim();
  if (trimmed === "") throw new SpmError("empty skill specifier");

  if (isPathLike(trimmed)) {
    return resolvePathSpec(trimmed, ctx);
  }

  const segments = trimmed.split("/");

  // A leading segment that is a known alias wins over github syntax — that's
  // what lets `my-org/my-repo` work when `my-org` is a registered alias.
  if (segments.length >= 2 && isKnownAlias(segments[0]!, ctx.manifest)) {
    return resolveAliasSpec(segments[0]!, segments.slice(1).join("/"), ctx);
  }

  if (segments.length === 1) {
    const name = segments[0]!;
    // A bare word that names a source installs the whole source. This is the
    // shell-safe spelling of `alias/*`: an unquoted `*` is expanded — or, in
    // zsh's default `nomatch` mode, rejected — before spm ever sees it.
    if (isKnownAlias(name, ctx.manifest)) {
      return resolveAliasSpec(name, "*", ctx);
    }
    return resolveBareSkillSpec(name, ctx);
  }

  return resolveGithubSpec(segments, ctx);
}

/**
 * Whether `alias` is a source we can resolve: either declared by the manifest
 * being edited, or registered globally.
 */
export function isKnownAlias(alias: string, manifest: Manifest | null): boolean {
  if (manifest?.sources[alias] !== undefined) return true;
  return isRegistered(alias);
}

async function resolvePathSpec(spec: string, ctx: ResolveContext): Promise<SourceSelection> {
  const abs = path.resolve(spec.replace(/^~(?=\/|$)/, os.homedir()));
  if (!isDirectory(abs)) {
    throw new SpmError(`no such directory: ${abs}`);
  }

  const existing = await findByRealPath(abs);

  // Already registered under some alias: reuse it rather than registering the
  // same directory a second time under a new name, which would put every one
  // of its skills on the manifest twice.
  if (existing !== null && existing.exact) {
    return {
      alias: existing.alias,
      root: sourcePath(existing.alias),
      decl: ctx.manifest?.sources[existing.alias] ?? (await sourceDeclFor(existing.source)),
      entry: `${existing.alias}/*`,
      skills: "*",
      label: spec,
    };
  }

  // A subdirectory of a source we already have. Registering it would duplicate
  // the skills it contains, so point at the source that already covers it.
  if (existing !== null) {
    const inner = discoverSkills(abs, discoverOptionsFor(existing.root));
    throw new SpmError(
      `${abs} is inside the already-registered source "${existing.alias}"`,
      inner.length === 1
        ? `Use \`spm add ${existing.alias}/${inner[0]!.name}\` instead.`
        : `Use \`spm add ${existing.alias}\` for the whole source, or name a skill from it.`,
    );
  }

  const alias = ctx.register
    ? registerLocal(abs, undefined, ctx.force ?? false).alias
    : path.basename(abs);

  const root = ctx.register ? sourcePath(alias) : abs;
  return {
    alias,
    root,
    decl: { path: abs },
    entry: `${alias}/*`,
    skills: "*",
    label: spec,
  };
}

/**
 * Finds the registered source a directory belongs to: an exact match on the
 * source root, or — when `abs` is a subdirectory of one — that enclosing
 * source, which callers report as an error rather than silently duplicating.
 *
 * Both sides are realpath'd first: a registered local source is a symlink, so
 * comparing the link path against a user-supplied directory never matches.
 */
async function findByRealPath(
  abs: string,
): Promise<{ source: RegisteredSource; alias: string; root: string; exact: boolean } | null> {
  const real = canonical(abs);
  for (const source of await listSources()) {
    const root = canonical(source.path);
    if (root === real) {
      return { source, alias: source.alias, root, exact: true };
    }
    if (isInside(real, root)) {
      return { source, alias: source.alias, root, exact: false };
    }
  }
  return null;
}

async function resolveAliasSpec(
  alias: string,
  rest: string,
  ctx: ResolveContext,
): Promise<SourceSelection> {
  let decl = ctx.manifest?.sources[alias];

  if (!decl && !isRegistered(alias)) {
    throw new SpmError(
      `unknown source "${alias}"`,
      `Register it first: spm source add <path|owner/repo> --alias ${alias}`,
    );
  }

  if (!isRegistered(alias)) {
    if (!ctx.register) {
      throw new SpmError(
        `source "${alias}" is declared but not registered locally`,
        `Run \`spm i\` to fetch it, or \`spm source add\` explicitly.`,
      );
    }
    await ensureDeclaredSource(alias, decl!, { force: ctx.force ?? false });
  }

  // An alias registered globally but absent from this manifest still needs a
  // declaration recorded, or a fresh clone couldn't reproduce it.
  if (!decl) {
    const source = await describeSource(alias);
    if (!source) throw new SpmError(`source "${alias}" vanished during resolution`);
    decl = await sourceDeclFor(source);
  }

  const root = sourcePath(alias);
  const skills = rest === "*" ? "*" : rest.split("/").filter(Boolean);
  if (skills !== "*" && skills.length !== 1) {
    throw new SpmError(
      `"${alias}/${rest}" does not name a single skill`,
      "Use `alias/skill-name` or `alias/*`.",
    );
  }

  return {
    alias,
    root,
    decl,
    entry: `${alias}/${rest}`,
    skills,
    label: `${alias}/${rest}`,
  };
}

async function resolveGithubSpec(
  segments: string[],
  ctx: ResolveContext,
): Promise<SourceSelection> {
  if (segments.length > 3) {
    throw new SpmError(
      `"${segments.join("/")}" is not a valid specifier`,
      "Expected alias/skill, owner/repo, owner/repo/skill, or a local path.",
    );
  }

  const [owner, rawRepo, ...rest] = segments;
  const hashIndex = rawRepo!.indexOf("#");
  const repoName = hashIndex === -1 ? rawRepo! : rawRepo!.slice(0, hashIndex);
  const ref = hashIndex === -1 ? undefined : rawRepo!.slice(hashIndex + 1);
  const repo = `${owner}/${repoName}`;

  if (!ctx.register) {
    throw new SpmError(
      `source "${repo}" is not registered`,
      `Run \`spm source add ${repo}\` first.`,
    );
  }

  const result = await registerGithub(repo, ref, undefined, ctx.force ?? false);
  const skillName = rest[0];

  return {
    alias: result.alias,
    root: sourcePath(result.alias),
    decl: ref !== undefined ? { repo, ref } : { repo },
    entry: skillName === undefined ? `${result.alias}/*` : `${result.alias}/${skillName}`,
    skills: skillName === undefined ? "*" : [skillName],
    label: rest.length > 0 ? `${repo}/${rest.join("/")}` : repo,
  };
}

/**
 * A bare name with no slash: look it up across every registered source. This
 * is the `npm install lodash` ergonomic — unambiguous finds install, ambiguous
 * ones list the candidates instead of guessing.
 */
async function resolveBareSkillSpec(
  name: string,
  ctx: ResolveContext,
): Promise<SourceSelection> {
  const matches: SourceSelection[] = [];

  for (const source of await listSources()) {
    const opts = discoverOptionsFor(source.path);
    const found = discoverSkills(source.path, opts).some((s) => s.name === name);
    if (found) {
      matches.push({
        alias: source.alias,
        root: source.path,
        decl: await sourceDeclFor(source),
        entry: `${source.alias}/${name}`,
        skills: [name],
        label: `${source.alias}/${name}`,
      });
    }
  }

  if (matches.length === 0) {
    throw new SpmError(
      `no skill named "${name}" in any registered source`,
      "Run `spm source list` to see what's registered, or `spm find <query>` to search.",
    );
  }

  if (matches.length > 1) {
    throw new SpmError(
      `"${name}" exists in ${matches.length} sources: ${matches.map((m) => m.alias).join(", ")}`,
      `Disambiguate with one of: ${matches.map((m) => `spm add ${m.alias}/${name}`).join(", ")}`,
    );
  }

  void ctx;
  return matches[0]!;
}

/** Expands manifest entries, registering sources as needed. */
export async function resolveManifestEntries(
  manifest: Manifest,
  ctx: { register: boolean; force?: boolean },
): Promise<SourceSelection[]> {
  const selections: SourceSelection[] = [];

  for (const entry of manifest.skills) {
    if (typeof entry === "string") {
      selections.push(
        await resolveSpec(entry, { manifest, register: ctx.register, force: ctx.force ?? false }),
      );
      continue;
    }

    if (entry.repo !== undefined) {
      const result = ctx.register
        ? await registerGithub(entry.repo, entry.ref, undefined, ctx.force ?? false)
        : null;
      const alias = result?.alias ?? entry.repo.split("/")[1]!;
      if (!result && !isRegistered(alias)) {
        throw new SpmError(
          `source "${entry.repo}" is not registered`,
          `Run \`spm i\` to fetch it, or \`spm source add ${entry.repo}\`.`,
        );
      }
      selections.push({
        alias,
        root: sourcePath(alias),
        decl: null,
        entry,
        skills: entry.skill !== undefined ? [entry.skill] : "*",
        label: entry.skill !== undefined ? `${entry.repo}:${entry.skill}` : entry.repo,
      });
      continue;
    }

    if (entry.path !== undefined) {
      const abs = path.resolve(entry.path.replace(/^~(?=\/|$)/, os.homedir()));
      if (!isDirectory(abs)) {
        throw new SpmError(
          `no such directory: ${abs}`,
          "Declared by a `path:` entry in skills.yaml.",
        );
      }
      const alias = ctx.register
        ? registerLocal(abs, undefined, ctx.force ?? false).alias
        : path.basename(abs);
      selections.push({
        alias,
        root: ctx.register ? sourcePath(alias) : abs,
        decl: null,
        entry,
        skills: entry.skill !== undefined ? [entry.skill] : "*",
        label: entry.path,
      });
      continue;
    }

    throw new SpmError(
      `a skills.yaml entry has neither \`path\` nor \`repo\`: ${JSON.stringify(entry)}`,
    );
  }

  return selections;
}

/** A skill resolved to a concrete directory on disk. */
export interface SkillTarget {
  name: string;
  /** Directory to symlink from. */
  skillDir: string;
  sourceAlias: string | null;
  sourceRoot: string;
  label: string;
}

/** Expands selections into individual skills, surfacing missing ones. */
export function expandSelections(selections: SourceSelection[]): SkillTarget[] {
  const targets: SkillTarget[] = [];
  const byName = new Map<string, SkillTarget>();

  for (const selection of selections) {
    const opts = discoverOptionsFor(selection.root);
    const available = discoverSkills(selection.root, opts);

    let chosen: DiscoveredSkill[];
    if (selection.skills === "*") {
      chosen = available;
      if (chosen.length === 0) {
        throw new SpmError(
          `${selection.label} contains no skills`,
          `Nothing with a SKILL.md was found under ${selection.root}.`,
        );
      }
    } else {
      chosen = [];
      for (const wanted of selection.skills) {
        const found = available.find((s) => s.name === wanted);
        if (!found) {
          throw new SpmError(
            `skill "${wanted}" not found in ${selection.label}`,
            available.length > 0
              ? `Available: ${available.map((s) => s.name).join(", ")}`
              : `No skills found under ${selection.root}.`,
          );
        }
        chosen.push(found);
      }
    }

    for (const skill of chosen) {
      const existing = byName.get(skill.name);
      if (existing && existing.sourceRoot !== selection.root) {
        throw new SpmError(
          `skill "${skill.name}" is provided by two sources`,
          `${existing.label} and ${selection.label}. Remove one declaration from skills.yaml.`,
        );
      }
      if (existing) continue;

      const target: SkillTarget = {
        name: skill.name,
        skillDir: skill.dir,
        sourceAlias: selection.alias,
        sourceRoot: selection.root,
        label: selection.label,
      };
      byName.set(skill.name, target);
      targets.push(target);
    }
  }

  targets.sort((a, b) => a.name.localeCompare(b.name));
  return targets;
}

function discoverOptionsFor(root: string): DiscoverOptions {
  // Discovery options come from the repo's own skill-repository.yaml.
  const manifest = readRepoManifest(root);
  return { exclude: manifest.exclude, maxDepth: manifest.maxDepth };
}

function isPathLike(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    spec === "." ||
    spec === ".." ||
    spec.startsWith("~")
  );
}

/**
 * The manifest key a specifier refers to, without touching the filesystem or
 * registering anything. Mirrors the precedence `resolveSpec` uses, so
 * `spm rm` matches exactly what `spm add` would have written.
 */
export function specToEntryKey(spec: string, manifest: Manifest | null): string {
  const trimmed = spec.trim();

  if (isPathLike(trimmed)) {
    return path.resolve(trimmed.replace(/^~(?=\/|$)/, os.homedir()));
  }

  const segments = trimmed.split("/");
  const head = segments[0]!;

  if (segments.length >= 2 && isKnownAlias(head, manifest)) {
    return trimmed; // alias/skill or alias/*
  }
  if (segments.length === 1) {
    return isKnownAlias(head, manifest) ? `${head}/*` : head;
  }
  if (segments.length === 2) return trimmed; // owner/repo
  if (segments.length === 3) return `${head}/${segments[1]}:${segments[2]}`;

  return trimmed;
}

/** True when `spec` is a bare skill name rather than an alias or repo. */
export function isBareSpec(spec: string, manifest: Manifest | null): boolean {
  const trimmed = spec.trim();
  if (isPathLike(trimmed) || trimmed.includes("/")) return false;
  return !isKnownAlias(trimmed, manifest);
}