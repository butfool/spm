import type { Command } from "commander";
import {
  discoverSkills,
  skippedFrom,
  type DiscoveredSkill,
  type SkippedSkill,
} from "../../core/discover.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
import { listSources } from "../../core/source.js";
import { bold, dim, heading, info, write } from "../../log.js";
import type { GlobalOptions } from "../context.js";
import { failOnSkippedSkills } from "../report.js";

interface FindOptions extends GlobalOptions {
  source?: string;
  json?: boolean;
  all?: boolean;
}

export function registerFindCommand(program: Command): void {
  program
    .command("find")
    .description("search for skills across registered repositories")
    .argument("[query]", "substring to match against name and description", "")
    .option("-s, --source <name>", "restrict the search to one repository")
    .option("-a, --all", "show full descriptions instead of truncating")
    .option("--json", "machine-readable output")
    .action(async (query: string, opts: FindOptions, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      await findCommand(query, merged);
    });
}

async function findCommand(query: string, opts: FindOptions): Promise<void> {
  const sources = await listSources();
  if (sources.length === 0) {
    info(dim("no repositories registered — add one with `spm repository add ./path`"));
    return;
  }

  const needle = query.trim().toLowerCase();
  const hits: { label: string; skill: DiscoveredSkill }[] = [];
  const skipped: SkippedSkill[] = [];

  for (const source of sources) {
    const label = `${source.kind}:${source.id}`;
    if (opts.source !== undefined && source.id !== opts.source && label !== opts.source) {
      continue;
    }

    const repo = readRepoManifest(source.path);
    const { skills, invalid } = discoverSkills(source.path, {
      exclude: repo.exclude,
      maxDepth: repo.maxDepth,
    });
    skipped.push(...skippedFrom(label, invalid));

    for (const skill of skills) {
      if (needle !== "" && !matches(skill, needle)) continue;
      hits.push({ label, skill });
    }
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        hits.map((hit) => ({
          name: hit.skill.name,
          source: hit.label,
          description: hit.skill.description,
          path: hit.skill.dir,
        })),
        null,
        2,
      )}\n`,
    );
    failOnSkippedSkills(skipped);
    return;
  }

  if (hits.length === 0) {
    info(dim(needle === "" ? "no skills found" : `no skills match "${query}"`));
    failOnSkippedSkills(skipped);
    return;
  }

  heading(`${hits.length} match${hits.length === 1 ? "" : "es"}`);
  const nameWidth = Math.max(...hits.map((hit) => hit.skill.name.length), 4);
  const sourceWidth = Math.max(...hits.map((hit) => hit.label.length), 6);

  for (const hit of hits) {
    const description = opts.all ? hit.skill.description : truncate(hit.skill.description, 90);
    write(
      `  ${bold(hit.skill.name.padEnd(nameWidth))}  ${dim(hit.label.padEnd(sourceWidth))}  ${description}`,
    );
  }

  failOnSkippedSkills(skipped);
}

function matches(skill: DiscoveredSkill, needle: string): boolean {
  return (
    skill.name.toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  );
}

function truncate(text: string, max: number): string {
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length <= max ? firstLine : `${firstLine.slice(0, max - 1)}…`;
}
