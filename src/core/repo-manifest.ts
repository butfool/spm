import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SpmError } from "../errors.js";

/** Filename expected at the root of a source repository. */
export const REPO_MANIFEST_FILENAME = "skill-repository.yaml";

/**
 * A repository's self-description. Deliberately minimal: it answers "what is
 * this repo called" and "which parts of it are visible", and nothing else.
 *
 * There are no UUIDs here. Identity tracking across renames is the repository
 * author's problem, not the tool's — a name is just a name.
 */
export const RepoManifestSchema = z.object({
  /** Display name; also the default name when the directory is registered. */
  name: z.string().min(1).optional(),
  /** Path prefixes (repo-relative) excluded from skill discovery. */
  exclude: z.array(z.string()).default([]),
  /** Maximum discovery recursion depth. 0 (or omitted) means unlimited. */
  maxDepth: z.number().int().nonnegative().default(0),
});

export type RepoManifest = z.infer<typeof RepoManifestSchema>;

const EMPTY: RepoManifest = { exclude: [], maxDepth: 0 };

/**
 * Reads `<root>/skill-repository.yaml`. A missing file is not an error — the
 * repository simply has no declared name or excludes. A malformed file is an
 * error, because silently ignoring it would hide skills the author meant to
 * hide.
 */
export function readRepoManifest(root: string): RepoManifest {
  const file = path.join(root, REPO_MANIFEST_FILENAME);
  if (!fs.existsSync(file)) return { ...EMPTY };

  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (err) {
    throw new SpmError(
      `${file} is not valid YAML: ${(err as Error).message}`,
    );
  }

  const result = RepoManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new SpmError(
      `${file} is invalid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/** Reads just the declared repository name, or null when absent. */
export function readRepoName(root: string): string | null {
  return readRepoManifest(root).name ?? null;
}
