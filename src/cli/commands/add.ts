import type { Command } from "commander";
import { parseCoordinate } from "../../core/coordinate.js";
import { installDirsFor, installSkills } from "../../core/install.js";
import {
  addSkillEntry,
  upsertRepository,
  writeManifest,
  type Manifest,
} from "../../core/manifest.js";
import {
  expandSelections,
  resolveManifestEntries,
  resolveSpec,
  type SourceSelection,
  type Scope,
} from "../../core/resolve.js";
import { dim, info } from "../../log.js";
import { loadManifest, resolveContext, scopeFrom, type GlobalOptions } from "../context.js";
import { failOnSkippedSkills, report } from "../report.js";

interface AddOptions extends GlobalOptions {
  force?: boolean;
  prune?: boolean;
  name?: string;
}

export function registerAddCommand(program: Command): void {
  program
    .command("add")
    .description("declare skills in skills.yaml and install them")
    .argument("<specs...>", "a coordinate, a local directory, or a skill name")
    .option("-n, --name <name>", "name to register a local directory under")
    .option("-f, --force", "overwrite entries that aren't symlinks owned by spm")
    .option("--no-prune", "keep links that skills.yaml no longer declares")
    .action(async (specs: string[], opts: AddOptions, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest } = loadManifest(scope, false);
      await runAdd(specs, scope, manifest, merged);
    });
}

/**
 * The shared body of `spm add` and `spm i <spec>`: resolve each specifier,
 * record it in the manifest, then reconcile the filesystem.
 *
 * The new declarations are staged on a copy and validated there, so a
 * specifier that conflicts with what's already declared aborts the command
 * without leaving a half-written manifest behind.
 */
export async function runAdd(
  specs: string[],
  scope: Scope,
  manifest: Manifest,
  opts: AddOptions,
): Promise<void> {
  const selections: SourceSelection[] = [];
  for (const spec of specs) {
    selections.push(
      await resolveSpec(
        spec,
        resolveContext(manifest, scope, {
          register: true,
          force: opts.force ?? false,
          name: opts.name,
        }),
      ),
    );
  }

  const staged = structuredClone(manifest);
  let changed = false;
  for (const selection of selections) {
    changed = persistSelection(staged, selection) || changed;
  }

  const { targets, skipped } = expandSelections(
    await resolveManifestEntries(staged, {
      manifestDir: scope.manifestDir,
      global: scope.kind === "global",
      register: true,
      force: opts.force ?? false,
    }),
  );

  // Past this point nothing can fail on the manifest's own account, so it is
  // safe to commit the new declarations.
  if (changed) {
    writeManifest(scope.manifestDir, staged);
    Object.assign(manifest, staged);
    info(dim(`updated ${scope.manifestDir}/skills.yaml`));
  }

  const result = installSkills(targets, staged, scope, {
    force: opts.force ?? false,
    prune: opts.prune ?? true,
  });

  report(
    result.links,
    result.removed,
    targets.length,
    installDirsFor(staged, scope),
    scope.manifestDir,
  );

  // The links above are in place; a file discovery refused still fails the
  // command, so the omission cannot pass unnoticed.
  failOnSkippedSkills(skipped);
}

/**
 * Writes one resolved selection into the manifest: the local repository
 * declaration, when this scope doesn't already have one, plus the coordinate.
 *
 * A github repository writes nothing but the coordinate — `owner/name` is its
 * identity, so there is no path to record and nothing to bootstrap.
 */
export function persistSelection(
  manifest: Manifest,
  selection: SourceSelection,
): boolean {
  let changed = false;

  if (selection.declaration !== null) {
    changed =
      upsertRepository(manifest, selection.declaration.name, {
        type: "local",
        path: selection.declaration.path,
      }) || changed;
  }

  changed = addSkillEntry(manifest, parseCoordinate(selection.entry)) || changed;
  return changed;
}
