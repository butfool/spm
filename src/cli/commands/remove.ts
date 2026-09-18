import type { Command } from "commander";
import { installDirsFor, installSkills } from "../../core/install.js";
import { entryToString, writeManifest, type Manifest, type SkillEntry } from "../../core/manifest.js";
import {
  expandSelections,
  isBareSpec,
  resolveManifestEntries,
  specToEntryKey,
  type Scope,
} from "../../core/resolve.js";import { dim, info, warn } from "../../log.js";
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
    const covered = await findCoveringEntry(manifest, spec);
    if (covered !== null) {
      warn(`"${spec}" comes from the whole-source entry "${covered}" — it isn't listed separately`);
      info(
        dim(
          `  Declare the specific skills you want instead of \`${covered}\`, or leave it as is.`,
        ),
      );
    } else {
      warn(`"${spec}" is not declared in skills.yaml`);
    }
  }

  if (removed.length === 0) {
    return;
  }

  writeManifest(scope.manifestDir, manifest);
  info(dim(`updated ${scope.manifestDir}/skills.yaml`));

  // Re-resolve what remains, then let the install pass prune the rest.
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

  if (!isBareSpec(spec, manifest)) {
    return manifest.skills.filter((e) => entryToString(e) === key);
  }

  // A bare name matches any declaration that names that skill, in either the
  // `alias/skill` or the `repo:skill` form.
  return manifest.skills.filter((entry) => {
    const text = entryToString(entry);
    return text === key || text.endsWith(`/${key}`) || text.endsWith(`:${key}`);
  });
}

/**
 * When a spec matches nothing, works out whether a whole-source entry is
 * nonetheless providing it — otherwise `spm rm <skill>` fails with "not
 * declared", which is technically true but reads as a bug.
 */
async function findCoveringEntry(
  manifest: Manifest,
  spec: string,
): Promise<string | null> {
  const name = spec.trim().split("/").pop();
  if (name === undefined || name === "" || name === "*") return null;

  for (const entry of manifest.skills) {
    const key = entryToString(entry);
    if (!key.endsWith("/*")) continue;

    try {
      const provided = expandSelections(
        await resolveManifestEntries({ ...manifest, skills: [entry] }, { register: false }),
      );
      if (provided.some((t) => t.name === name)) return key;
    } catch {
      // A source is unreachable; don't guess about what it would provide.
      continue;
    }
  }
  return null;
}
