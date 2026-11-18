import type { Command } from "commander";
import { externalLinks, installDirsFor, inspectTargets } from "../../core/install.js";
import { externalSkills, manifestPath } from "../../core/manifest.js";
import { dim, heading, info, warn, write } from "../../log.js";
import { displayPath, loadManifest, scopeFrom, type GlobalOptions } from "../context.js";
import { failOnSkippedSkills } from "../report.js";

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

      const external = [...new Set(manifest.external)].sort((a, b) => a.localeCompare(b));
      if (manifest.skills.length === 0 && external.length === 0) {
        info(dim("no skills declared"));
        return;
      }

      const { expandSelections, resolveManifestEntries } = await import("../../core/resolve.js");
      const { targets, skipped } = expandSelections(
        await resolveManifestEntries(manifest, {
          manifestDir: scope.manifestDir,
          global: scope.kind === "global",
          register: false,
        }),
        externalSkills(manifest, scope.manifestDir),
      );
      const states = inspectTargets(targets, manifest, scope);
      const installDirs = installDirsFor(manifest, scope);
      const stranded = externalLinks(manifest, installDirs);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              manifest: manifestPath(scope.manifestDir),
              installDirs,
              external,
              externalLinks: stranded.map((link) => ({
                name: link.skillName,
                dir: link.installDir,
                path: link.linkPath,
              })),
              skills: states.map((s) => ({
                name: s.name,
                source: s.source,
                targets: s.dirs.map((d) => ({ dir: d.dir, state: d.state })),
              })),
            },
            null,
            2,
          )}\n`,
        );
        failOnSkippedSkills(skipped);
        return;
      }

      heading(
        `${states.length} skill${states.length === 1 ? "" : "s"} → ${installDirs
          .map(displayPath)
          .join(", ")}`,
      );

      const width = Math.max(
        4,
        ...states.map((s) => s.name.length),
        ...external.map((name) => name.length),
      );
      // The marker column holds "ok" and "external"; sizing it to the widest
      // marker keeps the source column aligned once both kinds appear.
      const markerWidth = external.length > 0 ? "external".length : 2;

      for (const state of states) {
        const bad = state.dirs.filter((d) => d.state !== "ok");
        const marker = bad.length === 0 ? dim("ok") : warnMarker(bad.length, state.dirs.length);
        const source = dim(state.source);
        write(`  ${state.name.padEnd(width)}  ${padMarker(marker, markerWidth)}  ${source}`);
      }

      for (const name of external) {
        write(
          `  ${name.padEnd(width)}  ${dim("external".padEnd(markerWidth))}  ${dim(
            "not managed by spm",
          )}`,
        );
      }

      const broken = states.filter((s) => s.dirs.some((d) => d.state !== "ok"));
      if (broken.length > 0) {
        info("");
        warn(`${broken.length} skill(s) are not linked correctly — run \`spm doctor\``);
      }

      if (stranded.length > 0) {
        info("");
        warn(
          `${stranded.length} link(s) spm created sit on external skill names — run \`spm doctor\``,
        );
      }

      failOnSkippedSkills(skipped);
    });
}

function warnMarker(bad: number, total: number): string {
  return bad === total ? "✗" : "!";
}

/** Pads a marker to the column width, leaving SGR styling in place. */
function padMarker(marker: string, width: number): string {
  const visible = marker.replace(/\u001b\[[0-9;?]*m/g, "").length;
  return marker + " ".repeat(Math.max(0, width - visible));
}
