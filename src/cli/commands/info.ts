import type { Command } from "commander";
import { discoverSkills } from "../../core/discover.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
import { resolveSpec } from "../../core/resolve.js";
import { bold, dim, heading, info } from "../../log.js";
import { displayPath, loadManifest, scopeFrom, type GlobalOptions } from "../context.js";

export function registerInfoCommand(program: Command): void {
  program
    .command("info")
    .description("show details for one skill")
    .argument("<spec>", "alias/skill, owner/repo/skill, or a local path")
    .option("--json", "machine-readable output")
    .action(async (spec: string, opts: { json?: boolean }, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest } = loadManifest(scope, false);

      const selection = await resolveSpec(spec, { manifest, register: false });
      if (selection.skills === "*") {
        throw new Error(`"${spec}" names a whole source — narrow it to a single skill`);
      }

      const skillName = selection.skills[0]!;
      const repo = readRepoManifest(selection.root);
      const skills = discoverSkills(selection.root, {
        exclude: repo.exclude,
        maxDepth: repo.maxDepth,
      });
      const skill = skills.find((s) => s.name === skillName);

      if (!skill) {
        throw new Error(
          `skill "${skillName}" not found in ${selection.label}` +
            (skills.length > 0 ? `\navailable: ${skills.map((s) => s.name).join(", ")}` : ""),
        );
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              name: skill.name,
              description: skill.description,
              source: selection.alias,
              path: skill.dir,
              relativePath: skill.relativePath,
              frontmatter: skill.frontmatter,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      heading(bold(skill.name));
      info(skill.description);
      info("");
      info(`  ${dim("source")}   ${selection.alias ?? dim("(ad-hoc path)")}`);
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
    });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => formatValue(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
