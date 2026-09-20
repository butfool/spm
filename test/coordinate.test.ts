import { describe, expect, it } from "vitest";
import {
  formatCoordinate,
  namesWholeRepository,
  parseCoordinate,
  readCoordinate,
  repositoryKey,
  tryParseCoordinate,
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
    expect(coordinate.skill).toBe("*");
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
      reason: 'unknown repository type "gitlab" — expected local or github',
    });
  });

  it("rejects a local repository name that is not usable as a path segment", () => {
    for (const name of ["../evil", ".hidden", "has space", "a/b", "local", "github"]) {
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
    expect(tryParseCoordinate("local:mine:pdf")?.skill).toBe("pdf");
  });
});

describe("formatting", () => {
  it("round-trips", () => {
    for (const text of ["local:mine:*", "local:mine:pdf-fill", "github:a/b:c"]) {
      expect(formatCoordinate(parseCoordinate(text))).toBe(text);
    }
  });

  it("derives the repository prefix", () => {
    expect(repositoryKey(parseCoordinate("github:a/b:c"))).toBe("github:a/b");
    expect(repositoryKey(parseCoordinate("local:mine:*"))).toBe("local:mine");
  });
});

describe("name validation", () => {
  it("accepts uppercase local names, which are common in practice", () => {
    expect(validRepositoryName("iWhaleCloud")).toBe(true);
    expect(validRepositoryName("zsm-skills")).toBe(true);
  });

  it("reserves the two type words", () => {
    expect(validRepositoryName("local")).toBe(false);
    expect(validRepositoryName("github")).toBe(false);
  });

  it("requires owner/name for github", () => {
    expect(validGithubRepository("vercel-labs/agent-skills")).toBe(true);
    expect(validGithubRepository("agent-skills")).toBe(false);
    expect(validGithubRepository("a/b/c")).toBe(false);
  });

  it("accepts a star only as the whole-repository skill", () => {
    expect(validSkillSegment("*")).toBe(true);
    expect(validSkillSegment("pdf-fill")).toBe(true);
    expect(validSkillSegment("..")).toBe(false);
  });
});
