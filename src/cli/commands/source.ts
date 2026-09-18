import path from "node:path";
import type { Command } from "commander";
import { expandPath, sourcesDir } from "../../config.js";
import { discoverSkills } from "../../core/discover.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
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

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(sources, null, 2)}\n`);
        return;
      }
      if (sources.length === 0) {
        info(dim("no sources registered"));
        info(dim("add one with: spm source add ./path/to/skills"));
        return;
      }

      heading(`${sources.length} source${sources.length === 1 ? "" : "s"}`);
      const width = Math.max(...sources.map((s) => s.alias.length), 4);

      for (const entry of sources) {
        const where =
          entry.kind === "local"
            ? displayPath(entry.target ?? entry.path)
            : `${dim("github")} ${entry.commit ?? ""}`.trim();
        const repo = readRepoManifest(entry.path);
        const count = discoverSkills(entry.path, {
          exclude: repo.exclude,
          maxDepth: repo.maxDepth,
        }).length;
        process.stdout.write(
          `  ${bold(entry.alias.padEnd(width))}  ${String(count).padStart(3)} skills  ${where}\n`,
        );
      }
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

  success(`registered ${bold(alias)} ${dim(note)}`);
  info(`  ${dim(displayPath(sourcePath(alias)))}`);

  const repo = readRepoManifest(sourcePath(alias));
  const skills = discoverSkills(sourcePath(alias), {
    exclude: repo.exclude,
    maxDepth: repo.maxDepth,
  });
  const shown = skills.slice(0, 6).map((s) => s.name).join(", ");
  info(
    `  ${dim(`${skills.length} skill${skills.length === 1 ? "" : "s"}`)}` +
      (shown === "" ? "" : dim(`: ${shown}${skills.length > 6 ? ", …" : ""}`)),
  );
}
