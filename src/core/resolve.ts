import os from "node:os";
import path from "node:path";
import { expandPath, spmHome } from "../config.js";
import { SpmError } from "../errors.js";
import { canonical, exists, isDirectory, readLink } from "../fsutil.js";
import {
  ALIAS_TYPE,
  COORDINATE_HINT,
  PATH_TYPE,
  WHOLE_REPOSITORY,
  formatCoordinate,
  isRepositoryCoordinate,
  isRepositoryType,
  namesWholeRepository,
  readCoordinate,
  tryParseCoordinate,
  type AliasCoordinate,
  type Coordinate,
  type CoordinateType,
  type PathCoordinate,
  type RepositoryCoordinate,
} from "./coordinate.js";
import {
  discoverSkills,
  parseSkillMd,
  skippedFrom,
  skippedLine,
  type DiscoveredSkill,
  type DiscoverOptions,
  type SkippedSkill,
} from "./discover.js";
import { manifestPath, type Manifest } from "./manifest.js";
import { declarationPath, globalAliases, lookupLocalRepository, repositoryLayers, type RepositoryLayers } from "./registry.js";
import { readRepoManifest } from "./repo-manifest.js";
import {
  defaultRepositoryName,
  describeGithub,
  describeLocal,
  ensureGithub,
  ensurePathSource,
  findEnclosingLocal,
  findLocalByPath,
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
 * A place skills come from, with the subset to install and everything needed
 * to write the dependency back into a manifest.
 *
 * A repository fills in `id` with its name and `root` with its cache entry.
 * A `path:` selection has no repository behind it: `id` is the directory as
 * written and `root` is that directory itself.
 */
export interface SourceSelection {
  type: CoordinateType;
  /** A local repository name, `owner/name`, or the directory itself. */
  id: string;
  /** Absolute path of the source root on disk. */
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
  /** Refuse a github cache entry that is not a git checkout. */
  force?: boolean | undefined;
  /** Name to register a local directory under; defaults to its declared name. */
  name?: string | undefined;
}

/** What a CLI specifier names, before anything is registered. */
export type SpecTarget =
  | { kind: "path"; path: string }
  | { kind: "skill"; name: string }
  | { kind: "coordinate"; coordinate: Coordinate };

/** The prefix used in messages and JSON output: `local:mine`, `path:/x/skills/pdf`. */
export function sourceLabel(type: CoordinateType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Reads one CLI specifier.
 *
 * Accepted forms:
 *
 *   ./path, /abs/path, ~/path           a local directory: a skill by path,
 *                                       or a repository registered on the fly
 *   local:name:skill, local:name:*      a registered local repository
 *   github:owner/repo:skill             a github repository
 *   local:name, github:owner/repo       the whole repository
 *   path:<directory>                    one skill directory
 *   alias:<name>                        a name the global manifest defines
 *   owner/repo[:skill]                  github shorthand
 *   name[:skill]                        local shorthand, when `name` is known
 *   skill-name                          a skill looked up across all repositories
 *
 * The type segment can be left out of the shorthand forms, because `owner/repo`
 * carries a slash a repository name never has, and a name is only accepted as a
 * repository when this machine already knows it. `alias:` is never left out:
 * an alias and a repository name are two separate tables, so a bare name is
 * never ambiguous between them.
 */
export function parseSpecTarget(
  spec: string,
  isKnownLocal: (name: string) => boolean,
): SpecTarget {
  const trimmed = spec.trim();
  if (trimmed === "") throw new SpmError("empty skill specifier");

  if (isPathLike(trimmed)) return { kind: "path", path: trimmed };

  const segments = trimmed.split(":");
  const head = segments[0]!;

  // Checked before the segment count: a path coordinate's directory may itself
  // contain a colon, and would otherwise look like a four-segment coordinate.
  if (head === PATH_TYPE || head === ALIAS_TYPE) {
    return { kind: "coordinate", coordinate: buildCoordinate(trimmed) };
  }

  if (segments.length === 1) {
    const token = segments[0]!;
    if (token.includes("/")) {
      return {
        kind: "coordinate",
        coordinate: buildCoordinate(`github:${token}:${WHOLE_REPOSITORY}`, trimmed),
      };
    }
    if (isKnownLocal(token)) {
      return {
        kind: "coordinate",
        coordinate: buildCoordinate(`local:${token}:${WHOLE_REPOSITORY}`, trimmed),
      };
    }
    return { kind: "skill", name: token };
  }

  if (segments.length === 2) {
    const [head2, rest] = segments as [string, string];

    if (isRepositoryType(head2)) {
      return {
        kind: "coordinate",
        coordinate: buildCoordinate(`${head2}:${rest}:${WHOLE_REPOSITORY}`, trimmed),
      };
    }
    if (head2.includes("/")) {
      return { kind: "coordinate", coordinate: buildCoordinate(`github:${head2}:${rest}`, trimmed) };
    }
    if (isKnownLocal(head2)) {
      return { kind: "coordinate", coordinate: buildCoordinate(`local:${head2}:${rest}`, trimmed) };
    }
    throw new SpmError(
      `unknown repository "${head2}"`,
      `${UNKNOWN_LOCAL_HINT(head2)} A repository name never contains a slash.`,
    );
  }

  if (segments.length === 3) {
    return { kind: "coordinate", coordinate: buildCoordinate(trimmed) };
  }

  throw new SpmError(
    `"${trimmed}" is not a usable specifier`,
    `${COORDINATE_HINT} A local directory is given as a plain path.`,
  );
}

const UNKNOWN_LOCAL_HINT = (name: string): string =>
  `Register it with \`spm repository add <path> --name ${name}\`;`;

/**
 * Parses a specifier into a coordinate.
 *
 * `text` is what actually gets parsed; `asGiven` is what the user typed, which
 * the error quotes. The two differ wherever a shorthand fills a segment in.
 */
function buildCoordinate(text: string, asGiven: string = text): Coordinate {
  const result = readCoordinate(text);
  if (!result.ok) {
    throw new SpmError(
      `"${asGiven}" is not a usable specifier: ${result.reason}`,
      COORDINATE_HINT,
    );
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

  // A directory holding SKILL.md is one skill, so it never becomes a source:
  // the manifest records the directory itself. Checked before the registration
  // guards below, because that is what makes a path inside a registered
  // repository usable instead of a duplicate registration.
  if (exists(path.join(abs, "SKILL.md"))) {
    if (ctx.name !== undefined) {
      throw new SpmError(
        `--name does not apply to ${abs}: it is a skill directory`,
        "A path coordinate records the directory itself, so there is no repository name to pick.",
      );
    }
    return pathSelection(abs, spec, ctx.register);
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
      `Re-run with \`--name <other-name>\`, or remove the existing declaration for "${name}".`,
    );
  }

  if (ctx.register) {
    refuseUnusableDirectory(abs, name);
    registerLocal(abs, name);
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

/**
 * Refuses a directory that exposes no usable skill, before it becomes a source.
 *
 * A registration that can only produce errors is worse than none: it appears in
 * `spm find` and `spm repository list` for as long as the cache entry exists,
 * and the discovery step that finds out happens after the link has been
 * written. A directory with *some* usable skills is left alone, because there
 * the usable part stays available and the skipped files are reported at the end
 * of the command.
 */
function refuseUnusableDirectory(abs: string, name: string): void {
  const { skills, invalid } = discoverSkills(abs, discoverOptionsFor(abs));
  if (skills.length > 0) return;

  const skipped = skippedFrom(sourceLabel("local", name), invalid);
  throw new SkillResolutionError(
    `${abs} exposes no skill`,
    [
      `Nothing usable was found under ${abs}.`,
      ...(skipped.length > 0 ? ["Skipped:", ...skipped.map(skippedLine)] : []),
    ].join("\n  "),
    skipped,
  );
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

/**
 * Turns a skill directory into a selection.
 *
 * "Skill directory" means the directory holds SKILL.md itself, and the name
 * lives in that file rather than in the coordinate — reading it here is what
 * lets `spm list`, `spm info` and the install report name the skill. A
 * directory holding something else is refused, and the refusal says which of
 * the two other things it is: a directory of skills, or neither.
 *
 * The selection's root is the directory's cache entry when writing is allowed,
 * so that the link spm creates points into the source cache like every other
 * link it makes. Read-only commands resolve straight to the directory, and the
 * two compare equal because the entry is a symlink to it.
 */
function pathSelection(
  dir: string,
  asWritten: string,
  register: boolean,
): SourceSelection {
  const label = `${PATH_TYPE}:${asWritten}`;

  if (!isDirectory(dir)) {
    throw new SpmError(
      `${dir} is not a directory`,
      "A path coordinate names the directory that holds a SKILL.md.",
    );
  }

  const parsed = parseSkillMd(path.join(dir, "SKILL.md"), dir);
  if (parsed.ok) {
    return {
      type: PATH_TYPE,
      id: asWritten,
      root: register ? ensurePathSource(dir) : dir,
      entry: label,
      skills: [parsed.skill.name],
      label,
      declaration: null,
    };
  }

  const { skills, invalid } = discoverSkills(dir);
  const skipped = skippedFrom(label, invalid);

  throw new SkillResolutionError(
    skills.length > 0
      ? `${label} is not a skill directory — it holds ${skills.length} skill${
          skills.length === 1 ? "" : "s"
        }`
      : `${label} holds no usable skill`,
    skills.length > 0
      ? `Register it with \`spm repository add ${dir}\`, or name one of the skills it holds.`
      : [
          `Nothing usable is at ${path.join(dir, "SKILL.md")}.`,
          ...(skipped.length > 0 ? ["Skipped:", ...skipped.map(skippedLine)] : []),
        ].join("\n  "),
    skipped,
  );
}

async function resolveCoordinate(
  coordinate: Coordinate,
  ctx: ResolveContext,
  layers: RepositoryLayers,
): Promise<SourceSelection> {
  if (coordinate.type === PATH_TYPE) {
    return pathSelection(
      expandPath(coordinate.dir, ctx.manifestDir),
      coordinate.dir,
      ctx.register,
    );
  }

  if (coordinate.type === ALIAS_TYPE) {
    return resolveAliasCoordinate(coordinate, ctx, layers);
  }

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

/**
 * Resolves a machine-level name to whatever it names.
 *
 * The name table comes from the global manifest, and the target is resolved
 * against the table's own base directory rather than the manifest being
 * edited: a relative `path:` in the alias means the same thing everywhere.
 * The selection keeps the alias as its identity, so `skills.yaml` records
 * `alias:<name>` and every message names it that way, however the target looks.
 */
async function resolveAliasCoordinate(
  coordinate: AliasCoordinate,
  ctx: ResolveContext,
  layers: RepositoryLayers,
): Promise<SourceSelection> {
  const alias = globalAliases().get(coordinate.name);
  if (alias === undefined) throw unknownAliasError(coordinate.name);

  const expanded = expandAlias(coordinate.name);
  if (expanded === null) {
    throw new SpmError(
      `alias "${coordinate.name}" is not usable`,
      `Its target "${alias.target}" is not a coordinate. Fix it with \`spm alias add ${coordinate.name} <spec>\`.`,
    );
  }

  const found = await resolveCoordinate(
    expanded.coordinate,
    { ...ctx, manifestDir: expanded.baseDir },
    layers,
  );

  return {
    ...found,
    type: ALIAS_TYPE,
    id: coordinate.name,
    entry: formatCoordinate(coordinate),
    label: formatCoordinate(coordinate),
  };
}

/**
 * The coordinate an alias names.
 *
 * Null when this machine defines no such alias. The target's shape is checked
 * when the manifest is read, so a second look here only guards against the
 * global manifest changing underneath the run.
 */
export function expandAlias(
  name: string,
): { coordinate: Coordinate; baseDir: string } | null {
  const alias = globalAliases().get(name);
  if (alias === undefined) return null;

  const parsed = readCoordinate(alias.target);
  if (!parsed.ok) return null;
  return { coordinate: parsed.coordinate, baseDir: alias.baseDir };
}

/** The error an unknown alias reports, so every command phrases it the same. */
export function unknownAliasError(name: string): SpmError {
  return new SpmError(
    `unknown alias "${name}"`,
    `Define it with \`spm alias add ${name} <spec>\`, or check the aliases in ${manifestPath(spmHome())}.`,
  );
}


async function resolveLocalCoordinate(
  coordinate: RepositoryCoordinate,
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
    registerLocal(declarationPath(declared), name);
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
        // Two roots can still reach one directory — a repository and a
        // `path:` entry naming one of its skills, for instance. Saying so is
        // the difference between "pick one" and "you declared the same thing
        // twice".
        const samePlace = canonical(existing.skillDir) === canonical(skill.dir);
        throw new SpmError(
          samePlace
            ? `skill "${skill.name}" is declared twice for the same directory`
            : `skill "${skill.name}" is provided by two repositories`,
          `${existing.label} and ${selection.label}` +
            (samePlace
              ? " reach the same directory. Remove one declaration from skills.yaml."
              : ". Remove one declaration from skills.yaml."),
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

/**
 * Whether a declared coordinate is the one a parsed specifier names.
 *
 * A `path:` entry carries no skill name, so matching it against a bare skill
 * name means reading the directory it points at. `baseDir` is what its
 * relative value resolves against — the directory holding the manifest being
 * edited.
 *
 * An `alias:` entry matches only the same alias, and is never expanded to
 * compare against its target: the two spellings are separate statements, and
 * `spm list` shows which one this manifest made.
 */
export function coordinateMatches(
  entry: string,
  target: SpecTarget,
  baseDir: string,
): boolean {
  const parsed = tryParseCoordinate(entry);
  if (parsed === null) return false;

  if (parsed.type === PATH_TYPE) {
    if (target.kind === "path") return sameDirectory(parsed.dir, target.path, baseDir);
    if (target.kind === "skill") return pathSkillName(parsed, baseDir) === target.name;
    if (target.coordinate.type !== PATH_TYPE) return false;
    return sameDirectory(parsed.dir, target.coordinate.dir, baseDir);
  }

  if (parsed.type === ALIAS_TYPE) {
    // A bare skill name matches a name-based coordinate only when it is a
    // repository coordinate; an alias is addressed by its own name.
    return (
      target.kind === "coordinate" &&
      target.coordinate.type === ALIAS_TYPE &&
      target.coordinate.name === parsed.name
    );
  }

  switch (target.kind) {
    case "coordinate": {
      const wanted = target.coordinate;
      if (!isRepositoryCoordinate(wanted)) return false;
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

/** Whether two written-out directories name the same place. */
function sameDirectory(a: string, b: string, baseDir: string): boolean {
  return canonical(expandPath(a, baseDir)) === canonical(expandPath(b, baseDir));
}

/** The skill a path coordinate names, or null when the directory can't say. */
function pathSkillName(coordinate: PathCoordinate, baseDir: string): string | null {
  const dir = expandPath(coordinate.dir, baseDir);
  if (!isDirectory(dir)) return null;
  const found = discoverSkills(dir).skills;
  return found.length === 1 ? found[0]!.name : null;
}

/**
 * The coordinate for a directory on disk: a `path:` coordinate when the
 * directory is itself a skill, otherwise the registration covering it.
 */
export function coordinateForPath(abs: string): Coordinate | null {
  const expanded = expandPath(abs, process.cwd());
  if (exists(path.join(expanded, "SKILL.md"))) {
    return { type: PATH_TYPE, dir: abs };
  }

  const source = findLocalByPath(expanded);
  if (source === null) return null;
  return { type: "local", repository: source.id, skill: WHOLE_REPOSITORY };
}

/** Where a repository's cache entry is, or null when it isn't registered. */
export function registeredRoot(coordinate: RepositoryCoordinate): string | null {
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
