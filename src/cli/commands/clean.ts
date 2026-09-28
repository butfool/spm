import type { Command } from "commander";
import { cleanSources, type CleanEntry, type CleanResult } from "../../core/clean.js";
import { CliExitError } from "../../errors.js";
import { dim, heading, info, warn } from "../../log.js";
import { displayPath } from "../context.js";

interface CleanOptions {
  dryRun?: boolean;
  json?: boolean;
  dryRunCode?: boolean;
}

export function registerCleanCommand(program: Command): void {
  program
    .command("clean")
    .description("remove source cache entries no manifest uses")
    .option("--dry-run", "show what would be removed without changing anything")
    .option("--json", "machine-readable output")
    .option("--dry-run-code", "preview and exit 1 when removable entries exist")
    .action(async (opts: CleanOptions) => {
      const dryRun = opts.dryRun === true || opts.dryRunCode === true;
      const result = await cleanSources(dryRun);

      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else reportClean(result);

      if (opts.dryRunCode && result.pending > 0) throw new CliExitError(1);
    });
}

function reportClean(result: CleanResult): void {
  heading(`${result.roots.length} manifest root${result.roots.length === 1 ? "" : "s"}`);
  for (const root of result.roots) {
    info(`  ${root.scope.padEnd(7)} ${displayPath(root.path)}`);
  }

  info("");
  if (result.entries.length === 0) {
    info(dim("no source cache entries"));
  } else {
    heading(`${result.entries.length} source cache entr${result.entries.length === 1 ? "y" : "ies"}`);
    const width = Math.max(...result.entries.map((entry) => entry.state.length));
    for (const entry of result.entries) reportEntry(entry, width);
  }

  for (const root of result.danglingRoots) {
    const verb = root.action === "removed" ? "removed" : "would remove";
    info(`  ${verb.padEnd(12)} project root ${displayPath(root.manifestPath)}`);
  }
  for (const root of result.foreignRoots) {
    warn(`foreign entry in the project root registry: ${displayPath(root)}`);
  }

  if (result.unusedRepositories.length > 0 || result.unusedAliases.length > 0) {
    info("");
    heading("unused global declarations");
    for (const repository of result.unusedRepositories) {
      info(`  repository:${repository.name} ${dim(repository.command)}`);
    }
    for (const alias of result.unusedAliases) {
      info(`  alias:${alias.name} ${dim(alias.command)}`);
    }
  }

  info("");
  if (result.pending === 0) {
    info(dim("no unused source cache entries"));
  } else if (result.dryRun) {
    info(dim(`${result.pending} item${result.pending === 1 ? "" : "s"} would be removed`));
  } else {
    info(dim(`${result.pending} item${result.pending === 1 ? "" : "s"} removed`));
  }
}

function reportEntry(entry: CleanEntry, width: number): void {
  const label = `${entry.kind}:${entry.id}`;
  const action = displayAction(entry);
  info(`  ${action.padEnd(Math.max(width, 12))} ${label}`);

  if (entry.state === "broken") {
    warn(`${label} is still declared or referenced, but its source is unavailable`);
  } else if (entry.state === "foreign") {
    warn(`${entry.path} has an unexpected filesystem shape and was preserved`);
  }
}

function displayAction(entry: CleanEntry): string {
  if (entry.action === "would-remove") return "would remove";
  if (entry.action === "removed") return "removed";
  return entry.state;
}
