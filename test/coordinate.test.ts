import { describe, expect, it } from "vitest";
import {
  formatCoordinate,
  isRepositoryCoordinate,
  namesWholeRepository,
  parseCoordinate,
  readCoordinate,
  repositoryKey,
  tryParseCoordinate,
  validAliasName,
  validPathValue,
  validGithubRepository,
  validRepositoryName,
  validSkillSegment,
} from "../src/core/coordinate.js";
import type { SpmError } from "../src/errors.js";

describe("parseCoordinate", () => {
  it("reads a local coordinate", () => {
    expect(parseCoordinate("local:mine:pdf-fill")).toEqual({
      type: "local",
      repository: "mine",
      skill: "pdf-fill",
    });
  });

  it("reads a github coordinate", () => {
    expect(parseCoordinate("github:anthropics/skills:pdf-fill")).toEqual({
      type: "github",
      repository: "anthropics/skills",
      skill: "pdf-fill",
    });
  });

  it("reads the whole-repository form", () => {
    const coordinate = parseCoordinate("local:mine:*");
    expect(namesWholeRepository(coordinate)).toBe(true);
    expect(coordinate).toMatchObject({ skill: "*" });
  });

  it("reads a path coordinate as one directory, colons and all", () => {
    expect(parseCoordinate("path:/x/skills/pdf")).toEqual({
      type: "path",
      dir: "/x/skills/pdf",
    });
    expect(parseCoordinate("path:~/Code/skills/pdf")).toEqual({
      type: "path",
      dir: "~/Code/skills/pdf",
    });
    // A directory may contain a colon; only the first one separates.
    expect(parseCoordinate("path:/x/odd:name/skill")).toEqual({
      type: "path",
      dir: "/x/odd:name/skill",
    });
  });

  it("rejects a path coordinate that names no single directory", () => {
    expect(readCoordinate("path:").ok).toBe(false);
    expect(readCoordinate("path:*").ok).toBe(false);
    expect(readCoordinate("path:   ").ok).toBe(false);
  });

  it("reads an alias coordinate as one name", () => {
    expect(parseCoordinate("alias:md-lint")).toEqual({ type: "alias", name: "md-lint" });
    expect(parseCoordinate("alias:iWhaleCloud")).toEqual({
      type: "alias",
      name: "iWhaleCloud",
    });
  });

  it("rejects an alias name that could not be a segment", () => {
    // A colon here would make the coordinate ambiguous, unlike a path value,
    // which is allowed to contain one.
    expect(readCoordinate("alias:a:b").ok).toBe(false);
    expect(readCoordinate("alias:").ok).toBe(false);
    expect(readCoordinate("alias:*").ok).toBe(false);
    expect(readCoordinate("alias:a/b").ok).toBe(false);
    for (const reserved of ["local", "github", "path", "alias"]) {
      expect(readCoordinate(`alias:${reserved}`).ok, reserved).toBe(false);
    }
  });

  it("reports how many segments it saw", () => {
    expect(readCoordinate("mine:pdf-fill")).toEqual({
      ok: false,
      reason: "2 segments instead of 3",
    });
    expect(readCoordinate("local:mine")).toEqual({
      ok: false,
      reason: "2 segments instead of 3",
    });
    expect(readCoordinate("mine")).toEqual({
      ok: false,
      reason: "1 segment instead of 3",
    });
    expect(readCoordinate("local:mine:a:b")).toEqual({
      ok: false,
      reason: "4 segments instead of 3",
    });
  });

  it("rejects an unknown type segment", () => {
    expect(readCoordinate("gitlab:mine:pdf-fill")).toEqual({
      ok: false,
      reason: 'unknown coordinate type "gitlab" — expected local, github, path, alias',
    });
  });

  it("rejects a local repository name that is not usable as a path segment", () => {
    for (const name of ["../evil", ".hidden", "has space", "a/b", "local", "github", "path"]) {
      const result = readCoordinate(`local:${name}:pdf-fill`);
      expect(result.ok, name).toBe(false);
    }
  });

  it("rejects a github repository without an owner", () => {
    expect(readCoordinate("github:skills:pdf")).toEqual({
      ok: false,
      reason: '"skills" is not a github repository — expected owner/name',
    });
  });

  it("rejects a skill name that discovery would refuse", () => {
    for (const skill of ["Pdf-Fill", "../x", ""]) {
      expect(readCoordinate(`local:mine:${skill}`).ok, skill).toBe(false);
    }
  });

  it("throws a SpmError whose hint states the expected form", () => {
    let caught: SpmError | null = null;
    try {
      parseCoordinate("mine:pdf");
    } catch (err) {
      caught = err as SpmError;
    }

    expect(caught?.message).toMatch(/not a skill coordinate/);
    expect(caught?.hint).toMatch(/<local\|github>:<repository>:<skill>/);
  });

  it("returns null rather than throwing from the tolerant reader", () => {
    expect(tryParseCoordinate("mine")).toBeNull();
    expect(tryParseCoordinate("local:mine:pdf")).toMatchObject({ skill: "pdf" });
    expect(tryParseCoordinate("path:/x/y")).toMatchObject({ dir: "/x/y" });
  });
});

describe("formatting", () => {
  it("round-trips", () => {
    for (const text of [
      "local:mine:*",
      "local:mine:pdf-fill",
      "github:a/b:c",
      "path:/x/skills/pdf",
      "path:~/Code/skills/pdf",
      "path:../shared/skills/pdf",
      "alias:md-lint",
    ]) {
      expect(formatCoordinate(parseCoordinate(text))).toBe(text);
    }
  });

  it("derives the prefix that groups coordinates by source", () => {
    expect(repositoryKey(parseCoordinate("github:a/b:c"))).toBe("github:a/b");
    expect(repositoryKey(parseCoordinate("local:mine:*"))).toBe("local:mine");
    // A path coordinate is its own source, so the key is the whole coordinate.
    expect(repositoryKey(parseCoordinate("path:/x/y"))).toBe("path:/x/y");
    expect(repositoryKey(parseCoordinate("alias:pdf"))).toBe("alias:pdf");
  });

  it("never treats a path or alias coordinate as a whole repository", () => {
    expect(namesWholeRepository(parseCoordinate("path:/x/y"))).toBe(false);
    expect(namesWholeRepository(parseCoordinate("alias:pdf"))).toBe(false);
    const parsed = parseCoordinate("path:/x/y");
    expect(isRepositoryCoordinate(parsed)).toBe(false);
    expect(isRepositoryCoordinate(parseCoordinate("alias:pdf"))).toBe(false);
    expect(isRepositoryCoordinate(parseCoordinate("local:mine:*"))).toBe(true);
  });
});

describe("name validation", () => {
  it("accepts uppercase local names, which are common in practice", () => {
    expect(validRepositoryName("iWhaleCloud")).toBe(true);
    expect(validRepositoryName("zsm-skills")).toBe(true);
  });

  it("reserves every coordinate type word", () => {
    expect(validRepositoryName("local")).toBe(false);
    expect(validRepositoryName("github")).toBe(false);
    // Otherwise a repository named `path` would shadow the path form.
    expect(validRepositoryName("path")).toBe(false);
    expect(validRepositoryName("alias")).toBe(false);
  });

  it("uses one rule for repository names and alias names", () => {
    for (const name of ["md-lint", "iWhaleCloud", "zsm-skills", "a.b_c"]) {
      expect(validAliasName(name), name).toBe(true);
    }
    for (const name of [".hidden", "a/b", "has space", "", "alias", "path"]) {
      expect(validAliasName(name), name).toBe(false);
    }
  });

  it("accepts only a non-empty directory as a path value", () => {
    expect(validPathValue("/x/y")).toBe(true);
    expect(validPathValue("~/x")).toBe(true);
    expect(validPathValue("../shared/skills/pdf")).toBe(true);
    expect(validPathValue("")).toBe(false);
    expect(validPathValue("   ")).toBe(false);
    expect(validPathValue("*")).toBe(false);
  });

  it("requires owner/name for github", () => {
    expect(validGithubRepository("vercel-labs/agent-skills")).toBe(true);
    expect(validGithubRepository("agent-skills")).toBe(false);
    expect(validGithubRepository("a/b/c")).toBe(false);
  });

  it("refuses a github name whose segments would escape the source cache", () => {
    // Each segment becomes a directory under the cache, so `.` and `..` would
    // address a directory outside it.
    for (const repo of ["../..", "owner/..", "../local", "./x", "owner/."]) {
      expect(validGithubRepository(repo), repo).toBe(false);
    }
    expect(readCoordinate("github:../..:*")).toEqual({
      ok: false,
      reason: '"../.." is not a github repository — expected owner/name',
    });
  });

  it("accepts a dot-prefixed segment that is not a traversal", () => {
    expect(validGithubRepository("owner/.github")).toBe(true);
  });

  it("accepts a star only as the whole-repository skill", () => {
    expect(validSkillSegment("*")).toBe(true);
    expect(validSkillSegment("pdf-fill")).toBe(true);
    expect(validSkillSegment("..")).toBe(false);
  });
});
