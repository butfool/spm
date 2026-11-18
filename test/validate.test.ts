import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/index.js";
import {
  detectUnquotedColonInDescription,
  referencedFiles,
  validateContent,
  validatePath,
} from "../src/core/validate.js";
import { SpmError } from "../src/errors.js";
import { clearHome, tmpdir, useTempHome, writeSkillFile } from "./helpers.js";

const MINIMAL = "---\nname: demo\ndescription: Does a thing.\nwhen_to_use: when testing\n---\n\n# Demo\n";

function skill(overrides: {
  name?: string;
  description?: string;
  extra?: string;
  body?: string;
}): string {
  const name = overrides.name ?? "demo";
  const description = overrides.description ?? "Does a thing.";
  const extra = overrides.extra ?? "when_to_use: when testing\n";
  const body = overrides.body ?? "# Demo\n";
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`;
}

function messages(items: { message: string }[]): string[] {
  return items.map((item) => item.message);
}

describe("validateContent", () => {
  it("accepts a complete SKILL.md", () => {
    const result = validateContent(MINIMAL);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a document without frontmatter", () => {
    const result = validateContent("# no frontmatter\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("No YAML frontmatter found");
    expect(result.errors[0]?.fix).toContain("name: my-skill");
  });

  it("reports broken YAML instead of the missing-name symptom", () => {
    const result = validateContent("---\nname: [unclosed\ndescription: x\n---\n\nbody\n");
    expect(messages(result.errors).some((m) => m.startsWith("YAML parse error"))).toBe(true);
  });

  it("reports an unquoted colon in description", () => {
    const raw = '---\nname: demo\ndescription: Use this: it helps\nwhen_to_use: x\n---\n\nbody\n';
    expect(detectUnquotedColonInDescription("name: demo\ndescription: Use this: it helps")).toBe(true);
    const result = validateContent(raw);
    expect(messages(result.errors)).toContain(
      "Description value contains an unquoted colon — YAML interprets this as a nested mapping.",
    );
  });

  it("skips the colon check for a quoted description", () => {
    expect(detectUnquotedColonInDescription('description: "Use this: it helps"')).toBe(false);
    expect(detectUnquotedColonInDescription("description: 'Use this: it helps'")).toBe(false);
  });

  it("requires name and description", () => {
    const result = validateContent("---\ndescription: x\nwhen_to_use: y\n---\n\nbody\n");
    expect(messages(result.errors)).toContain("Missing required field: name");
    expect(result.warnings.map((w) => w.field)).not.toContain("name");
  });

  it("applies every name rule", () => {
    const tooLong = "a".repeat(65);
    expect(messages(validateContent(skill({ name: tooLong })).errors)).toContain(
      "Skill name is 65 characters — the agentskills.io spec allows at most 64",
    );
    expect(messages(validateContent(skill({ name: "-demo" })).errors)).toContain(
      'Skill name "-demo" must not start or end with a hyphen',
    );
    expect(messages(validateContent(skill({ name: "de--mo" })).errors)).toContain(
      'Skill name "de--mo" must not contain consecutive hyphens',
    );
    expect(messages(validateContent(skill({ name: "claude-helper" })).errors)).toContain(
      'Skill name "claude-helper" contains a reserved word (anthropic/claude)',
    );
    expect(messages(validateContent(skill({ name: "BadName" })).errors)).toContain(
      'Invalid skill name "BadName" — must contain only lowercase letters, digits, \'.\', \'_\' or \'-\'',
    );
    expect(messages(validateContent(skill({ name: "my_skill" })).warnings)).toContain(
      'Skill name "my_skill" uses \'.\' or \'_\' — portable agentskills.io names allow only lowercase letters, digits and hyphens',
    );
  });

  it("applies description limits", () => {
    const long = validateContent(skill({ description: "d".repeat(1025) }));
    expect(messages(long.errors)).toContain(
      "Description is 1025 characters — the agentskills.io spec allows at most 1024",
    );
    const tagged = validateContent(skill({ description: "<b>bold</b>" }));
    expect(messages(tagged.errors)).toContain("Description must not contain XML/HTML tags");
  });

  it("checks effort and shell enums", () => {
    const result = validateContent(skill({ extra: "effort: extreme\nshell: fish\n" }));
    expect(messages(result.errors)).toEqual(
      expect.arrayContaining([
        'Invalid effort value "extreme" — must be one of: low, medium, high, xhigh, max',
        'Invalid shell value "fish" — must be one of: bash, powershell',
      ]),
    );
  });

  it("warns about unknown fields in sorted order", () => {
    const result = validateContent(skill({ extra: "zeta: 1\nalpha: 2\n" }));
    expect(result.warnings.map((w) => w.field)).toEqual(["alpha", "zeta", "when_to_use"]);
  });

  it("checks compatibility length", () => {
    const result = validateContent(skill({ extra: `compatibility: ${"c".repeat(501)}\n` }));
    expect(messages(result.errors)).toContain(
      "compatibility is 501 characters — the agentskills.io spec allows at most 500",
    );
  });

  it("warns about a missing when_to_use and an empty body", () => {
    const result = validateContent("---\nname: demo\ndescription: x\n---\n");
    expect(result.warnings.map((w) => w.field)).toEqual(["when_to_use", "body"]);
  });

  it("warns when the body exceeds 500 lines", () => {
    const body = Array.from({ length: 502 }, (_, i) => `line ${i}`).join("\n");
    const result = validateContent(skill({ body }));
    expect(messages(result.warnings)).toContain(
      "Skill body is ~502 lines — best practice keeps SKILL.md under 500 lines; move detail into references/",
    );
  });
});

describe("referencedFiles", () => {
  it("collects relative links and ignores external, anchor and fenced ones", () => {
    const body = [
      "See [a](references/a.md) and [b](https://example.com/x).",
      "Also [c](#anchor) and [d](/abs/path.md) and [e](mailto:x@y.z).",
      "```",
      "[f](inside-fence.md)",
      "```",
      "[g](references/g.md#section)",
    ].join("\n");
    expect(referencedFiles(body)).toEqual(["references/a.md", "references/g.md"]);
  });
});

describe("validatePath", () => {
  it("warns when the name does not match the directory", () => {
    const root = tmpdir("spm-validate-dir");
    const dir = writeSkillFile(root, "other-name", skill({ name: "demo" }));
    const [file] = validatePath(dir);
    expect(file?.result.warnings.map((w) => w.field)).toContain("name");
    expect(messages(file?.result.warnings ?? [])).toContain(
      'name "demo" does not match parent directory "other-name" — some clients require them to be identical',
    );
  });

  it("warns about missing referenced files and accepts present ones", () => {
    const root = tmpdir("spm-validate-refs");
    const dir = writeSkillFile(
      root,
      "demo",
      skill({ body: "See [refs](references/guide.md) and [more](references/missing.md)\n" }),
    );
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "guide.md"), "# guide\n", "utf8");

    const [file] = validatePath(dir);
    expect(messages(file?.result.warnings ?? [])).toEqual([
      'Referenced file "references/missing.md" not found relative to the skill directory',
    ]);
  });

  it("walks a tree in sorted order and skips vendored directories", () => {
    const root = tmpdir("spm-validate-walk");
    writeSkillFile(root, "b-skill", skill({ name: "b-skill" }));
    writeSkillFile(root, "a-skill", skill({ name: "a-skill" }));
    writeSkillFile(root, "node_modules/pkg", skill({ name: "pkg" }));

    const files = validatePath(root);
    expect(files.map((f) => path.basename(path.dirname(f.filePath)))).toEqual([
      "a-skill",
      "b-skill",
    ]);
  });

  it("fails when a directory holds no SKILL.md", () => {
    const empty = tmpdir("spm-validate-empty");
    expect(() => validatePath(empty)).toThrow(SpmError);
    expect(() => validatePath(path.join(empty, "missing"))).toThrow(SpmError);
  });
});

describe("validate command", () => {
  let previousCwd: string;

  beforeEach(() => {
    useTempHome();
    previousCwd = process.cwd();
    process.chdir(tmpdir("spm-validate-cwd"));
  });

  afterEach(() => {
    process.chdir(previousCwd);
    clearHome();
  });

  it("passes a valid skill and reports warnings without failing", async () => {
    const root = tmpdir("spm-validate-cli-ok");
    writeSkillFile(root, "demo", "---\nname: demo\ndescription: x\n---\n\nbody\n");

    const result = await spm("validate", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Summary: 0 errors, 1 warning across 1 file");
    expect(result.stderr).toContain("Missing recommended field: when_to_use");
  });

  it("exits non-zero when an error is reported", async () => {
    const root = tmpdir("spm-validate-cli-bad");
    writeSkillFile(root, "demo", "# no frontmatter\n");

    const result = await spm("validate", root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No YAML frontmatter found");
    expect(result.stdout).toContain("Summary: 1 error, 0 warnings across 1 file");
  });

  it("emits machine-readable output", async () => {
    const root = tmpdir("spm-validate-cli-json");
    writeSkillFile(root, "demo", "# no frontmatter\n");

    const result = await spm("validate", root, "--json");
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      files: { filePath: string; valid: boolean; errors: { message: string }[] }[];
      totalErrors: number;
      totalWarnings: number;
    };
    expect(parsed.totalErrors).toBe(1);
    expect(parsed.totalWarnings).toBe(0);
    expect(parsed.files[0]?.valid).toBe(false);
    expect(parsed.files[0]?.errors[0]?.message).toContain("No YAML frontmatter found");
  });

  it("lints several targets and de-duplicates overlaps", async () => {
    const root = tmpdir("spm-validate-cli-multi");
    const dir = writeSkillFile(root, "demo", MINIMAL);

    const result = await spm("validate", root, dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("across 1 file");
  });

  it("reports an unreadable target", async () => {
    const result = await spm("validate", path.join(tmpdir("spm-validate-gone"), "nope"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot read");
  });
});

async function spm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk): boolean => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });

  try {
    return { code: await run(["node", "spm", ...args]), stdout: out.join(""), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}
