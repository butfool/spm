import path from "node:path";
import { manifestExists, readManifest, type Manifest } from "../core/manifest.js";
import {
  expandSelections,
  globalScope,
  projectScope,
  resolveManifestEntries,
  type Scope,
  type SkillTarget,
} from "../core/resolve.js";
import { SpmError } from "../errors.js";

/** Options every command inherits from the root program. */
export interface GlobalOptions {
  global?: boolean;
  quiet?: boolean;
}

/**
 * Picks the scope a command operates on. `--global` switches to
 * ~/.config/spm/skills.yaml; otherwise the current directory is used.
 */
export function scopeFrom(opts: GlobalOptions, cwd = process.cwd()): Scope {
  return opts.global ? globalScope() : projectScope(cwd);
}

/**
 * Reads the manifest for a scope. When `required` is false a missing manifest
 * yields an empty one, which is what `spm add` wants — it creates the
 * manifest rather than refusing to run without one.
 */
export function loadManifest(
  scope: Scope,
  required: boolean,
): { manifest: Manifest; existed: boolean } {
  if (!manifestExists(scope.manifestDir)) {
    if (required) {
      throw new SpmError(
        `no skills.yaml in ${scope.manifestDir}`,
        scope.kind === "global"
          ? "Nothing is installed globally yet. Add something with `spm add -g <spec>`."
          : "Run `spm init` to create one.",
      );
    }
    return { manifest: { installDirs: [], sources: {}, skills: [] }, existed: false };
  }

  const manifest = readManifest(scope.manifestDir);
  if (manifest === null) {
    throw new SpmError(`no skills.yaml in ${scope.manifestDir}`);
  }
  return { manifest, existed: true };
}

/**
 * Resolves the manifest into concrete skills and links them into every install
 * directory. This is the single reconciliation path shared by `install`, `add`
 * and `update`.
 */
export async function reconcile(
  manifest: Manifest,
  scope: Scope,
  opts: { register: boolean; force: boolean },
): Promise<{ targets: SkillTarget[]; selections: Awaited<ReturnType<typeof resolveManifestEntries>> }> {
  const selections = await resolveManifestEntries(manifest, {
    register: opts.register,
    force: opts.force,
  });
  const targets = expandSelections(selections);
  return { targets, selections };
}

/** Shortens an absolute path to ~-relative form for display. */
export function displayPath(p: string): string {
  const home = process.env["HOME"];
  if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  return p;
}

/** Renders an absolute path relative to the manifest, when that's shorter. */
export function relativeTo(base: string, p: string): string {
  const rel = path.relative(base, p);
  return rel.startsWith("..") ? displayPath(p) : rel;
}
