import type { Command } from "commander";
import { installDirsFor, installSkills } from "../../core/install.js";
import { dim, heading, info, skip, success, warn } from "../../log.js";
import { displayPath, loadManifest, reconcile, scopeFrom, type GlobalOptions } from "../context.js";
import { report } from "../report.js";

interface InstallOptions extends GlobalOptions {
  force?: boolean;
  prune?: boolean;
  frozen?: boolean;
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .alias("i")
    .description("install skills; with no arguments, restore everything skills.yaml declares")
    .argument("[specs...]", "skill specifiers (same forms as `spm add`)")
    .option("-f, --force", "overwrite entries that aren't symlinks owned by spm")
    .option("--no-prune", "keep links that skills.yaml no longer declares")
    .option("--frozen", "refuse to fetch or write anything; only check what's declared")
    .action(async (specs: string[], opts: InstallOptions, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      await installCommand(specs, merged);
    });
}

async function installCommand(specs: string[], opts: InstallOptions): Promise<void> {
  const scope = scopeFrom(opts);
  const { manifest, existed } = loadManifest(scope, false);

  if (specs.length > 0) {
    if (opts.frozen) {
      throw new Error("--frozen cannot be combined with explicit specifiers");
    }
    // `spm i <spec>` is `spm add <spec>` — declare, then reconcile.
    const { runAdd } = await import("./add.js");
    await runAdd(specs, scope, manifest, opts);
    return;
  }

  if (!existed) {
    if (opts.frozen) {
      warn("no skills.yaml to verify");
      return;
    }
    info(dim("no skills.yaml here — nothing to install"));
    return;
  }

  const { targets } = await reconcile(manifest, scope, {
    register: !opts.frozen,
    force: opts.force ?? false,
  });

  const installDirs = installDirsFor(manifest, scope);

  if (opts.frozen) {
    reportFrozen(targets, manifest, scope);
    return;
  }

  // Deliberately runs even when nothing is declared: that's how removing an
  // entry from skills.yaml and re-running `spm i` cleans up the old links.
  const result = installSkills(targets, manifest, scope, {
    force: opts.force ?? false,
    prune: opts.prune ?? true,
  });

  if (targets.length === 0 && result.removed.length === 0) {
    info(dim("skills.yaml declares no skills"));
    return;
  }

  report(result.links, result.removed, targets.length, installDirs, scope.manifestDir);
}

/** `--frozen` renders the same view as doctor, but scoped to one manifest. */
async function reportFrozen(
  targets: Awaited<ReturnType<typeof reconcile>>["targets"],
  manifest: Parameters<typeof installSkills>[1],
  scope: ReturnType<typeof scopeFrom>,
): Promise<void> {
  const { inspectTargets } = await import("../../core/install.js");
  const states = inspectTargets(targets, manifest, scope);

  heading(`${targets.length} declared skills`);
  let problems = 0;

  for (const state of states) {
    const bad = state.dirs.filter((d) => d.state !== "ok");
    if (bad.length === 0) {
      skip(`${state.name} ${dim("ok")}`);
      continue;
    }
    problems += bad.length;
    for (const entry of bad) {
      warn(`${state.name}: ${describeState(entry.state)} at ${displayPath(entry.linkPath)}`);
    }
  }

  if (problems > 0) {
    throw new Error(`${problems} link${problems === 1 ? "" : "s"} out of date — run \`spm i\` to fix`);
  }
  success("everything is in sync");
}

function describeState(state: string): string {
  switch (state) {
    case "missing":
      return "not linked";
    case "wrong":
      return "points elsewhere";
    case "foreign":
      return "a real directory is in the way";
    default:
      return state;
  }
}
