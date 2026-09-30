import { createRequire } from "node:module";
import { Command } from "commander";
import { acquireLock, releaseLock } from "../core/lock.js";
import { CliExitError, SpmError } from "../errors.js";
import { error, hint, setQuiet } from "../log.js";
import { registerAddCommand } from "./commands/add.js";
import { registerAliasCommand } from "./commands/alias.js";
import { registerCleanCommand } from "./commands/clean.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerFindCommand } from "./commands/find.js";
import { registerInfoCommand } from "./commands/info.js";
import { registerInitCommand } from "./commands/init.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerListCommand } from "./commands/list.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerRepositoryCommand } from "./commands/repository.js";
import { registerUpdateCommand } from "./commands/update.js";

/** The published version, so `spm --version` cannot drift from package.json. */
const packageJson = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

/**
 * Commands that write to a manifest, the filesystem, or the source cache.
 * Read-only commands are absent, so they never contend for the write lock.
 */
const MUTATING_COMMANDS = new Set([
  "init",
  "install",
  "add",
  "remove",
  "update",
  "doctor",
  "clean",
  "repository add",
  "repository remove",
  "alias add",
  "alias remove",
]);

/** The space-joined command path, such as `repository add`. */
function commandPath(command: Command): string {
  const parts: string[] = [];
  for (let node: Command | null = command; node?.parent; node = node.parent) {
    parts.unshift(node.name());
  }
  return parts.join(" ");
}

/** Whether running `command` will write anything, given the options it got. */
function writesAnything(command: Command): boolean {
  if (!MUTATING_COMMANDS.has(commandPath(command))) return false;

  const opts = command.opts() as Record<string, unknown>;
  if (command.name() === "install") return opts["frozen"] !== true;
  if (command.name() === "doctor") return opts["fix"] === true;
  if (command.name() === "clean") {
    return opts["dryRun"] !== true && opts["dryRunCode"] !== true;
  }
  return true;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("spm")
    .description("Declarative SKILL.md manager for AI coding agents")
    .version(packageJson.version)
    .option("-g, --global", "operate on the global manifest (~/.config/spm/skills.yaml)")
    .option("-q, --quiet", "only print errors")
    .showSuggestionAfterError()
    .configureHelp({ showGlobalOptions: true });

  program.hook("preAction", (thisCommand, actionCommand) => {
    const opts = thisCommand.optsWithGlobals() as { quiet?: boolean };
    if (opts.quiet) setQuiet(true);
    if (writesAnything(actionCommand)) acquireLock();
  });

  registerInitCommand(program);
  registerInstallCommand(program);
  registerAddCommand(program);
  registerRemoveCommand(program);
  registerListCommand(program);
  registerFindCommand(program);
  registerInfoCommand(program);
  registerRepositoryCommand(program);
  registerAliasCommand(program);
  registerDoctorCommand(program);
  registerUpdateCommand(program);
  registerCleanCommand(program);
  registerConfigCommand(program);

  return program;
}

/** Runs the CLI, turning SpmError into a clean message with a hint. */
export async function run(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CliExitError) return err.code;
    if (err instanceof SpmError) {
      error(err.message);
      if (err.hint) hint(err.hint);
      return 1;
    }
    if (err instanceof Error) {
      error(err.message);
      if (process.env["SPM_DEBUG"]) process.stderr.write(`${err.stack ?? ""}\n`);
      return 1;
    }
    throw err;
  } finally {
    releaseLock();
  }
}
