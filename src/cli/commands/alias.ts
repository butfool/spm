import type { Command } from "commander";
import { expandPath } from "../../config.js";
import {
  ALIAS_TYPE,
  COORDINATE_HINT,
  PATH_TYPE,
  formatCoordinate,
  namesWholeRepository,
  readCoordinate,
  validAliasName,
  type Coordinate,
} from "../../core/coordinate.js";
import { MANIFEST_FILENAME } from "../../core/manifest.js";
import {
  declareAlias,
  globalAliases,
  globalRepositories,
  readGlobalManifest,
  undeclareAlias,
} from "../../core/registry.js";
import { resolveSpec, sourceLabel } from "../../core/resolve.js";
import { describeLocal } from "../../core/source.js";
import { SpmError } from "../../errors.js";
import { bold, dim, heading, info, success, warn, write } from "../../log.js";

/**
 * `spm alias` manages the machine-level names for single skills.
 *
 * A name defined here is available to every manifest on this machine, and it
 * installs nothing on its own: what gets installed is decided by each
 * manifest's `skills:` list. That is what makes it usable for a skill that is
 * only named globally and installed per project.
 */
export function registerAliasCommand(program: Command): void {
  const alias = program
    .command("alias")
    .description("manage the single-skill names defined on this machine");

  alias
    .command("add")
    .description("define a name for one skill")
    .argument("<name>", "the name to define")
    .argument(
      "<spec>",
      "the skill it names: path:<dir>, local:<repository>:<skill> or github:<owner>/<repo>:<skill>",
    )
    .action(async (name: string, spec: string) => {
      await aliasAdd(name, spec);
    });

  alias
    .command("remove")
    .aliases(["rm"])
    .description("forget a name")
    .argument("<name>", "the name to remove")
    .action((name: string) => {
      aliasRemove(name);
    });

  alias
    .command("list")
    .aliases(["ls"])
    .description("list the names defined on this machine")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      aliasList(opts);
    });
}

async function aliasAdd(name: string, spec: string): Promise<void> {
  if (!validAliasName(name)) {
    throw new SpmError(
      `"${name}" is not a usable alias name`,
      "Names may contain letters, digits, dots, dashes and underscores, may not start with a dot, and may not be local, github, path or alias.",
    );
  }

  const parsed = readCoordinate(spec);
  if (!parsed.ok) {
    throw new SpmError(`"${spec}" is not a usable alias target: ${parsed.reason}`, COORDINATE_HINT);
  }

  const target = parsed.coordinate;
  if (target.type === ALIAS_TYPE) {
    throw new SpmError(
      `"${spec}" names another alias`,
      "An alias names a skill. Point it at the skill itself.",
    );
  }
  if (namesWholeRepository(target)) {
    throw new SpmError(
      `"${spec}" names a whole repository`,
      "An alias names one skill. Register a repository to name a directory of them.",
    );
  }

  const stored = await checkedTarget(target, spec);
  const recorded = declareAlias(name, stored.target);

  success(
    `${recorded ? "defined" : "already defined"} alias ${bold(name)} → ${stored.target} ${dim(
      `(${sourceLabel("alias", name)})`,
    )}`,
  );
  info(
    `  ${dim(
      recorded
        ? `recorded in the global ${MANIFEST_FILENAME}`
        : `already recorded in the global ${MANIFEST_FILENAME}`,
    )}`,
  );
  if (stored.skill !== null) info(`  ${dim(`skill: ${stored.skill}`)}`);
  info(`  ${dim(`install it with: spm add ${sourceLabel("alias", name)}`)}`);
}

/**
 * Validates a target and returns the form to store.
 *
 * A `path:` target is expanded to an absolute path first: the alias table is
 * machine-level, so a relative value in it resolves against `$HOME`, which is
 * never what somebody typing `./skills/x` meant. The directory is checked the
 * same way an install would check it, so a typo is caught here.
 *
 * A `local:` target must name a repository this machine knows. Its skill is
 * left unchecked: naming a repository before its skills are fetched is a
 * legitimate order of operations, and `spm i` reports what is missing.
 *
 * A `github:` target is taken on faith, because checking it would clone.
 */
async function checkedTarget(
  target: Coordinate,
  spec: string,
): Promise<{ target: string; skill: string | null }> {
  if (target.type === PATH_TYPE) {
    const dir = expandPath(target.dir, process.cwd());
    const selection = await resolveSpec(`path:${dir}`, {
      manifest: null,
      manifestDir: process.cwd(),
      global: false,
      register: false,
    });
    return {
      target: formatCoordinate({ type: PATH_TYPE, dir }),
      skill: selection.skills === "*" ? null : selection.skills[0]!,
    };
  }

  if (target.type === "local") {
    const known =
      globalRepositories().has(target.repository) ||
      describeLocal(target.repository) !== null;
    if (!known) {
      throw new SpmError(
        `"${spec}" names no repository this machine knows`,
        `Register it first: \`spm repository add <path> --name ${target.repository}\`.`,
      );
    }
  }

  return { target: formatCoordinate(target), skill: null };
}

function aliasRemove(name: string): void {
  const manifest = readGlobalManifest();
  const target = manifest?.aliases[name];

  if (target === undefined) {
    warn(`no alias named "${name}"`);
    return;
  }

  // The global manifest can use the alias in its own install list. Removing it
  // then would leave that list unresolvable, so the entry has to go first.
  const used = `alias:${name}`;
  if (manifest!.skills.includes(used)) {
    throw new SpmError(
      `the global ${MANIFEST_FILENAME} installs ${used}`,
      `Drop that declaration first: \`spm rm -g ${used}\`.`,
    );
  }

  undeclareAlias(name);
  success(`forgot alias ${bold(name)} ${dim(`(${target})`)}`);
  info(`  ${dim(`removed from the global ${MANIFEST_FILENAME}`)}`);
  info(
    dim(
      `  a project manifest that uses ${used} will report an unknown alias until it is defined again`,
    ),
  );
}

function aliasList(opts: { json?: boolean }): void {
  const aliases = globalAliases();

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        { aliases: [...aliases.values()].map((a) => ({ name: a.name, target: a.target })) },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (aliases.size === 0) {
    info(dim("no aliases defined"));
    info(dim("define one with: spm alias add <name> path:~/path/to/skill"));
    return;
  }

  heading(`${aliases.size} aliases`);
  const width = Math.max(...[...aliases.keys()].map((name) => name.length), 4);

  for (const alias of aliases.values()) {
    write(`  ${bold(alias.name.padEnd(width))}  ${alias.target}`);
  }
}
