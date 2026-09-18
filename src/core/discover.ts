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
  /** Called for each SKILL.md that exists but fails validation. */
  onInvalid?: (skillFile: string, reason: string) => void;
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

/**
 * Parses one SKILL.md into a DiscoveredSkill.
 *
 * Returns null when the file exists but is not a usable skill (no name, no
 * description, or an unsafe name) — the caller decides whether that's worth
 * reporting. Throws only when the frontmatter YAML itself is malformed or the
 * file is unreadable.
 */
export function parseSkillMd(
  skillFile: string,
  sourceRoot?: string,
): DiscoveredSkill | null {
  const content = fs.readFileSync(skillFile, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);

  const name = typeof frontmatter["name"] === "string" ? frontmatter["name"] : "";
  if (name === "" || !validSkillName(name)) return null;

  let description =
    typeof frontmatter["description"] === "string"
      ? frontmatter["description"].trim()
      : "";
  if (description === "") {
    // Fall back to the opening paragraph so a terse SKILL.md still lists.
    const first = body.trim().split(/\n\s*\n/, 1)[0]?.trim() ?? "";
    if (first !== "") description = first.slice(0, 250);
  }
  if (description === "") return null;

  const dir = path.dirname(skillFile);
  const root = sourceRoot ?? dir;

  return {
    name,
    description,
    dir,
    skillFile,
    relativePath: toPosix(path.relative(root, dir)),
    frontmatter,
  };
}

/**
 * Walks `rootDir` and returns every skill it contains.
 *
 * The traversal rule that matters: a directory containing SKILL.md is itself a
 * skill, and we do not descend into it. Skills are leaves, not containers —
 * this is what keeps a skill's own `references/` or `scripts/` subdirectories
 * from being mistaken for skills.
 */
export function discoverSkills(
  rootDir: string,
  opts: DiscoverOptions = {},
): DiscoveredSkill[] {
  const root = path.resolve(rootDir);
  const exclude = (opts.exclude ?? []).map(toPosix);
  const maxDepth = opts.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;

  const found: DiscoveredSkill[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;

    const skillFile = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      try {
        const skill = parseSkillMd(skillFile, root);
        if (skill) found.push(skill);
        else opts.onInvalid?.(skillFile, "missing or invalid name/description");
      } catch (err) {
        opts.onInvalid?.(skillFile, (err as Error).message);
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
  return found;
}

/** Looks up a single skill by name within a source root. */
export function findSkill(
  rootDir: string,
  name: string,
  opts: DiscoverOptions = {},
): DiscoveredSkill | undefined {
  return discoverSkills(rootDir, opts).find((s) => s.name === name);
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
