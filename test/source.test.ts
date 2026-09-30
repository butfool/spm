import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubSourcePath, localSourcePath } from "../src/core/source.js";
import type { SpmError } from "../src/errors.js";
import { clearHome, useTempHome } from "./helpers.js";

beforeEach(() => {
  useTempHome();
});

afterEach(clearHome);

function capture(run: () => unknown): SpmError {
  try {
    run();
  } catch (err) {
    return err as SpmError;
  }
  throw new Error("expected the call to throw");
}

/**
 * Source identifiers become path segments under the cache. Validation already
 * refuses a slash and `.`/`..`, and this is the backstop that keeps the
 * guarantee local to the cache path itself.
 */
describe("source cache paths", () => {
  it("places a valid entry under the cache directory", () => {
    expect(githubSourcePath("owner/repo")).toMatch(/sources[/\\]github[/\\]owner[/\\]repo$/);
    expect(localSourcePath("Obsidian")).toMatch(/sources[/\\]local[/\\]Obsidian$/);
  });

  it("refuses a github name that would escape the cache", () => {
    for (const name of ["../..", "owner/..", "../local", "..", "."]) {
      const caught = capture(() => githubSourcePath(name));
      expect(caught.message, name).toMatch(/does not name a usable source cache entry/);
    }
  });

  it("refuses a local name that would escape the cache", () => {
    expect(() => localSourcePath("..")).toThrow(/does not name a usable source cache entry/);
  });
});
