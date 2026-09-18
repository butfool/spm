import type { Command } from "commander";
import { refreshSource, listSources } from "../../core/source.js";
import { dim, info, success, warn } from "../../log.js";
import { loadManifest, scopeFrom, type GlobalOptions } from "../context.js";
import { runAdd } from "./add.js";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .aliases(["up"])
    .description("re-fetch github sources and relink everything")
    .argument("[specs...]", "limit the update to these sources or skills")
    .action(async (specs: string[], opts: GlobalOptions, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest } = loadManifest(scope, true);

      const aliases = await selectAliases(specs, manifest.sources);

      for (const alias of aliases) {
        const result = await refreshSource(alias);
        if (result === "updated") {
          success(`${alias}: fetched`);
        } else if (result === "local") {
          info(dim(`${alias}: local source, nothing to fetch`));
        } else {
          warn(`${alias}: not registered`);
        }
      }

      // Re-linking goes through the same reconciliation `add` uses, with no
      // new specifiers — the manifest is already the source of truth.
      info("");
      await runAdd([], scope, manifest, merged);
    });
}

/** Chooses which sources to refresh: the named ones, or every github source. */
async function selectAliases(
  specs: string[],
  declared: Record<string, unknown>,
): Promise<string[]> {
  if (specs.length > 0) {
    return specs.map((spec) => spec.split("/")[0]!);
  }

  const sources = await listSources();
  return sources
    .filter((s) => s.kind === "github" || declared[s.alias] !== undefined)
    .map((s) => s.alias);
}
