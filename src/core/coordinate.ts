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
 * Names a repository may not take. Both are spelled the way a coordinate's
 * type segment is spelled, so allowing them would make shorthand specifiers
 * such as `local` ambiguous.
 */
const RESERVED_NAMES = new Set<string>(REPOSITORY_TYPES);

/** The character set skill discovery accepts. */
const SKILL_NAME = /^[a-z0-9._-]+$/;

/** A github repository: `owner/name`. */
const GITHUB_REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** A local repository name; it becomes one segment of the source cache path. */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;

/** The skill segment that stands for every skill in a repository. */
export const WHOLE_REPOSITORY = "*";

/** Shown wherever a malformed coordinate is reported. */
export const COORDINATE_HINT =
  "A coordinate reads <local|github>:<repository>:<skill>, for example local:mine:pdf-fill or github:owner/repo:*. Use * to name every skill in a repository.";

/**
 * A skill named together with the repository it comes from.
 *
 * The three segments mirror Gradle's `group:artifact:version`: the type says
 * where the repository lives, the repository identifies it, and the skill says
 * what to install from it.
 */
export interface Coordinate {
  type: RepositoryType;
  /** A local repository name, or `owner/name` for a github repository. */
  repository: string;
  /** A skill name, or `*` for every skill in the repository. */
  skill: string;
}

export function isRepositoryType(value: string): value is RepositoryType {
  return (REPOSITORY_TYPES as readonly string[]).includes(value);
}

export function formatCoordinate(coordinate: Coordinate): string {
  return `${coordinate.type}:${coordinate.repository}:${coordinate.skill}`;
}

/** The repository prefix of a coordinate: `local:mine`, `github:owner/repo`. */
export function repositoryKey(coordinate: Coordinate): string {
  return `${coordinate.type}:${coordinate.repository}`;
}

export function namesWholeRepository(coordinate: Coordinate): boolean {
  return coordinate.skill === WHOLE_REPOSITORY;
}

/** Whether `name` can identify a locally registered repository. */
export function validRepositoryName(name: string): boolean {
  return (
    REPOSITORY_NAME.test(name) &&
    !name.startsWith(".") &&
    !RESERVED_NAMES.has(name)
  );
}

/** Whether `repo` has the `owner/name` shape a github coordinate requires. */
export function validGithubRepository(repo: string): boolean {
  return GITHUB_REPOSITORY.test(repo);
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
 * Parses `<type>:<repository>:<skill>`.
 *
 * Nothing that may appear in any segment can contain a colon, so splitting on
 * every colon gives exactly three segments. Returning the reason instead of
 * throwing lets the manifest schema report which entry is wrong.
 */
export function readCoordinate(text: string): CoordinateParse {
  const trimmed = text.trim();
  const segments = trimmed.split(":");

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
      reason: `unknown repository type "${type}" — expected ${REPOSITORY_TYPES.join(" or ")}`,
    };
  }

  if (type === "local") {
    if (!validRepositoryName(repository)) {
      return {
        ok: false,
        reason:
          `"${repository}" is not a usable local repository name — ` +
          "letters, digits, dots, dashes and underscores, not starting with a dot, and not local or github",
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
