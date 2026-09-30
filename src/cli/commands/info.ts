import type { Command } from "commander";
import { SpmError } from "../../errors.js";
import { discoverSkills, skippedFrom, skippedLine } from "../../core/discover.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
import { resolveSpec, sourceLabel } from "../../core/resolve.js";
import { bold, dim, heading, info } from "../../log.js";
import { displayPath, loadManifest, resolveContext, scopeFrom, type GlobalOptions } from "../context.js";
import { failOnSkippedSkills } from "../report.js";

export function registerInfoCommand(program: Command): void {
  program
    .command("info")
    .description("show details for one skill")
    .argument("<spec>", "a coordinate such as local:mine:pdf-fill or github:owner/repo:*")
    .option("--json", "machine-readable output")
    .action(async (spec: string, opts: { json?: boolean }, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest } = loadManifest(scope, false);

      const selection = await resolveSpec(spec, resolveContext(manifest, scope, { register: false }));
      if (selection.skills === "*") {
        throw new SpmError(
          `"${spec}" names a whole repository — narrow it to a single skill`,
        );
      }

      const skillName = selection.skills[0]!;
      const repo = readRepoManifest(selection.root);
      const { skills, invalid } = discoverSkills(selection.root, {
        exclude: repo.exclude,
        maxDepth: repo.maxDepth,
      });
      const skill = skills.find((s) => s.name === skillName);
      const skipped = skippedFrom(sourceLabel(selection.type, selection.id), invalid);

      if (!skill) {
        const details = [
          skills.length > 0 ? `available: ${skills.map((s) => s.name).join(", ")}` : "",
          ...(skipped.length > 0 ? ["skipped:", ...skipped.map(skippedLine)] : []),
        ].filter((line) => line !== "");
        throw new SpmError(
          `skill "${skillName}" not found in ${selection.label}` +
            (details.length > 0 ? `\n  ${details.join("\n  ")}` : ""),
        );
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              name: skill.name,
              description: skill.description,
              source: sourceLabel(selection.type, selection.id),
              path: skill.dir,
              relativePath: skill.relativePath,
              frontmatter: skill.frontmatter,
            },
            null,
            2,
          )}\n`,
        );
        failOnSkippedSkills(skipped);
        return;
      }

      heading(bold(skill.name));
      info(skill.description);
      info("");
      info(`  ${dim("source")}   ${sourceLabel(selection.type, selection.id)}`);
      info(`  ${dim("path")}     ${displayPath(skill.dir)}`);
      info(`  ${dim("relative")} ${skill.relativePath}`);

      const extras = Object.entries(skill.frontmatter).filter(
        ([key]) => key !== "name" && key !== "description",
      );
      if (extras.length > 0) {
        info("");
        for (const [key, value] of extras) {
          info(`  ${dim(key)}: ${formatValue(value)}`);
        }
      }

      failOnSkippedSkills(skipped);
    });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => formatValue(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
