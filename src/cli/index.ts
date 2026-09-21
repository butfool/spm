import { Command } from "commander";
import { SpmError } from "../errors.js";
import { error, hint, setQuiet } from "../log.js";
import { registerAddCommand } from "./commands/add.js";
import { registerAliasCommand } from "./commands/alias.js";
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

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("spm")
    .description("Declarative SKILL.md manager for AI coding agents")
    .version("0.1.0")
    .option("-g, --global", "operate on the global manifest (~/.config/spm/skills.yaml)")
    .option("-q, --quiet", "only print errors")
    .showSuggestionAfterError()
    .configureHelp({ showGlobalOptions: true });

  program.hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals() as { quiet?: boolean };
    if (opts.quiet) setQuiet(true);
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
  }
}
