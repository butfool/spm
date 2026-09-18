import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { SpmError } from "../errors.js";

/** Manifest filename, both for projects and for the global scope. */
export const MANIFEST_FILENAME = "skills.yaml";

/**
 * Where a source lives. Exactly one of `path` (local directory) or `repo`
 * (github `owner/name`) identifies it; `ref` only applies to github.
 */
export const SourceDeclSchema = z
  .object({
    path: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
  })
  .refine((d) => (d.path === undefined) !== (d.repo === undefined), {
    message: "a source needs exactly one of `path` or `repo`",
  });

export type SourceDecl = z.infer<typeof SourceDeclSchema>;

/**
 * A dependency entry. The string form is shorthand for the common cases
 * (`alias/skill`, `alias/*`, `./path`, `owner/repo`); the object form is the
 * explicit version, used when a skill must come from an ad-hoc location that
 * isn't worth registering as a named source.
 */
export const SkillEntrySchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    /** Narrow the entry to one skill instead of the whole source. */
    skill: z.string().min(1).optional(),
  }),
]);

export type SkillEntry = z.infer<typeof SkillEntrySchema>;

export const ManifestSchema = z.object({
  /**
   * Where declared skills get linked. Empty means "inherit settings.yaml",
   * then the built-in default. Relative entries resolve against this
   * manifest's directory.
   */
  installDirs: z.array(z.string().min(1)).default([]),
  /** Named sources, so a fresh checkout can bootstrap without `source add`. */
  sources: z.record(z.string(), SourceDeclSchema).default({}),
  /** The declared skills. */
  skills: z.array(SkillEntrySchema).default([]),
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
    throw new SpmError(
      `${file} is not valid YAML: ${(err as Error).message}`,
    );
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new SpmError(
      `${file} is invalid: ${z.prettifyError(result.error)}`,
      `Run \`spm init\` to start from a clean manifest.`,
    );
  }
  return result.data;
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
 * Writes a manifest with deterministic ordering — aliases and skill entries
 * sorted — so that `spm add` produces a small diff instead of shuffling the
 * file. Omits empty sections rather than writing `sources: {}`.
 */
export function writeManifest(dir: string, manifest: Manifest): void {
  fs.mkdirSync(dir, { recursive: true });

  const out: Record<string, unknown> = {};

  if (manifest.installDirs.length > 0) {
    out["installDirs"] = manifest.installDirs;
  }

  const aliases = Object.keys(manifest.sources).sort();
  if (aliases.length > 0) {
    const sources: Record<string, unknown> = {};
    for (const alias of aliases) {
      const decl = manifest.sources[alias]!;
      const entry: Record<string, unknown> = {};
      if (decl.path !== undefined) entry["path"] = decl.path;
      if (decl.repo !== undefined) entry["repo"] = decl.repo;
      if (decl.ref !== undefined) entry["ref"] = decl.ref;
      sources[alias] = entry;
    }
    out["sources"] = sources;
  }

  if (manifest.skills.length > 0) {
    out["skills"] = [...manifest.skills]
      .map(normaliseEntry)
      .sort((a, b) => entrySortKey(a).localeCompare(entrySortKey(b)));
  }

  fs.writeFileSync(manifestPath(dir), stringifyYaml(out), "utf8");
}

/** Drops keys left undefined so YAML doesn't emit `ref: undefined`. */
function normaliseEntry(entry: SkillEntry): SkillEntry {
  if (typeof entry === "string") return entry;
  const out: Record<string, unknown> = {};
  if (entry.repo !== undefined) out["repo"] = entry.repo;
  if (entry.path !== undefined) out["path"] = entry.path;
  if (entry.ref !== undefined) out["ref"] = entry.ref;
  if (entry.skill !== undefined) out["skill"] = entry.skill;
  return out as SkillEntry;
}

function entrySortKey(entry: SkillEntry): string {
  if (typeof entry === "string") return entry;
  return entry.repo ?? entry.path ?? "";
}

/** The canonical string form of an entry, used for dedup and display. */
export function entryToString(entry: SkillEntry): string {
  if (typeof entry === "string") return entry;
  const base = entry.repo ?? entry.path ?? "";
  const withRef =
    entry.ref !== undefined && entry.repo !== undefined
      ? `${base}#${entry.ref}`
      : base;
  return entry.skill !== undefined ? `${withRef}:${entry.skill}` : withRef;
}

/**
 * Identifies the source an entry draws from. Two entries with the same source
 * key draw from the same repository, whatever form they're written in.
 */
export function entrySourceKey(entry: SkillEntry): string {
  if (typeof entry === "string") {
    const slash = entry.indexOf("/");
    return slash === -1 ? `bare:${entry}` : `alias:${entry.slice(0, slash)}`;
  }
  if (entry.repo !== undefined) {
    return entry.ref !== undefined ? `repo:${entry.repo}#${entry.ref}` : `repo:${entry.repo}`;
  }
  if (entry.path !== undefined) return `path:${path.resolve(entry.path)}`;
  return "";
}

/** The skill an entry names, or "*" when it covers the whole source. */
export function entrySkill(entry: SkillEntry): string {
  if (typeof entry === "string") {
    const slash = entry.indexOf("/");
    return slash === -1 ? entry : entry.slice(slash + 1);
  }
  return entry.skill ?? "*";
}

/**
 * Adds a skill entry, keeping the list free of redundancy.
 *
 * The redundancy worth avoiding is a source being named both wholesale and
 * piecemeal: `fixture-repo/*` next to `fixture-repo/alpha` says nothing extra,
 * and having both makes it unclear which one a reader should edit. So a
 * whole-source entry subsumes the individual ones, and an individual entry
 * that a wholesale one already covers is dropped.
 */
export function addSkillEntry(manifest: Manifest, entry: SkillEntry): boolean {
  const key = entryToString(entry);
  if (manifest.skills.some((existing) => entryToString(existing) === key)) {
    return false;
  }

  const source = entrySourceKey(entry);
  const skill = entrySkill(entry);

  if (
    skill !== "*" &&
    manifest.skills.some((e) => entrySourceKey(e) === source && entrySkill(e) === "*")
  ) {
    return false; // Already covered by the whole-source entry.
  }

  if (skill === "*") {
    manifest.skills = manifest.skills.filter((e) => entrySourceKey(e) !== source);
  }

  manifest.skills.push(entry);
  return true;
}

/** Removes every entry matching `key`. Returns true when something was removed. */
export function removeSkillEntry(manifest: Manifest, key: string): boolean {
  const before = manifest.skills.length;
  manifest.skills = manifest.skills.filter((e) => entryToString(e) !== key);
  return manifest.skills.length !== before;
}

/** Registers a source declaration, reporting whether it changed anything. */
export function upsertSource(
  manifest: Manifest,
  alias: string,
  decl: SourceDecl,
): boolean {
  const existing = manifest.sources[alias];
  if (
    existing &&
    existing.path === decl.path &&
    existing.repo === decl.repo &&
    existing.ref === decl.ref
  ) {
    return false;
  }
  manifest.sources[alias] = decl;
  return true;
}
