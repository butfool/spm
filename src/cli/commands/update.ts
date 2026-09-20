import type { Command } from "commander";
import { tryParseCoordinate, type Coordinate } from "../../core/coordinate.js";
import { discoverSkills } from "../../core/discover.js";
import { readRepoManifest } from "../../core/repo-manifest.js";
import { repositoryLayers } from "../../core/registry.js";
import { isKnownLocal, parseSpecTarget } from "../../core/resolve.js";
import { listSources, refreshGithub } from "../../core/source.js";
import { dim, info, success, warn } from "../../log.js";
import { loadManifest, scopeFrom, type GlobalOptions } from "../context.js";
import { runAdd } from "./add.js";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .aliases(["up"])
    .description("re-fetch the github repositories this manifest uses, then relink")
    .argument("[specs...]", "limit the update to these repositories or skills")
    .action(async (specs: string[], opts: GlobalOptions, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest } = loadManifest(scope, true);

      for (const repo of await selectGithubRepositories(specs, manifest, scope)) {
        const result = await refreshGithub(repo);
        if (result === "updated") {
          success(`${repo}: fetched`);
        } else {
          warn(`${repo}: not cloned on this machine`);
        }
      }

      // Re-linking goes through the same reconciliation `add` uses, with no
      // new specifiers — the manifest is already the source of truth.
      info("");
      await runAdd([], scope, manifest, merged);
    });
}

/**
 * Chooses which github repositories to refresh.
 *
 * With no specifiers, every github repository the manifest uses. Local
 * repositories have nothing to fetch, so naming one reports that instead of
 * failing.
 */
async function selectGithubRepositories(
  specs: string[],
  manifest: Parameters<typeof runAdd>[2],
  scope: ReturnType<typeof scopeFrom>,
): Promise<string[]> {
  const layers = repositoryLayers(manifest, scope.manifestDir, scope.kind === "global");

  if (specs.length === 0) {
    const repos = new Set(
      manifest.skills
        .map((entry) => tryParseCoordinate(entry))
        .filter((coordinate): coordinate is Coordinate => coordinate !== null)
        .filter((coordinate) => coordinate.type === "github")
        .map((coordinate) => coordinate.repository),
    );
    return [...repos].sort();
  }

  const wanted = new Set<string>();
  for (const spec of specs) {
    const target = parseSpecTarget(spec, (name) => isKnownLocal(name, layers));

    if (target.kind === "coordinate") {
      if (target.coordinate.type === "github") {
        wanted.add(target.coordinate.repository);
      } else {
        info(dim(`${spec}: local repository, nothing to fetch`));
      }
      continue;
    }

    if (target.kind === "path") {
      info(dim(`${spec}: local directory, nothing to fetch`));
      continue;
    }

    const repos = await githubRepositoriesProviding(target.name);
    if (repos.length === 0) {
      warn(`"${spec}" is not provided by any github repository`);
      continue;
    }
    for (const repo of repos) wanted.add(repo);
  }

  return [...wanted].sort();
}

/** The github repositories holding a skill with this name. */
async function githubRepositoriesProviding(name: string): Promise<string[]> {
  const repos: string[] = [];

  for (const source of await listSources()) {
    if (source.kind !== "github") continue;
    const repo = readRepoManifest(source.path);
    const { skills } = discoverSkills(source.path, {
      exclude: repo.exclude,
      maxDepth: repo.maxDepth,
    });
    if (skills.some((skill) => skill.name === name)) repos.push(source.id);
  }

  return repos;
}
