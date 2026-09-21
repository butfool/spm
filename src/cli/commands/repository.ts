import type { Command } from "commander";
import { expandPath } from "../../config.js";
import { discoverSkills, skippedFrom, type SkippedSkill } from "../../core/discover.js";
import { isDirectory } from "../../fsutil.js";
import { MANIFEST_FILENAME } from "../../core/manifest.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
import {
  declareRepository,
  globalRepositories,
  undeclareRepository,
} from "../../core/registry.js";
import {
  defaultRepositoryName,
  describeLocal,
  listSources,
  localSourcePath,
  registerLocal,
  removeLocalSource,
  type RegisteredSource,
} from "../../core/source.js";
import { SpmError } from "../../errors.js";
import { bold, dim, heading, info, success, warn } from "../../log.js";
import { displayPath } from "../context.js";
import { failOnSkippedSkills } from "../report.js";

/**
 * `spm repository` manages the machine-level registry: the local repositories
 * registered once and reused by every project.
 *
 * Github repositories are absent here on purpose. `owner/name` is already a
 * unique identifier, so there is nothing to register.
 */
export function registerRepositoryCommand(program: Command): void {
  const repository = program
    .command("repository")
    .aliases(["repo"])
    .description("manage the local repositories registered on this machine");

  repository
    .command("add")
    .description("register a local directory holding skills")
    .argument("<path>", "the directory to register")
    .option("-n, --name <name>", "name to register it under")
    .option("-f, --force", "repoint a name that is already taken")
    .action(async (target: string, opts: { name?: string; force?: boolean }) => {
      await repositoryAdd(target, opts);
    });

  repository
    .command("remove")
    .aliases(["rm"])
    .description("unregister a local repository")
    .argument("<name>", "the repository name to forget")
    .action((name: string) => {
      repositoryRemove(name);
    });

  repository
    .command("list")
    .aliases(["ls"])
    .description("list the repositories registered on this machine")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await repositoryList(opts);
    });
}

async function repositoryAdd(
  target: string,
  opts: { name?: string; force?: boolean },
): Promise<void> {
  const abs = expandPath(target, process.cwd());
  if (!isDirectory(abs)) {
    throw new SpmError(`not a directory: ${abs}`);
  }
  const name = opts.name ?? defaultRepositoryName(abs);

  // Discover before registering, so a directory that exposes nothing usable is
  // rejected without leaving a link behind.
  const repo = readRepoManifest(abs);
  const { skills, invalid } = discoverSkills(abs, {
    exclude: repo.exclude,
    maxDepth: repo.maxDepth,
  });
  const skipped = skippedFrom(`local:${name}`, invalid);

  if (skills.length === 0) {
    failOnSkippedSkills(skipped);
    throw new SpmError(
      `${abs} exposes no skills`,
      `No usable SKILL.md was found under ${displayPath(abs)}.`,
    );
  }

  const result = registerLocal(abs, name, opts.force ?? false);
  const declared = declareRepository(name, target);

  const note =
    result.status === "unchanged" ? "(already registered)" : `→ ${displayPath(abs)}`;
  success(`registered ${bold(name)} ${dim(note)}`);
  info(
    `  ${dim(declared ? `recorded in the global ${MANIFEST_FILENAME}` : `already recorded in the global ${MANIFEST_FILENAME}`)}`,
  );
  info(`  ${dim(displayPath(localSourcePath(name)))}`);

  const shown = skills.slice(0, 6).map((skill) => skill.name).join(", ");
  info(
    `  ${dim(`${skills.length} skill${skills.length === 1 ? "" : "s"}`)}` +
      (shown === "" ? "" : dim(`: ${shown}${skills.length > 6 ? ", …" : ""}`)),
  );

  failOnSkippedSkills(skipped);
}

function repositoryRemove(name: string): void {
  const registered = describeLocal(name);
  const declared = globalRepositories().has(name);

  if (!registered && !declared) {
    warn(`local repository "${name}" is not registered`);
    return;
  }

  undeclareRepository(name);
  removeLocalSource(name);

  success(`unregistered ${bold(name)}`);
  if (declared) {
    info(`  ${dim("removed from the global skills.yaml")}`);
  } else {
    info(
      dim(
        `  the global skills.yaml does not declare it — a project that names it will register it again`,
      ),
    );
  }
}

async function repositoryList(opts: { json?: boolean }): Promise<void> {
  const sources = await listSources();

  // A source holding an unusable SKILL.md is reported in both output modes.
  const rows = sources.map((source) => {
    const repo = readRepoManifest(source.path);
    const { skills, invalid } = discoverSkills(source.path, {
      exclude: repo.exclude,
      maxDepth: repo.maxDepth,
    });
    return {
      source,
      count: skills.length,
      skipped: skippedFrom(`${source.kind}:${source.id}`, invalid),
    };
  });
  const skipped: SkippedSkill[] = rows.flatMap((row) => row.skipped);
  const declared = globalRepositories();
  const missing = [...declared.values()].filter(
    (decl) => describeLocal(decl.name) === null,
  );

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          repositories: rows.map((row) => ({
            kind: row.source.kind,
            id: row.source.id,
            path: row.source.path,
            target: row.source.target,
            commit: row.source.commit,
            skills: row.count,
            declared: declared.has(row.source.id),
          })),
          declaredNotRegistered: missing.map((decl) => ({
            name: decl.name,
            path: decl.path,
          })),
        },
        null,
        2,
      )}\n`,
    );
    failOnSkippedSkills(skipped);
    return;
  }

  if (sources.length === 0 && missing.length === 0) {
    info(dim("no repositories registered"));
    info(dim("add one with: spm repository add ./path/to/skills"));
    return;
  }

  if (sources.length > 0) {
    heading(`${sources.length} registered`);
    const width = Math.max(...sources.map((s) => `${s.kind}:${s.id}`.length), 4);

    for (const { source, count } of rows) {
      process.stdout.write(
        `  ${bold(`${source.kind}:${source.id}`.padEnd(width))}  ` +
          `${String(count).padStart(3)} skills  ${where(source)}\n`,
      );
    }
  }

  if (missing.length > 0) {
    info("");
    for (const decl of missing) {
      warn(`"${decl.name}" is declared in the global skills.yaml but not registered`);
      info(`  ${dim(`spm i -g registers it from ${decl.path}`)}`);
    }
  }

  failOnSkippedSkills(skipped);
}

function where(source: RegisteredSource): string {
  if (source.kind === "local") {
    return source.target === null ? "" : displayPath(source.target);
  }
  return `${dim("github")} ${source.commit ?? ""}`.trim();
}
