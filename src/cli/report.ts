import { skippedLine, type SkippedSkill } from "../core/discover.js";
import type { LinkResult } from "../core/install.js";
import { SpmError } from "../errors.js";
import { cyan, dim, heading, info, skip, success, warn } from "../log.js";
import { displayPath, relativeTo } from "./context.js";

/** Renders the outcome of one install pass. */
export function report(
  links: LinkResult[],
  removed: { skillName: string; linkPath: string }[],
  skillCount: number,
  installDirs: string[],
  manifestDir: string,
): void {
  const blocked = links.filter((l) => l.action === "blocked");
  const changed = links.filter((l) => l.action === "created" || l.action === "replaced");
  const unchanged = links.filter((l) => l.action === "unchanged");

  heading(
    `${skillCount} skill${skillCount === 1 ? "" : "s"} → ${installDirs
      .map((d) => displayPath(d))
      .join(", ")}`,
  );

  for (const link of changed) {
    const verb = link.action === "created" ? "linked" : "repointed";
    success(`${link.skillName} ${dim(verb)} → ${displayPath(link.linkPath)}`);
  }

  if (unchanged.length > 0) {
    skip(`${unchanged.length} already up to date`);
  }

  for (const item of removed) {
    warn(`removed undeclared link ${relativeTo(manifestDir, item.linkPath)}`);
  }

  for (const link of blocked) {
    warn(`${link.skillName}: ${link.reason ?? "could not link"}`);
    info(`  ${dim(cyan(link.linkPath))}`);
  }
}

/**
 * Prints every SKILL.md discovery skipped and fails the command.
 *
 * The lines go to stderr, so `--json` output on stdout stays parseable, and
 * the failure is thrown rather than returned, so `run()` prints it and exits
 * non-zero.
 */
export function failOnSkippedSkills(skipped: readonly SkippedSkill[]): void {
  if (skipped.length === 0) return;
  for (const item of skipped) warn(skippedLine(item));
  throw new SpmError(
    `${skipped.length} SKILL.md file${skipped.length === 1 ? "" : "s"} skipped — see above`,
  );
}
