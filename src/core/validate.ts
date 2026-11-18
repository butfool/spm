import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SpmError } from "../errors.js";
import { validSkillName } from "./discover.js";

/**
 * Field-length limits from the agentskills.io specification. The body limit is
 * a best practice from the same spec rather than a hard requirement, so it
 * reports a warning.
 */
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;
const MAX_COMPATIBILITY_LEN = 500;
const MAX_BODY_LINES = 500;

/** `error` fails the run; `warning` is a recommendation that still passes. */
export type DiagnosticLevel = "error" | "warning";

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Frontmatter field the finding belongs to, when it has one. */
  field?: string | undefined;
  message: string;
  /** Concrete remedy, printed as a second line. */
  fix?: string | undefined;
}

export interface ValidationResult {
  valid: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface FileValidation {
  filePath: string;
  result: ValidationResult;
}

/**
 * Frontmatter field names the ecosystem uses, covering the camelCase,
 * kebab-case and snake_case spellings clients accept. A name outside this set
 * is reported as a warning: it parses, but no client is known to read it.
 */
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "argument-hint",
  "argument_hint",
  "argumentHint",
  "arguments",
  "disable-model-invocation",
  "disable_model_invocation",
  "disableModelInvocation",
  "user-invocable",
  "user_invocable",
  "userInvocable",
  "allowed-tools",
  "allowed_tools",
  "allowedTools",
  "disallowed-tools",
  "disallowed_tools",
  "disallowedTools",
  "model",
  "effort",
  "context",
  "agent",
  "hooks",
  "paths",
  "shell",
  "when-to-use",
  "when_to_use",
  "whenToUse",
  // Internal bookkeeping fields.
  "id",
  "metadata",
  "tags",
  // Common third-party / ecosystem fields.
  "license",
  "version",
  "version_note",
  "dependencies",
  "base",
  "Base",
  "type",
  "compatibility",
]);

const VALID_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_SHELL = new Set(["bash", "powershell"]);

/** Directories that never contain a skill worth linting. */
const WALK_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".cache",
  "dist",
  "build",
  ".build",
  "__pycache__",
]);

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESCRIPTION_LINE = /^\s*description:\s*(.+)$/;
/** Portable names: lowercase letters, digits and hyphens only. */
const SPEC_NAME = /^[a-z0-9-]+$/;
/** XML/HTML-like tags, which the spec forbids in a description value. */
const XML_TAG = /<\/?[a-zA-Z]/;
/** Markdown inline link target: `[text](target)`. */
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/;

/**
 * Splits a document into its frontmatter YAML text and body.
 *
 * Tolerates leading blank lines and CRLF endings, matching the parser used by
 * discovery so a file that installs also lints the same way. Returns null when
 * there is no closed frontmatter block.
 */
function splitFrontmatter(
  raw: string,
): { yamlText: string; body: string } | null {
  const trimmed = raw.replace(/^[\r\n]+/, "");
  if (!trimmed.startsWith("---")) return null;

  let rest = trimmed.slice(3);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);

  const closeIdx = rest.indexOf("\n---");
  if (closeIdx < 0) return null;

  const yamlText = rest.slice(0, closeIdx);
  let body = rest.slice(closeIdx + 4);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { yamlText, body };
}

/** Parses frontmatter into a plain map, or an empty map when it cannot. */
function frontmatterMap(raw: string): Record<string, unknown> {
  const split = splitFrontmatter(raw);
  if (split === null) return {};
  try {
    const parsed: unknown = parseYaml(split.yamlText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Reads one field, trying each accepted spelling in order.
 *
 * Scalars are stringified the way YAML would write them, so a list-valued
 * field still reaches the length and tag checks instead of silently vanishing.
 */
function fieldText(
  map: Record<string, unknown>,
  keys: readonly string[],
): string {
  let value: unknown;
  let found = false;
  for (const key of keys) {
    if (key in map) {
      value = map[key];
      found = true;
      break;
    }
  }
  if (!found || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return stringifyYaml(value).trim();
  } catch {
    return "";
  }
}

/** Character count, so limits are measured in code points. */
function charCount(text: string): number {
  return [...text].length;
}

/**
 * Reports the YAML pitfall where an unquoted description contains a colon: the
 * value becomes a nested mapping, so `description` reads as empty.
 */
export function detectUnquotedColonInDescription(frontmatterRaw: string): boolean {
  for (const line of frontmatterRaw.split("\n")) {
    const match = DESCRIPTION_LINE.exec(line);
    if (match === null) continue;
    const value = (match[1] ?? "").trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) continue;
    if (value.includes(": ")) return true;
  }
  return false;
}

/** Applies the agentskills.io name rules on top of the filesystem-safe check. */
export function validateName(name: string): Diagnostic[] {
  const out: Diagnostic[] = [];

  if (!validSkillName(name)) {
    return [
      {
        level: "error",
        field: "name",
        message: `Invalid skill name "${name}" — must contain only lowercase letters, digits, '.', '_' or '-'`,
      },
    ];
  }

  if (charCount(name) > MAX_NAME_LEN) {
    out.push({
      level: "error",
      field: "name",
      message: `Skill name is ${charCount(name)} characters — the agentskills.io spec allows at most ${MAX_NAME_LEN}`,
    });
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    out.push({
      level: "error",
      field: "name",
      message: `Skill name "${name}" must not start or end with a hyphen`,
    });
  }
  if (name.includes("--")) {
    out.push({
      level: "error",
      field: "name",
      message: `Skill name "${name}" must not contain consecutive hyphens`,
    });
  }
  const lower = name.toLowerCase();
  if (lower.includes("anthropic") || lower.includes("claude")) {
    out.push({
      level: "error",
      field: "name",
      message: `Skill name "${name}" contains a reserved word (anthropic/claude)`,
    });
  }
  if (!SPEC_NAME.test(name)) {
    out.push({
      level: "warning",
      field: "name",
      message: `Skill name "${name}" uses '.' or '_' — portable agentskills.io names allow only lowercase letters, digits and hyphens`,
      fix: "Rename using hyphens only, e.g. my-skill",
    });
  }
  return out;
}

/** Applies the agentskills.io description rules. */
export function validateDescription(description: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (charCount(description) > MAX_DESCRIPTION_LEN) {
    out.push({
      level: "error",
      field: "description",
      message: `Description is ${charCount(description)} characters — the agentskills.io spec allows at most ${MAX_DESCRIPTION_LEN}`,
    });
  }
  if (XML_TAG.test(description)) {
    out.push({
      level: "error",
      field: "description",
      message: "Description must not contain XML/HTML tags",
    });
  }
  return out;
}

/**
 * Lints the text of one SKILL.md: frontmatter shape, required fields, field
 * limits, and body size. Findings that need the file's location on disk are
 * added by `validateFile`.
 */
export function validateContent(raw: string): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const result = (): ValidationResult => ({
    valid: errors.length === 0,
    errors,
    warnings,
  });

  const block = FRONTMATTER_BLOCK.exec(raw);
  if (block === null) {
    errors.push({
      level: "error",
      message:
        "No YAML frontmatter found. SKILL.md must start with a --- delimited YAML block.",
      fix: "Add frontmatter:\n---\nname: my-skill\ndescription: What this skill does\n---",
    });
    return result();
  }
  const frontmatterRaw = block[1] ?? "";

  if (detectUnquotedColonInDescription(frontmatterRaw)) {
    errors.push({
      level: "error",
      field: "description",
      message:
        "Description value contains an unquoted colon — YAML interprets this as a nested mapping.",
      fix: 'Wrap the description value in double quotes: description: "..."',
    });
  }

  let parsed: Record<string, unknown> | null = null;
  let yamlFailed = false;
  try {
    const value: unknown = parseYaml(frontmatterRaw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      yamlFailed = true;
      errors.push({
        level: "error",
        message: "YAML parse error: frontmatter is not a mapping",
      });
    } else {
      parsed = value as Record<string, unknown>;
    }
  } catch (err) {
    yamlFailed = true;
    errors.push({
      level: "error",
      message: `YAML parse error: ${(err as Error).message}`,
    });
  }

  if (parsed !== null) {
    for (const key of Object.keys(parsed).sort()) {
      if (!KNOWN_FIELDS.has(key)) {
        warnings.push({
          level: "warning",
          field: key,
          message: `Unknown field "${key}" — not a recognised Claude Code skill field`,
        });
      }
    }

    const compatibility = fieldText(parsed, ["compatibility"]);
    if (charCount(compatibility) > MAX_COMPATIBILITY_LEN) {
      errors.push({
        level: "error",
        field: "compatibility",
        message: `compatibility is ${charCount(compatibility)} characters — the agentskills.io spec allows at most ${MAX_COMPATIBILITY_LEN}`,
      });
    }
  }

  // Field rules run on the tolerant parse, so a leading blank line or stray
  // YAML quirk does not hide the rest of the checks.
  if (!yamlFailed) {
    const fields = frontmatterMap(raw);

    const name = fieldText(fields, ["name"]).trim();
    if (name === "") {
      errors.push({
        level: "error",
        field: "name",
        message: "Missing required field: name",
      });
    } else {
      for (const diagnostic of validateName(name)) {
        push(errors, warnings, diagnostic);
      }
    }

    const description = fieldText(fields, ["description"]).trim();
    if (description === "") {
      errors.push({
        level: "error",
        field: "description",
        message: "Missing required field: description",
      });
    } else {
      for (const diagnostic of validateDescription(description)) {
        push(errors, warnings, diagnostic);
      }
    }

    const effort = fieldText(fields, ["effort"]).trim();
    if (effort !== "" && !VALID_EFFORT.has(effort)) {
      errors.push({
        level: "error",
        field: "effort",
        message: `Invalid effort value "${effort}" — must be one of: low, medium, high, xhigh, max`,
        fix: "Set effort to one of: low, medium, high, xhigh, max",
      });
    }

    const shell = fieldText(fields, ["shell"]).trim();
    if (shell !== "" && !VALID_SHELL.has(shell)) {
      errors.push({
        level: "error",
        field: "shell",
        message: `Invalid shell value "${shell}" — must be one of: bash, powershell`,
        fix: 'Set shell to either "bash" or "powershell"',
      });
    }

    const whenToUse = fieldText(fields, [
      "when-to-use",
      "when_to_use",
      "whenToUse",
    ]).trim();
    if (whenToUse === "") {
      warnings.push({
        level: "warning",
        field: "when_to_use",
        message:
          "Missing recommended field: when_to_use — helps the agent decide when to trigger this skill",
      });
    }

    const body = splitFrontmatter(raw)?.body ?? raw;
    if (body.trim() === "") {
      warnings.push({
        level: "warning",
        field: "body",
        message:
          "Skill body is empty — add instructions describing what the skill does",
      });
    } else {
      const lines = body.split("\n").length - 1;
      if (lines > MAX_BODY_LINES) {
        warnings.push({
          level: "warning",
          field: "body",
          message: `Skill body is ~${lines} lines — best practice keeps SKILL.md under ${MAX_BODY_LINES} lines; move detail into references/`,
        });
      }
    }
  }

  return result();
}

function push(
  errors: Diagnostic[],
  warnings: Diagnostic[],
  diagnostic: Diagnostic,
): void {
  if (diagnostic.level === "error") errors.push(diagnostic);
  else warnings.push(diagnostic);
}

/**
 * Adds the findings that need the file's location: whether `name` matches the
 * directory, and whether relative links in the body point at real files.
 */
function appendPathChecks(
  result: ValidationResult,
  raw: string,
  filePath: string,
): void {
  const fields = frontmatterMap(raw);
  const dir = path.dirname(filePath);

  const name = fieldText(fields, ["name"]).trim();
  const dirName = path.basename(dir);
  if (name !== "" && dirName !== "" && dirName !== "." && dirName !== name) {
    result.warnings.push({
      level: "warning",
      field: "name",
      message: `name "${name}" does not match parent directory "${dirName}" — some clients require them to be identical`,
      fix: `Rename the directory to "${name}", or set name to "${dirName}"`,
    });
  }

  const body = splitFrontmatter(raw)?.body ?? "";
  for (const ref of referencedFiles(body)) {
    if (!fs.existsSync(path.join(dir, ref))) {
      result.warnings.push({
        level: "warning",
        field: "body",
        message: `Referenced file "${ref}" not found relative to the skill directory`,
      });
    }
  }
}

/**
 * Relative link targets in a body, skipping fenced code, external URLs,
 * anchors and absolute paths.
 */
export function referencedFiles(body: string): string[] {
  const out: string[] = [];
  let inFence = false;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const match of line.matchAll(new RegExp(MD_LINK, "g"))) {
      let target = (match[1] ?? "").trim().replace(/^<|>$/g, "");
      if (target === "" || target.startsWith("#")) continue;
      if (target.includes("://") || target.startsWith("mailto:")) continue;
      if (path.isAbsolute(target) || target.startsWith("/")) continue;
      const anchor = target.indexOf("#");
      if (anchor >= 0) target = target.slice(0, anchor);
      if (target === "") continue;
      out.push(target);
    }
  }
  return out;
}

/** Lints one SKILL.md file. Throws when the file cannot be read. */
export function validateFile(filePath: string): ValidationResult {
  const raw = fs.readFileSync(filePath, "utf8");
  const result = validateContent(raw);
  appendPathChecks(result, raw, filePath);
  result.valid = result.errors.length === 0;
  return result;
}

/**
 * Lints a SKILL.md file, or every SKILL.md beneath a directory.
 *
 * Directories are walked in sorted order so the report is stable between runs.
 */
export function validatePath(target: string): FileValidation[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new SpmError(`cannot read ${target}`);
  }

  if (stat.isFile()) {
    return [{ filePath: path.resolve(target), result: validateFile(target) }];
  }

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(full);
      }
    }
  };
  walk(target);
  files.sort();

  if (files.length === 0) {
    throw new SpmError(`no SKILL.md found under ${target}`);
  }

  return files.map((filePath) => ({
    filePath,
    result: validateFile(filePath),
  }));
}
