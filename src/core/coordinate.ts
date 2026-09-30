import { SpmError } from "../errors.js";

/**
 * The repository kinds a skill coordinate can name.
 *
 * `local` is a directory registered on this machine under a name, because a
 * directory path is not an identity. `github` is identified by `owner/name`
 * itself, so a github repository needs no registration at all.
 */
export const REPOSITORY_TYPES = ["local", "github"] as const;

export type RepositoryType = (typeof REPOSITORY_TYPES)[number];

/**
 * The prefix of a coordinate that names a skill directory directly, without a
 * repository and without registering anything.
 */
export const PATH_TYPE = "path";

/**
 * The prefix of a coordinate that names a skill by a name the machine defines.
 *
 * Unlike `local:`, this carries no claim about where the skill lives — the
 * alias table in the global manifest answers that — so it still tells the
 * truth when it points at a github repository.
 */
export const ALIAS_TYPE = "alias";

/** Every form a coordinate can take, in the order the hint lists them. */
export const COORDINATE_TYPES = [...REPOSITORY_TYPES, PATH_TYPE, ALIAS_TYPE] as const;

export type CoordinateType = (typeof COORDINATE_TYPES)[number];

/**
 * Names a repository may not take. Every coordinate type is spelled the way a
 * coordinate's first segment is spelled, so allowing one would make shorthand
 * specifiers such as `local`, and the `path:` form itself, ambiguous.
 */
const RESERVED_NAMES = new Set<string>(COORDINATE_TYPES);

/** The character set skill discovery accepts. */
const SKILL_NAME = /^[a-z0-9._-]+$/;

/** One segment of a github `owner/name`. */
const GITHUB_SEGMENT = /^[\w.-]+$/;

/** A local repository name; it becomes one segment of the source cache path. */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;

/** The skill segment that stands for every skill in a repository. */
export const WHOLE_REPOSITORY = "*";

/** Shown wherever a malformed coordinate is reported. */
export const COORDINATE_HINT =
  "A coordinate reads <local|github>:<repository>:<skill>, for example " +
  "local:mine:pdf-fill or github:owner/repo:*, or path:<directory> for a skill " +
  "directory no repository holds, or alias:<name> for a name the global " +
  "skills.yaml defines. Use * to name every skill in a repository.";

/**
 * A skill named together with the repository it comes from.
 *
 * The three segments mirror Gradle's `group:artifact:version`: the type says
 * where the repository lives, the repository identifies it, and the skill says
 * what to install from it.
 */
export interface RepositoryCoordinate {
  type: RepositoryType;
  /** A local repository name, or `owner/name` for a github repository. */
  repository: string;
  /** A skill name, or `*` for every skill in the repository. */
  skill: string;
}

/**
 * A skill named by the directory holding it.
 *
 * No repository is involved: the directory is the skill. That is only true of
 * a directory with SKILL.md at its root, which is why this form neither needs
 * nor creates a registration, and why it is not part of `spm find`'s search
 * scope.
 */
export interface PathCoordinate {
  type: typeof PATH_TYPE;
  /** The directory, as written in the manifest. */
  dir: string;
}

/**
 * A skill named by the machine's alias table.
 *
 * An alias names exactly one skill. It is a machine-level statement, kept in
 * the global manifest, so several projects can install the same skill without
 * repeating where it lives — and without the name joining any search scope.
 */
export interface AliasCoordinate {
  type: typeof ALIAS_TYPE;
  /** The alias name. */
  name: string;
}

export type Coordinate = RepositoryCoordinate | PathCoordinate | AliasCoordinate;

export function isRepositoryType(value: string): value is RepositoryType {
  return (REPOSITORY_TYPES as readonly string[]).includes(value);
}

/** Narrows to the coordinates that name a repository. */
export function isRepositoryCoordinate(
  coordinate: Coordinate,
): coordinate is RepositoryCoordinate {
  return coordinate.type === "local" || coordinate.type === "github";
}

export function formatCoordinate(coordinate: Coordinate): string {
  if (coordinate.type === PATH_TYPE) return `${PATH_TYPE}:${coordinate.dir}`;
  if (coordinate.type === ALIAS_TYPE) return `${ALIAS_TYPE}:${coordinate.name}`;
  return `${coordinate.type}:${coordinate.repository}:${coordinate.skill}`;
}

/**
 * The key that groups coordinates by the place they install from: `local:mine`
 * or `github:owner/repo` for a repository, `path:<directory>` for a skill
 * directory, `alias:<name>` for a machine-level name. Coordinates sharing a key
 * are alternatives within one source.
 */
export function repositoryKey(coordinate: Coordinate): string {
  if (coordinate.type === PATH_TYPE) return `${PATH_TYPE}:${coordinate.dir}`;
  if (coordinate.type === ALIAS_TYPE) return `${ALIAS_TYPE}:${coordinate.name}`;
  return `${coordinate.type}:${coordinate.repository}`;
}

export function namesWholeRepository(coordinate: Coordinate): boolean {
  return isRepositoryCoordinate(coordinate) && coordinate.skill === WHOLE_REPOSITORY;
}

/**
 * Whether `dir` can be the value of a `path:` coordinate.
 *
 * The directory is resolved exactly like a repository `path` is, so relative
 * values and `~` are fine. The one value refused is `*`: a path coordinate
 * names one directory, and there is no such thing as every skill of a
 * directory that is itself a skill.
 */
export function validPathValue(dir: string): boolean {
  return dir.trim() !== "" && dir.trim() !== WHOLE_REPOSITORY;
}

/**
 * Whether `name` can identify a locally registered repository or an alias.
 *
 * Both become one segment of a coordinate, and both are usable as a bare name,
 * so they follow one rule: the character set that survives both, no leading
 * dot, and nothing that is already a coordinate type.
 */
function usableName(name: string): boolean {
  return (
    REPOSITORY_NAME.test(name) &&
    !name.startsWith(".") &&
    !RESERVED_NAMES.has(name)
  );
}

/** Whether `name` can identify a locally registered repository. */
export function validRepositoryName(name: string): boolean {
  return usableName(name);
}

/** Whether `name` can be defined as an alias. */
export function validAliasName(name: string): boolean {
  return usableName(name);
}

/**
 * Whether `repo` has the `owner/name` shape a github coordinate requires.
 *
 * Each segment becomes a directory name under the source cache, so `.` and
 * `..` are refused: either one resolves outside the cache and would let a
 * manifest name an arbitrary directory as a github repository.
 */
export function validGithubRepository(repo: string): boolean {
  const segments = repo.split("/");
  if (segments.length !== 2) return false;
  return segments.every(
    (segment) => segment !== "." && segment !== ".." && GITHUB_SEGMENT.test(segment),
  );
}

/** Whether `skill` can appear as the third segment of a coordinate. */
export function validSkillSegment(skill: string): boolean {
  return (
    skill === WHOLE_REPOSITORY ||
    (SKILL_NAME.test(skill) && !skill.startsWith("."))
  );
}

export type CoordinateParse =
  | { ok: true; coordinate: Coordinate }
  | { ok: false; reason: string };

/**
 * Parses a coordinate.
 *
 * Two shapes reach this reader. `<local|github>:<repository>:<skill>` holds no
 * colon in any segment, so splitting on every colon gives exactly three
 * segments. `path:<directory>` takes everything after the first colon, so a
 * directory containing a colon survives intact. Returning the reason instead
 * of throwing lets the manifest schema report which entry is wrong.
 */
/**
 * Parses a coordinate.
 *
 * Three shapes reach this reader. `<local|github>:<repository>:<skill>` holds
 * no colon in any segment, so splitting on every colon gives exactly three
 * segments. `path:<directory>` and `alias:<name>` take everything after the
 * first colon, because a directory may legally contain a colon. Returning the
 * reason instead of throwing lets the manifest schema report which entry is
 * wrong.
 */
export function readCoordinate(text: string): CoordinateParse {
  const trimmed = text.trim();
  const segments = trimmed.split(":");
  const head = segments[0]!;

  // `path:<directory>` takes everything after the first colon as the
  // directory, because a directory may legally contain a colon. Splitting on
  // every colon would silently truncate such a path.
  if (head === PATH_TYPE) {
    const dir = trimmed.slice(PATH_TYPE.length + 1);
    if (!validPathValue(dir)) {
      return {
        ok: false,
        reason: `"${dir}" is not a usable directory — a path coordinate names one skill directory`,
      };
    }
    return { ok: true, coordinate: { type: PATH_TYPE, dir } };
  }

  if (head === ALIAS_TYPE) {
    const name = trimmed.slice(ALIAS_TYPE.length + 1);
    if (!validAliasName(name)) {
      return {
        ok: false,
        reason: `"${name}" is not a usable alias name — letters, digits, dots, dashes and underscores, not starting with a dot, and not local, github, path or alias`,
      };
    }
    return { ok: true, coordinate: { type: ALIAS_TYPE, name } };
  }

  if (segments.length !== 3) {
    return {
      ok: false,
      reason: `${segments.length} segment${segments.length === 1 ? "" : "s"} instead of 3`,
    };
  }

  const [type, repository, skill] = segments as [string, string, string];

  if (!isRepositoryType(type)) {
    return {
      ok: false,
      reason: `unknown coordinate type "${type}" — expected ${COORDINATE_TYPES.join(", ")}`,
    };
  }

  if (type === "local") {
    if (!validRepositoryName(repository)) {
      return {
        ok: false,
        reason:
          `"${repository}" is not a usable local repository name — ` +
          "letters, digits, dots, dashes and underscores, not starting with a dot, and not local, github, path or alias",
      };
    }
  } else if (!validGithubRepository(repository)) {
    return {
      ok: false,
      reason: `"${repository}" is not a github repository — expected owner/name`,
    };
  }

  if (!validSkillSegment(skill)) {
    return { ok: false, reason: `"${skill}" is not a usable skill name` };
  }

  return { ok: true, coordinate: { type, repository, skill } };
}

/** Parses a coordinate, or returns null when the text is not one. */
export function tryParseCoordinate(text: string): Coordinate | null {
  const result = readCoordinate(text);
  return result.ok ? result.coordinate : null;
}

/** Parses a coordinate, throwing a SpmError that explains what is wrong. */
export function parseCoordinate(text: string): Coordinate {
  const result = readCoordinate(text);
  if (result.ok) return result.coordinate;
  throw new SpmError(`"${text}" is not a skill coordinate: ${result.reason}`, COORDINATE_HINT);
}
