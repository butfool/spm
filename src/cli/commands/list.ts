import path from "node:path";
import type { Command } from "commander";
import { installDirsFor, inspectTargets } from "../../core/install.js";
import { dim, heading, info, warn } from "../../log.js";
import { displayPath, loadManifest, scopeFrom, type GlobalOptions } from "../context.js";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .aliases(["ls"])
    .description("list the skills this manifest declares")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest, existed } = loadManifest(scope, false);

      if (!existed) {
        info(dim(`no skills.yaml in ${scope.manifestDir}`));
        return;
      }
      if (manifest.skills.length === 0) {
        info(dim("no skills declared"));
        return;
      }

      const { expandSelections, resolveManifestEntries } = await import("../../core/resolve.js");
      const targets = expandSelections(await resolveManifestEntries(manifest, { register: false }));
      const states = inspectTargets(targets, manifest, scope);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              manifest: path.join(scope.manifestDir, "skills.yaml"),
              installDirs: installDirsFor(manifest, scope),
              skills: states.map((s) => ({
                name: s.name,
                source: s.sourceAlias ?? s.skillDir,
                targets: s.dirs.map((d) => ({ dir: d.dir, state: d.state })),
              })),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const installDirs = installDirsFor(manifest, scope);
      heading(
        `${states.length} skill${states.length === 1 ? "" : "s"} → ${installDirs
          .map(displayPath)
          .join(", ")}`,
      );

      const width = Math.max(...states.map((s) => s.name.length), 4);
      for (const state of states) {
        const bad = state.dirs.filter((d) => d.state !== "ok");
        const marker = bad.length === 0 ? dim("ok") : warnMarker(bad.length, state.dirs.length);
        const source = state.sourceAlias === null ? "" : dim(state.sourceAlias);
        process.stdout.write(`  ${state.name.padEnd(width)}  ${marker}  ${source}\n`);
      }

      const broken = states.filter((s) => s.dirs.some((d) => d.state !== "ok"));
      if (broken.length > 0) {
        info("");
        warn(`${broken.length} skill(s) are not linked correctly — run \`spm doctor\``);
      }
    });
}

function warnMarker(bad: number, total: number): string {
  return bad === total ? "✗" : "!";
}
