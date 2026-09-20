import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** Recursion cap when a repository declares no `maxDepth`. */
const DEFAULT_MAX_DEPTH = 5;

/** Directories never worth walking into. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

/**
 * Dot-directories that conventionally hold skills. Everything else hidden
 * (`.git`, `.github`, editor state) is skipped.
 */
const KNOWN_SKILL_DIRS = new Set([
  ".claude",
  ".agents",
  ".cursor",
  ".copilot",
  ".codex",
]);

/** Skill names must be safe as a single path segment. */
const VALID_NAME = /^[a-z0-9._-]+$/;

/**
 * Whether `name` is usable as a skill name.
 *
 * The character set alone isn't enough: a name becomes a path segment under
 * each install directory, so `.`, `..` and anything else starting with a dot
 * is rejected outright. `..` in particular would resolve outside the install
 * directory and let a manifest write links anywhere on disk.
 */
export function validSkillName(name: string): boolean {
  return VALID_NAME.test(name) && !name.startsWith(".");
}

export interface DiscoveredSkill {
  /** `name` from frontmatter. */
  name: string;
  description: string;
  /** Absolute path of the directory containing SKILL.md. */
  dir: string;
  /** Absolute path of SKILL.md itself. */
  skillFile: string;
  /** Path relative to the source root, using forward slashes. */
  relativePath: string;
  /** The full parsed frontmatter, for pass-through display. */
  frontmatter: Record<string, unknown>;
}

export interface DiscoverOptions {
  /** Repo-relative path prefixes to skip. */
  exclude?: string[];
  /** Max recursion depth; 0 means use the default cap. */
  maxDepth?: number;
}

/**
 * A SKILL.md that discovery refused to treat as a skill. The file exists; what
 * makes it unusable is its content or its name.
 */
export interface InvalidSkill {
  /** Absolute path of the SKILL.md itself. */
  skillFile: string;
  /** Path of SKILL.md relative to the source root, using forward slashes. */
  relativePath: string;
  /** Why the file cannot be used, phrased for the person reading it. */
  reason: string;
}

/**
 * An InvalidSkill that knows which source it came from. Every message shown to
 * a user goes through `skippedLine`, so a skipped file reads the same wherever
 * it is reported.
 */
export interface SkippedSkill extends InvalidSkill {
  /** The repository it came from, as `local:name` or `github:owner/repo`. */
  source: string;
}

export interface DiscoveryResult {
  /** The skills found under the root. */
  skills: DiscoveredSkill[];
  /** Every SKILL.md that was skipped, sorted by relative path. */
  invalid: InvalidSkill[];
}

/** Tags one source's skipped files, so a report can name where they live. */
export function skippedFrom(
  source: string,
  invalid: readonly InvalidSkill[],
): SkippedSkill[] {
  return invalid.map((item) => ({ ...item, source }));
}

/** The one-line form every report uses: `<source>/<relativePath>: <reason>`. */
export function skippedLine(item: SkippedSkill): string {
  return `${item.source}/${item.relativePath}: ${item.reason}`;
}

/**
 * Splits a SKILL.md into its YAML frontmatter and body.
 *
 * Tolerates a leading blank line and CRLF endings. A document with no
 * frontmatter yields an empty object plus the whole text as body.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalised = content.replace(/^﻿/, "");
  const trimmedStart = normalised.replace(/^[\r\n]+/, "");

  if (!trimmedStart.startsWith("---")) {
    return { frontmatter: {}, body: normalised };
  }

  // Find the closing delimiter on its own line.
  const afterOpen = trimmedStart.slice(3);
  const match = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(afterOpen);
  if (!match || match.index === undefined) {
    return { frontmatter: {}, body: normalised };
  }

  const yamlText = afterOpen.slice(0, match.index);
  const body = afterOpen.slice(match.index + match[0].length);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText) ?? {};
  } catch {
    return { frontmatter: {}, body: normalised };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { frontmatter: {}, body: normalised };
  }

  return { frontmatter: parsed as Record<string, unknown>, body };
}

/** Either a usable skill, or the reason the file cannot be used. */
export type SkillParse =
  | { ok: true; skill: DiscoveredSkill }
  | { ok: false; reason: string };

/** Why `name` cannot be used as a skill name, or null when it can. */
function nameProblem(name: string): string | null {
  if (name === "") return "missing `name` in frontmatter";
  // Checked before the character set: `.` and `..` are made of legal
  // characters, but either one resolves outside the install directory.
  if (name.startsWith(".")) return `name "${name}" may not start with a dot`;
  if (!validSkillName(name)) {
    return `name "${name}" may only contain lowercase letters, digits, dots, dashes and underscores`;
  }
  return null;
}

/**
 * Parses one SKILL.md into a DiscoveredSkill, or reports why it is unusable.
 *
 * A file that cannot be read is reported the same way as one with unusable
 * frontmatter: discovery keeps walking, and the caller shows every skipped
 * file together with its reason.
 */
export function parseSkillMd(
  skillFile: string,
  sourceRoot?: string,
): SkillParse {
  let content: string;
  try {
    content = fs.readFileSync(skillFile, "utf8");
  } catch (err) {
    return { ok: false, reason: `cannot read SKILL.md: ${(err as Error).message}` };
  }

  const { frontmatter, body } = parseFrontmatter(content);

  const name = typeof frontmatter["name"] === "string" ? frontmatter["name"] : "";
  const badName = nameProblem(name);
  if (badName !== null) return { ok: false, reason: badName };

  let description =
    typeof frontmatter["description"] === "string"
      ? frontmatter["description"].trim()
      : "";
  if (description === "") {
    // Fall back to the opening paragraph so a terse SKILL.md still lists.
    const first = body.trim().split(/\n\s*\n/, 1)[0]?.trim() ?? "";
    if (first !== "") description = first.slice(0, 250);
  }
  if (description === "") {
    return {
      ok: false,
      reason:
        "missing `description` in frontmatter, with no opening paragraph in the body to fall back to",
    };
  }

  const dir = path.dirname(skillFile);
  const root = sourceRoot ?? dir;

  return {
    ok: true,
    skill: {
      name,
      description,
      dir,
      skillFile,
      relativePath: toPosix(path.relative(root, dir)),
      frontmatter,
    },
  };
}

/**
 * Walks `rootDir` and returns every skill it contains, plus every SKILL.md it
 * refused to use and why.
 *
 * The traversal rule that matters: a directory containing SKILL.md is itself a
 * skill, and we do not descend into it. Skills are leaves, not containers —
 * this is what keeps a skill's own `references/` or `scripts/` subdirectories
 * from being mistaken for skills.
 */
export function discoverSkills(
  rootDir: string,
  opts: DiscoverOptions = {},
): DiscoveryResult {
  const root = path.resolve(rootDir);
  const exclude = (opts.exclude ?? []).map(toPosix);
  const maxDepth = opts.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;

  const found: DiscoveredSkill[] = [];
  const invalid: InvalidSkill[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;

    const skillFile = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      const parsed = parseSkillMd(skillFile, root);
      if (parsed.ok) {
        found.push(parsed.skill);
      } else {
        invalid.push({
          skillFile,
          relativePath: toPosix(path.relative(root, skillFile)),
          reason: parsed.reason,
        });
      }
      return; // A skill is a leaf.
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: skip rather than abort the whole walk.
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith(".") && !KNOWN_SKILL_DIRS.has(name)) continue;

      const rel = toPosix(path.relative(root, path.join(dir, name)));
      if (isExcluded(rel, exclude)) continue;
      if (!isDirectorySynced(path.join(dir, name))) continue;

      walk(path.join(dir, name), depth + 1);
    }
  };

  walk(root, 0);
  found.sort((a, b) => a.name.localeCompare(b.name));
  invalid.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { skills: found, invalid };
}

/**
 * A path is excluded when it equals a prefix or sits underneath one. Matching
 * is whole-segment, so excluding `drafts` never also excludes `drafts-old`.
 */
export function isExcluded(relPosix: string, exclude: string[]): boolean {
  for (const prefix of exclude) {
    if (prefix === "") continue;
    if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function isDirectorySynced(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
