import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSkills,
  isExcluded,
  parseFrontmatter,
  validSkillName,
} from "../src/core/discover.js";
import { clearHome, tmpdir, writeSkill } from "./helpers.js";

afterEach(clearHome);

describe("parseFrontmatter", () => {
  it("splits frontmatter from body", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: x\ndescription: y\n---\n\n# Body\n");
    expect(frontmatter).toEqual({ name: "x", description: "y" });
    expect(body.trim()).toBe("# Body");
  });

  it("handles CRLF line endings", () => {
    const { frontmatter } = parseFrontmatter("---\r\nname: x\r\ndescription: y\r\n---\r\nbody");
    expect(frontmatter["name"]).toBe("x");
  });

  it("treats a document with no frontmatter as all body", () => {
    const { frontmatter, body } = parseFrontmatter("# Just markdown\n");
    expect(frontmatter).toEqual({});
    expect(body).toBe("# Just markdown\n");
  });

  it("treats an unterminated frontmatter block as body", () => {
    const { frontmatter } = parseFrontmatter("---\nname: x\n");
    expect(frontmatter).toEqual({});
  });

  it("survives malformed YAML without throwing", () => {
    const { frontmatter } = parseFrontmatter("---\n\tname: [unclosed\n---\nbody");
    expect(frontmatter).toEqual({});
  });
});

describe("validSkillName", () => {
  it("accepts the documented character set", () => {
    for (const name of ["alpha", "my-skill", "a.b_c", "skill2"]) {
      expect(validSkillName(name), name).toBe(true);
    }
  });

  it("rejects anything that would be unsafe as a path segment", () => {
    for (const name of ["Alpha", "a/b", "a b", "", "..", ".", ".hidden"]) {
      expect(validSkillName(name), name).toBe(false);
    }
  });
});

describe("isExcluded", () => {
  it("matches whole segments only", () => {
    expect(isExcluded("drafts", ["drafts"])).toBe(true);
    expect(isExcluded("drafts/one", ["drafts"])).toBe(true);
    expect(isExcluded("drafts-old", ["drafts"])).toBe(false);
    expect(isExcluded("src/drafts", ["drafts"])).toBe(false);
  });
});

describe("discoverSkills", () => {
  it("stops descending once a directory holds a SKILL.md", () => {
    const root = tmpdir("spm-disc");
    writeSkill(root, "alpha", "alpha");
    // A skill's own subdirectories are content, not skills.
    fs.mkdirSync(path.join(root, "alpha", "references"), { recursive: true });
    fs.writeFileSync(path.join(root, "alpha", "references", "SKILL.md"), "---\nname: nested\ndescription: x\n---\n");

    const names = discoverSkills(root).map((s) => s.name);
    expect(names).toEqual(["alpha"]);
  });

  it("honours exclude prefixes from the repository manifest", () => {
    const root = tmpdir("spm-disc");
    writeSkill(root, "alpha", "alpha");
    writeSkill(root, "drafts/gamma", "gamma");
    writeSkill(root, "archive/old", "old");

    const names = discoverSkills(root, { exclude: ["drafts", "archive"] }).map((s) => s.name);
    expect(names).toEqual(["alpha"]);
  });

  it("skips version-control and dependency directories", () => {
    const root = tmpdir("spm-disc");
    writeSkill(root, "alpha", "alpha");
    writeSkill(root, ".git/sneaky", "sneaky");
    writeSkill(root, "node_modules/dep", "dep");

    expect(discoverSkills(root).map((s) => s.name)).toEqual(["alpha"]);
  });

  it("records the path relative to the source root", () => {
    const root = tmpdir("spm-disc");
    writeSkill(root, "alpha", "alpha");
    writeSkill(root, "nested/beta", "beta");

    const byName = Object.fromEntries(discoverSkills(root).map((s) => [s.name, s.relativePath]));
    expect(byName).toEqual({ alpha: "alpha", beta: "nested/beta" });
  });

  it("reports a directory whose SKILL.md is unusable", () => {
    const root = tmpdir("spm-disc");
    writeSkill(root, "good", "good");
    fs.mkdirSync(path.join(root, "bad"), { recursive: true });
    fs.writeFileSync(path.join(root, "bad", "SKILL.md"), "---\nname: NO_UPPER\ndescription: x\n---\n");

    const invalid: string[] = [];
    const found = discoverSkills(root, { onInvalid: (file) => invalid.push(file) });

    expect(found.map((s) => s.name)).toEqual(["good"]);
    expect(invalid).toHaveLength(1);
  });

  it("stops at maxDepth", () => {
    const root = tmpdir("spm-disc");
    writeSkill(root, "a/b/c/deep", "deep");

    expect(discoverSkills(root, { maxDepth: 1 })).toHaveLength(0);
    expect(discoverSkills(root, { maxDepth: 5 }).map((s) => s.name)).toEqual(["deep"]);
  });

  it("falls back to the opening paragraph when description is missing", () => {
    const root = tmpdir("spm-disc");
    const dir = path.join(root, "tacit");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: tacit\n---\n\nDoes the thing.\n\nMore.\n");

    const [skill] = discoverSkills(root);
    expect(skill?.description).toBe("Does the thing.");
  });
});
