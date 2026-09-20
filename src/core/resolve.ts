import os from "node:os";
import path from "node:path";
import { expandPath, spmHome } from "../config.js";
import { SpmError } from "../errors.js";
import { canonical, exists, isDirectory, readLink } from "../fsutil.js";
import {
  COORDINATE_HINT,
  WHOLE_REPOSITORY,
  formatCoordinate,
  isRepositoryType,
  namesWholeRepository,
  parseCoordinate,
  readCoordinate,
  tryParseCoordinate,
  type Coordinate,
  type RepositoryType,
} from "./coordinate.js";
import {
  discoverSkills,
  skippedFrom,
  skippedLine,
  type DiscoveredSkill,
  type DiscoverOptions,
  type SkippedSkill,
} from "./discover.js";
import { manifestPath, type Manifest } from "./manifest.js";
import { declarationPath, lookupLocalRepository, repositoryLayers, type RepositoryLayers } from "./registry.js";
import { readRepoManifest } from "./repo-manifest.js";
import {
  defaultRepositoryName,
  describeGithub,
  describeLocal,
  ensureGithub,
  findEnclosingLocal,
  findLocalByPath,
  githubSourcePath,
  listSources,
  localSourcePath,
  registerLocal,
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
  return scope.kind === "global"
    ? manifestPath(spmHome())
    : manifestPath(scope.manifestDir);
}

/**
 * A repository plus the subset of its skills to install, together with
 * everything needed to write the dependency back into a manifest.
 */
export interface SourceSelection {
  type: RepositoryType;
  /** A local repository name, or `owner/repo`. */
  id: string;
  /** Absolute path of the repository root on disk. */
  root: string;
  /** The coordinate that reproduces this selection. */
  entry: string;
  skills: string[] | "*";
  /** How the repository is named in messages. */
  label: string;
  /**
   * The declaration to record next to the dependency, when the repository
   * isn't declared yet. Null for github repositories, which need no
   * declaration, and for local ones already declared for this scope.
   */
  declaration: { name: string; path: string } | null;
}

export interface ResolveContext {
  /** The manifest being edited, so its declarations resolve first. */
  manifest: Manifest | null;
  /** Directory holding that manifest, for its relative repository paths. */
  manifestDir: string;
  /** Whether that manifest is the global one. */
  global: boolean;
  /** Register repositories on demand (install paths) or require them to exist. */
  register: boolean;
  /** Repoint an already-registered repository. */
  force?: boolean | undefined;
  /** Name to register a local directory under; defaults to its declared name. */
  name?: string | undefined;
}

/** What a CLI specifier names, before anything is registered. */
export type SpecTarget =
  | { kind: "path"; path: string }
  | { kind: "skill"; name: string }
  | { kind: "coordinate"; coordinate: Coordinate };

/** The repository prefix used in messages and JSON output. */
export function sourceLabel(type: RepositoryType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Reads one CLI specifier.
 *
 * Accepted forms:
 *
 *   ./path, /abs/path, ~/path           a local directory, registered on the fly
 *   local:name:skill, local:name:*      a registered local repository
 *   github:owner/repo:skill             a github repository
 *   local:name, github:owner/repo       the whole repository
 *   owner/repo[:skill]                  github shorthand
 *   name[:skill]                        local shorthand, when `name` is known
 *   skill-name                          a skill looked up across all repositories
 *
 * The type segment can be left out of the shorthand forms, because `owner/repo`
 * carries a slash a repository name never has, and a name is only accepted as a
 * repository when this machine already knows it.
 */
export function parseSpecTarget(
  spec: string,
  isKnownLocal: (name: string) => boolean,
): SpecTarget {
  const trimmed = spec.trim();
  if (trimmed === "") throw new SpmError("empty skill specifier");

  if (isPathLike(trimmed)) return { kind: "path", path: trimmed };

  const segments = trimmed.split(":");

  if (segments.length === 1) {
    const token = segments[0]!;
    if (token.includes("/")) {
      return { kind: "coordinate", coordinate: buildCoordinate(trimmed, "github", token, WHOLE_REPOSITORY) };
    }
    if (isKnownLocal(token)) {
      return {
        kind: "coordinate",
        coordinate: buildCoordinate(trimmed, "local", token, WHOLE_REPOSITORY),
      };
    }
    return { kind: "skill", name: token };
  }

  if (segments.length === 2) {
    const [head, rest] = segments as [string, string];

    if (isRepositoryType(head)) {
      return { kind: "coordinate", coordinate: buildCoordinate(trimmed, head, rest, WHOLE_REPOSITORY) };
    }
    if (head.includes("/")) {
      return { kind: "coordinate", coordinate: buildCoordinate(trimmed, "github", head, rest) };
    }
    if (isKnownLocal(head)) {
      return { kind: "coordinate", coordinate: buildCoordinate(trimmed, "local", head, rest) };
    }
    throw new SpmError(
      `unknown repository "${head}"`,
      `${UNKNOWN_LOCAL_HINT(head)} A repository name never contains a slash.`,
    );
  }

  if (segments.length === 3) {
    const [type, repository, skill] = segments as [string, string, string];
    return { kind: "coordinate", coordinate: buildCoordinate(trimmed, type, repository, skill) };
  }

  throw new SpmError(
    `"${trimmed}" is not a usable specifier`,
    `${COORDINATE_HINT} A local directory is given as a plain path.`,
  );
}

const UNKNOWN_LOCAL_HINT = (name: string): string =>
  `Register it with \`spm repository add <path> --name ${name}\`;`;

function buildCoordinate(
  text: string,
  type: string,
  repository: string,
  skill: string,
): Coordinate {
  const result = readCoordinate(`${type}:${repository}:${skill}`);
  if (!result.ok) {
    throw new SpmError(`"${text}" is not a usable specifier: ${result.reason}`, COORDINATE_HINT);
  }
  return result.coordinate;
}

/** Resolves one CLI specifier into a concrete repository selection. */
export async function resolveSpec(
  spec: string,
  ctx: ResolveContext,
): Promise<SourceSelection> {
  const layers = repositoryLayers(ctx.manifest, ctx.manifestDir, ctx.global);
  const target = parseSpecTarget(spec, (name) => isKnownLocal(name, layers));

  switch (target.kind) {
    case "path":
      return resolvePathSpec(target.path, ctx, layers);
    case "skill":
      return resolveBareSkillSpec(target.name);
    case "coordinate":
      return resolveCoordinate(target.coordinate, ctx, layers);
  }
}

/** Whether `name` is a local repository this machine can resolve. */
export function isKnownLocal(name: string, layers: RepositoryLayers): boolean {
  return lookupLocalRepository(name, layers) !== null || describeLocal(name) !== null;
}

async function resolvePathSpec(
  spec: string,
  ctx: ResolveContext,
  layers: RepositoryLayers,
): Promise<SourceSelection> {
  const abs = expandPath(spec, process.cwd());
  if (!isDirectory(abs)) {
    throw new SpmError(`no such directory: ${abs}`);
  }

  const registered = findLocalByPath(abs);
  if (registered) {
    return {
      type: "local",
      id: registered.id,
      root: registered.path,
      entry: `${sourceLabel("local", registered.id)}:${WHOLE_REPOSITORY}`,
      skills: "*",
      label: spec,
      declaration: declarationFor(registered, layers),
    };
  }

  const enclosing = findEnclosingLocal(abs);
  if (enclosing) {
    const inner = discoverSkills(abs, discoverOptionsFor(enclosing.source.path)).skills;
    throw new SpmError(
      `${abs} is inside the registered local repository "${enclosing.source.id}"`,
      inner.length === 1
        ? `Use \`spm add local:${enclosing.source.id}:${inner[0]!.name}\` instead.`
        : `Use \`spm add local:${enclosing.source.id}\` for every skill it holds, or name one of them.`,
    );
  }

  const name = ctx.name ?? defaultRepositoryName(abs);
  const declared = lookupLocalRepository(name, layers);
  if (declared && canonical(declarationPath(declared)) !== canonical(abs)) {
    throw new SpmError(
      `local repository "${name}" already points at ${declared.path}`,
      `Re-run with \`--name <other-name>\`, or repoint it with \`spm repository add ${spec} --name ${name} --force\`.`,
    );
  }

  if (ctx.register) {
    registerLocal(abs, name, ctx.force ?? false);
  }

  return {
    type: "local",
    id: name,
    root: ctx.register ? localSourcePath(name) : abs,
    entry: `${sourceLabel("local", name)}:${WHOLE_REPOSITORY}`,
    skills: "*",
    label: spec,
    declaration: declared ? null : { name, path: spec },
  };
}

/** The declaration to write for an already-registered local repository. */
function declarationFor(
  source: RegisteredSource,
  layers: RepositoryLayers,
): { name: string; path: string } | null {
  if (lookupLocalRepository(source.id, layers) !== null) return null;
  if (source.target === null) return null;
  return { name: source.id, path: source.target };
}

async function resolveCoordinate(
  coordinate: Coordinate,
  ctx: ResolveContext,
  layers: RepositoryLayers,
): Promise<SourceSelection> {
  const skills = namesWholeRepository(coordinate) ? "*" : [coordinate.skill];

  if (coordinate.type === "local") {
    return resolveLocalCoordinate(coordinate, skills, ctx, layers);
  }

  const registered = await ensureGithubIfAsked(coordinate.repository, ctx);
  return {
    type: "github",
    id: coordinate.repository,
    root: registered.path,
    entry: formatCoordinate(coordinate),
    skills,
    label: formatCoordinate(coordinate),
    declaration: null,
  };
}

async function resolveLocalCoordinate(
  coordinate: Coordinate,
  skills: string[] | "*",
  ctx: ResolveContext,
  layers: RepositoryLayers,
): Promise<SourceSelection> {
  const name = coordinate.repository;
  const registered = describeLocal(name);
  const declared = lookupLocalRepository(name, layers);

  if (!registered) {
    if (!declared) {
      throw new SpmError(
        `unknown local repository "${name}"`,
        UNKNOWN_LOCAL_HINT(name),
      );
    }
    if (!ctx.register) {
      throw new SpmError(
        `local repository "${name}" is declared but not registered on this machine`,
        `Run \`spm i\` to register it, or \`spm repository add ${declared.path} --name ${name}\`.`,
      );
    }
    registerLocal(declarationPath(declared), name, ctx.force ?? false);
  }

  const source = describeLocal(name);
  if (!source) {
    throw new SpmError(`local repository "${name}" vanished while it was being registered`);
  }

  return {
    type: "local",
    id: name,
    root: source.path,
    entry: formatCoordinate(coordinate),
    skills,
    label: formatCoordinate(coordinate),
    declaration: declared === null ? declarationFor(source, layers) : null,
  };
}

/**
 * A bare name with no repository: look it up across every registered
 * repository. This is the ergonomic that makes `spm add pdf-fill` work;
 * an ambiguous name lists the candidates instead of picking one.
 */
async function resolveBareSkillSpec(name: string): Promise<SourceSelection> {
  const matches: SourceSelection[] = [];
  const skipped: SkippedSkill[] = [];

  for (const source of await listSources()) {
    const opts = discoverOptionsFor(source.path);
    const { skills, invalid } = discoverSkills(source.path, opts);
    skipped.push(...skippedFrom(sourceLabel(source.kind, source.id), invalid));

    if (!skills.some((skill) => skill.name === name)) continue;
    matches.push({
      type: source.kind,
      id: source.id,
      root: source.path,
      entry: `${sourceLabel(source.kind, source.id)}:${name}`,
      skills: [name],
      label: `${sourceLabel(source.kind, source.id)}:${name}`,
      declaration: null,
    });
  }

  if (matches.length === 0) {
    throw new SpmError(
      `no skill named "${name}" in any registered repository`,
      [
        "Run `spm find <query>` to search, or `spm i -g` to register the repositories the global manifest declares.",
        ...(skipped.length > 0
          ? ["Skipped while looking:", ...skipped.map(skippedLine)]
          : []),
      ].join("\n  "),
    );
  }

  if (matches.length > 1) {
    throw new SpmError(
      `"${name}" exists in ${matches.length} repositories: ${matches.map((m) => m.label).join(", ")}`,
      `Disambiguate with one of: ${matches.map((m) => `spm add ${m.label}`).join(", ")}`,
    );
  }

  return matches[0]!;
}

async function ensureGithubIfAsked(
  repo: string,
  ctx: ResolveContext,
): Promise<RegisteredSource> {
  if (ctx.register) return ensureGithub(repo, ctx.force ?? false);

  const source = await describeGithub(repo);
  if (source === null) {
    throw new SpmError(
      `github repository "${repo}" is not cloned on this machine`,
      "Run `spm i` to fetch it.",
    );
  }
  return source;
}

/** Expands manifest coordinates, registering repositories as needed. */
export async function resolveManifestEntries(
  manifest: Manifest,
  ctx: Omit<ResolveContext, "manifest">,
): Promise<SourceSelection[]> {
  const layers = repositoryLayers(manifest, ctx.manifestDir, ctx.global);
  const selections: SourceSelection[] = [];

  for (const entry of manifest.skills) {
    const parsed = tryParseCoordinate(entry);
    if (parsed === null) {
      throw new SpmError(
        `skills.yaml declares an unusable coordinate "${entry}"`,
        COORDINATE_HINT,
      );
    }
    selections.push(await resolveCoordinate(parsed, { ...ctx, manifest }, layers));
  }

  return selections;
}

/** A skill resolved to a concrete directory on disk. */
export interface SkillTarget {
  name: string;
  /** Directory to symlink from. */
  skillDir: string;
  /** The repository it comes from, as `local:name` or `github:owner/repo`. */
  source: string;
  sourceRoot: string;
  label: string;
}

/**
 * Raised when a selection cannot be turned into skills.
 *
 * It carries the SKILL.md files discovery skipped, so a caller such as
 * `spm doctor` can explain why an entry came up empty instead of reporting a
 * bare "not found".
 */
export class SkillResolutionError extends SpmError {
  readonly skipped: SkippedSkill[];

  constructor(message: string, hint: string | undefined, skipped: SkippedSkill[]) {
    super(message, hint);
    this.name = "SkillResolutionError";
    this.skipped = skipped;
  }
}

export interface ExpansionResult {
  /** The skills the caller should act on. */
  targets: SkillTarget[];
  /** Every SKILL.md discovery refused, across all selections. */
  skipped: SkippedSkill[];
}

/**
 * Expands selections into individual skills.
 *
 * A selection that offers no usable skill stops the whole expansion, because
 * the manifest would otherwise gain an entry that provides nothing. A
 * selection that does resolve returns the files it skipped, and the caller
 * decides how to report them.
 */
export function expandSelections(selections: SourceSelection[]): ExpansionResult {
  const targets: SkillTarget[] = [];
  const skipped: SkippedSkill[] = [];
  const seenSkipped = new Set<string>();
  const byName = new Map<string, SkillTarget>();

  for (const selection of selections) {
    // A repository whose directory is gone is reported once, here, because
    // this is the only place that still knows which repository it was. The
    // alternative — a declaration check in `doctor` plus a discovery failure
    // here — counts one root cause twice.
    if (!isDirectory(selection.root)) {
      const target = readLink(selection.root);
      throw new SkillResolutionError(
        `${selection.label} is not available: ${target ?? selection.root} is missing`,
        selection.type === "local"
          ? `Re-register the local repository with \`spm repository add <path> --name ${selection.id}\`.`
          : `Run \`spm i\` to fetch ${selection.id} again.`,
        [],
      );
    }

    const opts = discoverOptionsFor(selection.root);
    const { skills: available, invalid } = discoverSkills(selection.root, opts);

    // The same repository can be covered by several declarations; report each
    // skipped file once.
    const own = skippedFrom(sourceLabel(selection.type, selection.id), invalid);
    for (const item of own) {
      if (seenSkipped.has(item.skillFile)) continue;
      seenSkipped.add(item.skillFile);
      skipped.push(item);
    }
    const skippedLines = own.map(skippedLine);

    let chosen: DiscoveredSkill[];
    if (selection.skills === "*") {
      chosen = available;
      if (chosen.length === 0) {
        throw new SkillResolutionError(
          `${selection.label} contains no usable skills`,
          skippedLines.length > 0
            ? ["Every SKILL.md under it was skipped:", ...skippedLines].join("\n  ")
            : `Nothing with a SKILL.md was found under ${selection.root}.`,
          skipped,
        );
      }
    } else {
      chosen = [];
      for (const wanted of selection.skills) {
        const found = available.find((skill) => skill.name === wanted);
        if (!found) {
          const hints = [
            available.length > 0
              ? `Available: ${available.map((skill) => skill.name).join(", ")}`
              : `No usable SKILL.md was found under ${selection.root}.`,
          ];
          if (skippedLines.length > 0) hints.push("Skipped:", ...skippedLines);
          throw new SkillResolutionError(
            `skill "${wanted}" not found in ${selection.label}`,
            hints.join("\n  "),
            skipped,
          );
        }
        chosen.push(found);
      }
    }

    for (const skill of chosen) {
      const existing = byName.get(skill.name);
      if (existing && existing.sourceRoot !== selection.root) {
        throw new SpmError(
          `skill "${skill.name}" is provided by two repositories`,
          `${existing.label} and ${selection.label}. Remove one declaration from skills.yaml.`,
        );
      }
      if (existing) continue;

      const target: SkillTarget = {
        name: skill.name,
        skillDir: skill.dir,
        source: sourceLabel(selection.type, selection.id),
        sourceRoot: selection.root,
        label: selection.label,
      };
      byName.set(skill.name, target);
      targets.push(target);
    }
  }

  targets.sort((a, b) => a.name.localeCompare(b.name));
  return { targets, skipped };
}

/** Whether a declared coordinate is the one a parsed specifier names. */
export function coordinateMatches(entry: string, target: SpecTarget): boolean {
  const parsed = tryParseCoordinate(entry);
  if (parsed === null) return false;

  switch (target.kind) {
    case "coordinate": {
      const wanted = target.coordinate;
      if (parsed.type !== wanted.type || parsed.repository !== wanted.repository) {
        return false;
      }
      return namesWholeRepository(wanted) || parsed.skill === wanted.skill;
    }
    case "skill":
      return parsed.skill === target.name;
    case "path":
      return false; // The caller turns a path into a repository coordinate first.
  }
}

/** The whole-repository coordinate for a registered local directory, if any. */
export function coordinateForPath(abs: string): Coordinate | null {
  const source = findLocalByPath(expandPath(abs, process.cwd()));
  if (source === null) return null;
  return { type: "local", repository: source.id, skill: WHOLE_REPOSITORY };
}

/** Where a repository's cache entry is, or null when it isn't registered. */
export function registeredRoot(coordinate: Coordinate): string | null {
  const entry = sourcePath(coordinate.type, coordinate.repository);
  return exists(entry) ? entry : null;
}

function discoverOptionsFor(root: string): DiscoverOptions {
  // Discovery options come from the repository's own skill-repository.yaml.
  const manifest = readRepoManifest(root);
  return { exclude: manifest.exclude, maxDepth: manifest.maxDepth };
}

export function isPathLike(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    spec === "." ||
    spec === ".." ||
    spec.startsWith("~")
  );
}
