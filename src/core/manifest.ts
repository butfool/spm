import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { SpmError } from "../errors.js";
import {
  COORDINATE_HINT,
  formatCoordinate,
  namesWholeRepository,
  parseCoordinate,
  readCoordinate,
  repositoryKey,
  tryParseCoordinate,
  validAliasName,
  validRepositoryName,
  type Coordinate,
} from "./coordinate.js";

/** Manifest filename, both for projects and for the global scope. */
export const MANIFEST_FILENAME = "skills.yaml";

/**
 * A locally registered repository.
 *
 * Github repositories have no declaration: `owner/name` already identifies
 * them, so nothing about them needs recording next to the manifest.
 */
export const LocalRepositorySchema = z.object({
  type: z.literal("local"),
  path: z.string().min(1),
});

export type LocalRepositoryDecl = z.infer<typeof LocalRepositorySchema>;

/**
 * The manifest schema. Unknown keys are refused, because a typo such as
 * `repositorie:` would otherwise silently drop every declaration under it and
 * surface later as a baffling "unknown local repository". (`skill-repository.yaml`
 * goes the other way on purpose: those files belong to third parties.)
 */
export const ManifestSchema = z.strictObject({
  /**
   * Where declared skills get linked. Empty means "inherit settings.yaml",
   * then the built-in default. Relative entries resolve against this
   * manifest's directory.
   */
  installDirs: z.array(z.string().min(1)).default([]),
  /**
   * Local repositories, keyed by the name skills are declared against. A
   * project lists the ones only it needs; the global manifest doubles as the
   * machine-level registry.
   */
  repositories: z.record(z.string(), LocalRepositorySchema).default({}),
  /**
   * Machine-level names for single skills, keyed by the name a coordinate uses.
   *
   * An alias exists so a project can install a skill that lives outside every
   * repository without repeating where it is. Its value must name one skill;
   * naming a whole repository is `repositories:`'s job.
   */
  aliases: z.record(z.string(), z.string().min(1)).default({}),
  /** The declared skills, each a `<type>:<repository>:<skill>` coordinate. */
  skills: z.array(z.string().min(1)).default([]),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export const EMPTY_MANIFEST: Manifest = ManifestSchema.parse({});

export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_FILENAME);
}

export function manifestExists(dir: string): boolean {
  return fs.existsSync(manifestPath(dir));
}

/**
 * Reads a manifest from `dir`. Returns null when the file is absent; throws a
 * SpmError when it exists but is malformed, since silently proceeding on a
 * partial manifest would install the wrong set of skills.
 */
export function readManifest(dir: string): Manifest | null {
  const file = manifestPath(dir);
  if (!fs.existsSync(file)) return null;

  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (err) {
    throw new SpmError(`${file} is not valid YAML: ${(err as Error).message}`);
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new SpmError(
      `${file} is invalid: ${z.prettifyError(result.error)}`,
      `Run \`spm init\` to start from a clean manifest.`,
    );
  }

  checkRepositories(file, result.data);
  checkAliases(file, result.data);
  checkCoordinates(file, result.data);
  return result.data;
}

/**
 * Repository names become path segments under the source cache, so a name
 * carrying a slash or starting with a dot would register outside it. The
 * character check in `validRepositoryName` is what keeps a hand-written
 * manifest from writing links anywhere on disk.
 */
function checkRepositories(file: string, manifest: Manifest): void {
  for (const name of Object.keys(manifest.repositories)) {
    if (validRepositoryName(name)) continue;
    throw new SpmError(
      `${file} declares the unusable repository name "${name}"`,
      "Names may contain letters, digits, dots, dashes and underscores, may not start with a dot, and may not be local or github.",
    );
  }
}

/**
 * An alias name becomes a coordinate segment, and its value must name exactly
 * one skill. Both are checked here, so a hand-written manifest fails on the
 * line that is wrong instead of at the first install.
 */
function checkAliases(file: string, manifest: Manifest): void {
  for (const [name, target] of Object.entries(manifest.aliases)) {
    if (!validAliasName(name)) {
      throw new SpmError(
        `${file} declares the unusable alias name "${name}"`,
        "Names may contain letters, digits, dots, dashes and underscores, may not start with a dot, and may not be local, github, path or alias.",
      );
    }

    const parsed = readCoordinate(target);
    if (!parsed.ok) {
      throw new SpmError(
        `${file} declares the alias "${name}" as "${target}": ${parsed.reason}`,
        COORDINATE_HINT,
      );
    }

    if (parsed.coordinate.type === "alias") {
      throw new SpmError(
        `${file} declares the alias "${name}" as another alias`,
        "An alias names a skill, not another name. Point it at the skill itself.",
      );
    }

    if (namesWholeRepository(parsed.coordinate)) {
      throw new SpmError(
        `${file} declares the alias "${name}" as a whole repository: "${target}"`,
        "An alias names one skill. Register a repository to name a directory of them.",
      );
    }
  }
}

function checkCoordinates(file: string, manifest: Manifest): void {
  for (const entry of manifest.skills) {
    const parsed = readCoordinate(entry);
    if (!parsed.ok) {
      throw new SpmError(
        `${file} declares an invalid skill coordinate "${entry}": ${parsed.reason}`,
        COORDINATE_HINT,
      );
    }
  }
}

/** The manifest's skill entries as parsed coordinates. */
export function manifestCoordinates(manifest: Manifest): Coordinate[] {
  return manifest.skills.map(parseCoordinate);
}

/** Reads a manifest, erroring when it is missing. */
export function requireManifest(dir: string, scopeLabel: string): Manifest {
  const manifest = readManifest(dir);
  if (manifest === null) {
    throw new SpmError(
      `no ${MANIFEST_FILENAME} in ${dir}`,
      scopeLabel === "global"
        ? `Create ${manifestPath(dir)} to declare globally installed skills.`
        : `Run \`spm init\` to create one.`,
    );
  }
  return manifest;
}

/**
 * Shared YAML output options. `lineWidth: 0` turns off folding, which would
 * otherwise split a long path across two lines and make the file look broken
 * to anyone reading it.
 */
export const YAML_OUTPUT = { lineWidth: 0 } as const;

/**
 * Writes a manifest with deterministic ordering — repository names and skill
 * coordinates sorted — so that `spm add` produces a small diff instead of
 * shuffling the file. Omits empty sections rather than writing `repositories: {}`.
 */
export function writeManifest(dir: string, manifest: Manifest): void {
  fs.mkdirSync(dir, { recursive: true });

  const out: Record<string, unknown> = {};

  if (manifest.installDirs.length > 0) {
    out["installDirs"] = manifest.installDirs;
  }

  const names = Object.keys(manifest.repositories).sort();
  if (names.length > 0) {
    const repositories: Record<string, unknown> = {};
    for (const name of names) {
      repositories[name] = {
        type: "local",
        path: manifest.repositories[name]!.path,
      };
    }
    out["repositories"] = repositories;
  }

  const aliasNames = Object.keys(manifest.aliases).sort();
  if (aliasNames.length > 0) {
    const aliases: Record<string, string> = {};
    for (const name of aliasNames) {
      aliases[name] = manifest.aliases[name]!;
    }
    out["aliases"] = aliases;
  }

  if (manifest.skills.length > 0) {
    out["skills"] = [...manifest.skills].sort((a, b) => a.localeCompare(b));
  }

  fs.writeFileSync(manifestPath(dir), stringifyYaml(out, YAML_OUTPUT), "utf8");
}

/**
 * Adds a skill coordinate, keeping the list free of redundancy.
 *
 * The redundancy worth avoiding is a repository being named both wholesale and
 * piecemeal: `local:mine:*` next to `local:mine:pdf-fill` says nothing extra,
 * and having both makes it unclear which one a reader should edit. So a
 * whole-repository entry subsumes the individual ones, and an individual entry
 * a whole-repository entry already covers is dropped.
 *
 * Subsumption only ever happens between coordinates of the same repository. A
 * `path:` entry names one directory, so it can never stand for another
 * coordinate.
 */
export function addSkillEntry(manifest: Manifest, coordinate: Coordinate): boolean {
  const key = formatCoordinate(coordinate);
  if (manifest.skills.includes(key)) return false;

  const sameSource = (parsed: Coordinate | null): boolean =>
    parsed !== null && repositoryKey(parsed) === repositoryKey(coordinate);

  const covers = manifest.skills.some((entry) => {
    const parsed = tryParseCoordinate(entry);
    return parsed !== null && sameSource(parsed) && namesWholeRepository(parsed);
  });

  if (!namesWholeRepository(coordinate) && covers) {
    return false; // Already covered by the whole-repository entry.
  }

  if (namesWholeRepository(coordinate)) {
    manifest.skills = manifest.skills.filter(
      (entry) => !sameSource(tryParseCoordinate(entry)),
    );
  }

  manifest.skills.push(key);
  return true;
}

/** Removes every entry identical to `coordinate`. Returns true on a removal. */
export function removeSkillEntry(manifest: Manifest, coordinate: Coordinate): boolean {
  const key = formatCoordinate(coordinate);
  return removeSkillEntries(manifest, (entry) => entry === key) > 0;
}

/** Removes every entry `match` accepts. Returns how many went. */
export function removeSkillEntries(
  manifest: Manifest,
  match: (entry: string) => boolean,
): number {
  const before = manifest.skills.length;
  manifest.skills = manifest.skills.filter((entry) => !match(entry));
  return before - manifest.skills.length;
}

/** Registers a local repository declaration, reporting whether it changed. */
export function upsertRepository(
  manifest: Manifest,
  name: string,
  decl: LocalRepositoryDecl,
): boolean {
  const existing = manifest.repositories[name];
  if (existing && existing.path === decl.path && existing.type === decl.type) {
    return false;
  }
  manifest.repositories[name] = decl;
  return true;
}

/** Registers an alias, reporting whether it changed. */
export function upsertAlias(manifest: Manifest, name: string, target: string): boolean {
  if (manifest.aliases[name] === target) return false;
  manifest.aliases[name] = target;
  return true;
}
