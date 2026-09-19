import type { Command } from "commander";
import { installDirsFor, installSkills } from "../../core/install.js";
import {
  addSkillEntry,
  upsertSource,
  writeManifest,
  type Manifest,
  type SourceDecl,
} from "../../core/manifest.js";
import { resolveSpec, type SourceSelection, type Scope } from "../../core/resolve.js";
import { dim, info } from "../../log.js";
import { loadManifest, scopeFrom, type GlobalOptions } from "../context.js";
import { failOnSkippedSkills, report } from "../report.js";

interface AddOptions extends GlobalOptions {
  force?: boolean;
  prune?: boolean;
}

export function registerAddCommand(program: Command): void {
  program
    .command("add")
    .description("declare skills in skills.yaml and install them")
    .argument("<specs...>", "paths, aliases, or github repos")
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
      await resolveSpec(spec, {
        manifest,
        register: true,
        force: opts.force ?? false,
      }),
    );
  }

  const staged = structuredClone(manifest);
  let changed = false;
  for (const selection of selections) {
    changed = persistSelection(staged, selection) || changed;
  }

  const { expandSelections, resolveManifestEntries } = await import("../../core/resolve.js");
  const { targets, skipped } = expandSelections(
    await resolveManifestEntries(staged, {
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
 * Writes one resolved selection into the manifest: the source declaration
 * (when it isn't self-contained) plus the skill entry.
 */
export function persistSelection(manifest: Manifest, selection: SourceSelection): boolean {
  let changed = false;

  if (selection.alias !== null && selection.decl !== null) {
    changed = upsertSource(manifest, selection.alias, selection.decl as SourceDecl) || changed;
  }

  changed = addSkillEntry(manifest, selection.entry) || changed;
  return changed;
}
