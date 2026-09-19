import path from "node:path";
import type { Command } from "commander";
import { expandPath, sourcesDir } from "../../config.js";
import { discoverSkills, skippedFrom, type SkippedSkill } from "../../core/discover.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
import { SpmError } from "../../errors.js";
import {
  isRegistered,
  listSources,
  refreshSource,
  registerGithub,
  registerLocal,
  removeSource,
  sourcePath,
} from "../../core/source.js";
import { bold, dim, heading, info, success, warn } from "../../log.js";
import { displayPath, type GlobalOptions } from "../context.js";
import { failOnSkippedSkills } from "../report.js";

export function registerSourceCommand(program: Command): void {
  const source = program.command("source").description("manage skill sources");

  source
    .command("add")
    .description("register a local directory or github repository")
    .argument("<target>", "a local path, or owner/repo")
    .option("-a, --alias <name>", "alias to register it under")
    .option("-r, --ref <ref>", "branch or tag to check out (github only)")
    .option("-f, --force", "repoint an alias that is already taken")
    .action(async (target: string, opts: { alias?: string; ref?: string; force?: boolean }) => {
      await sourceAdd(target, opts);
    });

  source
    .command("remove")
    .aliases(["rm"])
    .description("unregister a source")
    .argument("<alias>", "the alias to unregister")
    .action((alias: string) => {
      if (!isRegistered(alias)) {
        warn(`source "${alias}" is not registered`);
        return;
      }
      const p = sourcePath(alias);
      removeSource(alias);
      success(`unregistered ${bold(alias)}`);
      info(`  ${dim(displayPath(p))}`);
    });

  source
    .command("list")
    .aliases(["ls"])
    .description("list registered sources")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const sources = await listSources();

      // Every source is discovered up front: a source holding an unusable
      // SKILL.md is reported in both output modes.
      const rows = sources.map((entry) => {
        const repo = readRepoManifest(entry.path);
        const { skills, invalid } = discoverSkills(entry.path, {
          exclude: repo.exclude,
          maxDepth: repo.maxDepth,
        });
        return { entry, count: skills.length, skipped: skippedFrom(entry.alias, invalid) };
      });
      const skipped: SkippedSkill[] = rows.flatMap((row) => row.skipped);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(sources, null, 2)}\n`);
        failOnSkippedSkills(skipped);
        return;
      }
      if (sources.length === 0) {
        info(dim("no sources registered"));
        info(dim("add one with: spm source add ./path/to/skills"));
        return;
      }

      heading(`${sources.length} source${sources.length === 1 ? "" : "s"}`);
      const width = Math.max(...sources.map((s) => s.alias.length), 4);

      for (const { entry, count } of rows) {
        const where =
          entry.kind === "local"
            ? displayPath(entry.target ?? entry.path)
            : `${dim("github")} ${entry.commit ?? ""}`.trim();
        process.stdout.write(
          `  ${bold(entry.alias.padEnd(width))}  ${String(count).padStart(3)} skills  ${where}\n`,
        );
      }

      failOnSkippedSkills(skipped);
    });

  source
    .command("refresh")
    .description("re-fetch github sources; local sources need no refresh")
    .argument("[alias]", "refresh only this source")
    .action(async (alias?: string) => {
      const sources = await listSources();
      const targets = alias === undefined ? sources : sources.filter((s) => s.alias === alias);

      if (alias !== undefined && targets.length === 0) {
        throw new Error(`source "${alias}" is not registered`);
      }

      for (const entry of targets) {
        const result = await refreshSource(entry.alias);
        if (result === "local") {
          info(dim(`${entry.alias}: local source, nothing to fetch`));
        } else if (result === "updated") {
          success(`${entry.alias}: fetched`);
        } else {
          warn(`${entry.alias}: missing from ${displayPath(sourcesDir())}`);
        }
      }
    });
}

async function sourceAdd(
  target: string,
  opts: { alias?: string; ref?: string; force?: boolean },
): Promise<void> {
  const looksLikeRepo = /^[\w.-]+\/[\w.-]+$/.test(target) && !target.startsWith(".");

  let alias: string;
  let note: string;

  if (looksLikeRepo) {
    const result = await registerGithub(target, opts.ref, opts.alias, opts.force ?? false);
    alias = result.alias;
    note = `← ${target}${opts.ref !== undefined ? `#${opts.ref}` : ""}`;
  } else {
    const abs = expandPath(target, process.cwd());
    const result = registerLocal(abs, opts.alias, opts.force ?? false);
    alias = result.alias;
    note = result.status === "unchanged" ? "(already registered)" : `→ ${displayPath(abs)}`;
  }

  const repo = readRepoManifest(sourcePath(alias));
  const { skills, invalid } = discoverSkills(sourcePath(alias), {
    exclude: repo.exclude,
    maxDepth: repo.maxDepth,
  });
  const skipped = skippedFrom(alias, invalid);

  // A source that offers nothing usable is a mistake, and it is reported
  // before the command claims success: `registered` plus `0 skills` is a
  // contradiction, not a result.
  if (skills.length === 0) {
    failOnSkippedSkills(skipped);
    throw new SpmError(
      `source "${alias}" exposes no skills`,
      `No usable SKILL.md was found under ${displayPath(sourcePath(alias))}.`,
    );
  }

  success(`registered ${bold(alias)} ${dim(note)}`);
  info(`  ${dim(displayPath(sourcePath(alias)))}`);

  const shown = skills.slice(0, 6).map((s) => s.name).join(", ");
  info(
    `  ${dim(`${skills.length} skill${skills.length === 1 ? "" : "s"}`)}` +
      (shown === "" ? "" : dim(`: ${shown}${skills.length > 6 ? ", …" : ""}`)),
  );

  failOnSkippedSkills(skipped);
}
