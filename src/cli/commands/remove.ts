import type { Command } from "commander";
import { installDirsFor, installSkills } from "../../core/install.js";
import { entryToString, writeManifest, type Manifest, type SkillEntry } from "../../core/manifest.js";
import { isBareSpec, specToEntryKey, type Scope } from "../../core/resolve.js";
import { dim, info, warn } from "../../log.js";
import { loadManifest, scopeFrom, type GlobalOptions } from "../context.js";
import { report } from "../report.js";

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove")
    .aliases(["rm", "un", "uninstall"])
    .description("remove skills from skills.yaml and unlink them")
    .argument("<specs...>", "skill specifiers to remove")
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
  const removed: SkillEntry[] = [];
  const missing: string[] = [];

  for (const spec of specs) {
    const matched = matchEntries(manifest, spec);
    if (matched.length === 0) {
      missing.push(spec);
      continue;
    }
    for (const entry of matched) {
      manifest.skills = manifest.skills.filter((e) => e !== entry);
      removed.push(entry);
    }
  }

  for (const spec of missing) {
    warn(`"${spec}" is not declared in skills.yaml`);
  }

  if (removed.length === 0) {
    return;
  }

  writeManifest(scope.manifestDir, manifest);
  info(dim(`updated ${scope.manifestDir}/skills.yaml`));

  // Re-resolve what remains, then let the install pass prune the rest.
  const { expandSelections, resolveManifestEntries } = await import("../../core/resolve.js");
  const targets = expandSelections(
    await resolveManifestEntries(manifest, { register: false }),
  );

  const result = installSkills(targets, manifest, scope, { prune: true });

  report(
    [],
    result.removed,
    targets.length,
    installDirsFor(manifest, scope),
    scope.manifestDir,
  );
}

/** Finds the manifest entries a specifier refers to. */
function matchEntries(manifest: Manifest, spec: string): SkillEntry[] {
  const key = specToEntryKey(spec, manifest);

  if (!isBareSpec(spec)) {
    return manifest.skills.filter((e) => entryToString(e) === key);
  }

  // A bare name matches any declaration that names that skill, in either the
  // `alias/skill` or the `repo:skill` form.
  return manifest.skills.filter((entry) => {
    const text = entryToString(entry);
    return text === key || text.endsWith(`/${key}`) || text.endsWith(`:${key}`);
  });
}
