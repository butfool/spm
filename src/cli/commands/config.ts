import fs from "node:fs";
import type { Command } from "commander";
import {
  DEFAULT_SETTINGS,
  globalManifestPath,
  readSettings,
  settingsPath,
  sourcesDir,
  spmHome,
} from "../../config.js";
import { dim, heading, info } from "../../log.js";
import { displayPath, type GlobalOptions } from "../context.js";

export function registerConfigCommand(program: Command): void {
  program
    .command("config")
    .description("show the resolved global configuration")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      void merged;

      const settings = readSettings();
      const resolved = {
        spmHome: spmHome(),
        settingsFile: settingsPath(),
        globalManifest: globalManifestPath(),
        sourcesDir: sourcesDir(settings),
        installDirs: settings.installDirs,
        defaultRef: settings.defaultRef,
      };

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
        return;
      }

      heading("spm configuration");
      const width = 16;
      info(`  ${dim("home".padEnd(width))} ${displayPath(resolved.spmHome)}`);
      info(`  ${dim("settings".padEnd(width))} ${displayPath(resolved.settingsFile)}`);
      info(`  ${dim("manifest".padEnd(width))} ${displayPath(resolved.globalManifest)}`);
      info(`  ${dim("sources".padEnd(width))} ${displayPath(resolved.sourcesDir)}`);
      info(`  ${dim("installDirs".padEnd(width))} ${resolved.installDirs.join(", ")}`);
      info(`  ${dim("defaultRef".padEnd(width))} ${resolved.defaultRef}`);

      if (!fs.existsSync(settingsPath())) {
        info("");
        info(
          dim(
            `no settings.yaml — using built-in defaults (${DEFAULT_SETTINGS.installDirs.join(", ")})`,
          ),
        );
      }
    });
}
