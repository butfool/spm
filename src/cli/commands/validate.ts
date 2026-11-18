import type { Command } from "commander";
import { CliExitError } from "../../errors.js";
import {
  validatePath,
  type Diagnostic,
  type FileValidation,
} from "../../core/validate.js";
import { bold, dim, error, heading, hint, info, success, warn } from "../../log.js";
import { displayPath } from "../context.js";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("lint SKILL.md files for frontmatter and body problems")
    .argument("<path...>", "SKILL.md file or directory tree to lint")
    .option("--json", "machine-readable output")
    .action((targets: string[], opts: { json?: boolean }) => {
      const seen = new Set<string>();
      const files: FileValidation[] = [];

      for (const target of targets) {
        for (const item of validatePath(target)) {
          if (seen.has(item.filePath)) continue;
          seen.add(item.filePath);
          files.push(item);
        }
      }

      const totalErrors = files.reduce(
        (sum, file) => sum + file.result.errors.length,
        0,
      );
      const totalWarnings = files.reduce(
        (sum, file) => sum + file.result.warnings.length,
        0,
      );

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              files: files.map((file) => ({
                filePath: file.filePath,
                valid: file.result.valid,
                errors: file.result.errors,
                warnings: file.result.warnings,
              })),
              totalErrors,
              totalWarnings,
            },
            null,
            2,
          )}\n`,
        );
        if (totalErrors > 0) throw new CliExitError(1);
        return;
      }

      for (const file of files) {
        info("");
        heading(bold(displayPath(file.filePath)));
        if (file.result.errors.length === 0 && file.result.warnings.length === 0) {
          success("valid — no issues found");
          continue;
        }
        for (const diagnostic of file.result.errors) render(diagnostic);
        for (const diagnostic of file.result.warnings) render(diagnostic);
      }

      info("");
      heading(
        `${bold("Summary:")} ${totalErrors} error${totalErrors === 1 ? "" : "s"}, ${totalWarnings} warning${
          totalWarnings === 1 ? "" : "s"
        } across ${files.length} file${files.length === 1 ? "" : "s"}`,
      );

      if (totalErrors > 0) throw new CliExitError(1);
    });
}

/** Prints one finding, with its field and remedy on a second line. */
function render(diagnostic: Diagnostic): void {
  const label = diagnostic.field === undefined ? "" : ` ${dim(`[${diagnostic.field}]`)}`;
  if (diagnostic.level === "error") error(`${diagnostic.message}${label}`);
  else warn(`${diagnostic.message}${label}`);
  if (diagnostic.fix !== undefined) {
    for (const line of diagnostic.fix.split("\n")) hint(`fix: ${line}`);
  }
}
