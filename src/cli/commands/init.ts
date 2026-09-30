import path from "node:path";
import type { Command } from "commander";
import { DEFAULT_SETTINGS, assertInstallDirsInScope, readSettings } from "../../config.js";
import { MANIFEST_FILENAME, writeManifest } from "../../core/manifest.js";
import { dim, info, success, warn } from "../../log.js";
import { loadManifest, scopeFrom, type GlobalOptions } from "../context.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(`create a ${MANIFEST_FILENAME} declaring this project's skills`)
    .argument("[dir]", "directory to initialise", ".")
    .option("-f, --force", "overwrite an existing manifest")
    .action(async (dir: string, opts: { force?: boolean }, command: Command) => {
      const merged = command.optsWithGlobals() as GlobalOptions;
      const scope = scopeFrom(merged, path.resolve(dir));

      const { manifest, existed } = loadManifest(scope, false);
      if (existed && !opts.force) {
        info(dim(`${MANIFEST_FILENAME} already exists in ${scope.manifestDir}`));
        return;
      }

      if (manifest.installDirs.length === 0) {
        const settings = readSettings();
        const chosen =
          settings.installDirs.length > 0
            ? settings.installDirs
            : DEFAULT_SETTINGS.installDirs;
        // Refuse now rather than write a manifest whose first install would
        // fail: an inherited default has to satisfy the same rule as a
        // declared one.
        assertInstallDirsInScope(chosen, scope.installBaseDir);
        manifest.installDirs = [...chosen];
      }

      writeManifest(scope.manifestDir, manifest);
      success(`created ${path.join(scope.manifestDir, MANIFEST_FILENAME)}`);
      info(`  ${dim("installDirs:")} ${manifest.installDirs.join(", ")}`);
      if (scope.kind === "global") {
        warn("this is the global manifest — skills here are visible to every project");
      }
    });
}
