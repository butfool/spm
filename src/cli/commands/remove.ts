import type { Command } from "commander";
import {
  tryParseCoordinate,
  isRepositoryCoordinate,
  type RepositoryCoordinate,
} from "../../core/coordinate.js";
import { discoverSkills } from "../../core/discover.js";
import { installDirsFor, installSkills } from "../../core/install.js";
import {
  removeSkillEntries,
  writeManifest,
  type Manifest,
} from "../../core/manifest.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
import { repositoryLayers, type RepositoryLayers } from "../../core/registry.js";
import {
  coordinateForPath,
  coordinateMatches,
  expandSelections,
  isKnownLocal,
  isPathLike,
  parseSpecTarget,
  registeredRoot,
  resolveManifestEntries,
  type Scope,
  type SpecTarget,
} from "../../core/resolve.js";
import { SpmError } from "../../errors.js";
import { dim, info, warn } from "../../log.js";
import { loadManifest, scopeFrom, type GlobalOptions } from "../context.js";
import { failOnSkippedSkills, report } from "../report.js";

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove")
    .aliases(["rm", "un", "uninstall"])
    .description("remove skills from skills.yaml and unlink them")
    .argument("<specs...>", "coordinates or skill names to remove")
    .action(async (specs: string[], opts: GlobalOptions, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest } = loadManifest(scope, true);
      await runRemove(specs, scope, manifest);
    });
}

/**
 * Removal is "edit the manifest, then reconcile": dropping the declarations
 * and re-running install means the prune step removes exactly the links that
 * are no longer accounted for, with no separate removal code path to keep in
 * sync with the install one.
 */
export async function runRemove(
  specs: string[],
  scope: Scope,
  manifest: Manifest,
): Promise<void> {
  const layers = repositoryLayers(manifest, scope.manifestDir, scope.kind === "global");
  const missing: string[] = [];
  let removed = 0;

  for (const spec of specs) {
    const target = targetFor(spec, layers);
    if (target === null) {
      missing.push(spec);
      continue;
    }
    const count = removeSkillEntries(manifest, (entry) =>
      coordinateMatches(entry, target, scope.manifestDir),
    );
    if (count === 0) {
      missing.push(spec);
      continue;
    }
    removed += count;
  }

  for (const spec of missing) {
    reportMissing(manifest, spec);
  }

  if (removed === 0) return;

  // A project-level declaration nothing refers to any more is dropped, so the
  // name is free again. The machine-level registry is never touched here:
  // that belongs to `spm repository`.
  const dropped = scope.kind === "project" ? pruneUnusedDeclarations(manifest) : [];

  writeManifest(scope.manifestDir, manifest);
  info(dim(`updated ${scope.manifestDir}/skills.yaml`));
  for (const name of dropped) {
    info(dim(`dropped the unused local repository declaration "${name}"`));
  }

  // Re-resolve what remains, then let the install pass prune the rest.
  const { targets, skipped } = expandSelections(
    await resolveManifestEntries(manifest, {
      manifestDir: scope.manifestDir,
      global: scope.kind === "global",
      register: false,
    }),
  );

  const result = installSkills(targets, manifest, scope, { prune: true });

  report(
    [],
    result.removed,
    targets.length,
    installDirsFor(manifest, scope),
    scope.manifestDir,
  );

  failOnSkippedSkills(skipped);
}

/**
 * Drops every project-level repository declaration no coordinate names any
 * more. Returns the names that went.
 */
function pruneUnusedDeclarations(manifest: Manifest): string[] {
  const used = new Set(
    manifest.skills
      .map((entry) => tryParseCoordinate(entry))
      .filter(
        (coordinate): coordinate is RepositoryCoordinate =>
          coordinate !== null && coordinate.type === "local",
      )
      .map((coordinate) => coordinate.repository),
  );

  const dropped: string[] = [];
  for (const name of Object.keys(manifest.repositories)) {
    if (used.has(name)) continue;
    delete manifest.repositories[name];
    dropped.push(name);
  }
  return dropped;
}

/**
 * What a removal specifier names. A specifier naming a repository this
 * manifest never mentions is not an error — it simply matches nothing.
 */
function targetFor(spec: string, layers: RepositoryLayers): SpecTarget | null {
  const trimmed = spec.trim();
  if (trimmed === "") return null;

  try {
    if (isPathLike(trimmed)) {
      const coordinate = coordinateForPath(trimmed);
      return coordinate === null ? null : { kind: "coordinate", coordinate };
    }
    return parseSpecTarget(trimmed, (name) => isKnownLocal(name, layers));
  } catch (err) {
    if (err instanceof SpmError) return null;
    throw err;
  }
}

function reportMissing(manifest: Manifest, spec: string): void {
  const covering = findCoveringEntry(manifest, spec);
  if (covering === null) {
    warn(`"${spec}" is not declared in skills.yaml`);
    return;
  }
  warn(`"${spec}" comes from the whole-repository entry "${covering}" — it isn't listed separately`);
  info(`  ${dim(`Declare the individual skills instead of \`${covering}\`, or leave it as is.`)}`);
}

/**
 * When a specifier matches nothing, works out whether a whole-repository
 * entry is nonetheless providing it — otherwise `spm rm <skill>` fails with
 * "not declared", which is technically true but reads as a bug.
 */
function findCoveringEntry(manifest: Manifest, spec: string): string | null {
  const name = spec.trim().split(":").pop();
  if (name === undefined || name === "" || name === "*") return null;

  const wholeRepositories = manifest.skills
    .map((entry) => tryParseCoordinate(entry))
    .filter(
      (coordinate): coordinate is RepositoryCoordinate =>
        coordinate !== null && isRepositoryCoordinate(coordinate) && coordinate.skill === "*",
    );

  for (const coordinate of wholeRepositories) {
    const root = registeredRoot(coordinate);
    if (root === null) continue;

    const repo = readRepoManifest(root);
    const { skills } = discoverSkills(root, {
      exclude: repo.exclude,
      maxDepth: repo.maxDepth,
    });
    if (skills.some((skill) => skill.name === name)) {
      return `${coordinate.type}:${coordinate.repository}:*`;
    }
  }

  return null;
}
