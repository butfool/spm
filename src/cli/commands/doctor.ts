import type { Command } from "commander";
import { diagnose, type Issue } from "../../core/doctor.js";
import { installSkills } from "../../core/install.js";
import { dim, heading, info, success, warn } from "../../log.js";
import { renderIssue } from "../render-issue.js";
import { loadManifest, reconcile, scopeFrom, type GlobalOptions } from "../context.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("check the manifest against what's on disk")
    .option("--fix", "apply the repairs spm can make on its own")
    .action(async (opts: { fix?: boolean }, command: Command) => {
      const merged = { ...opts, ...(command.optsWithGlobals() as GlobalOptions) };
      const scope = scopeFrom(merged);
      const { manifest } = loadManifest(scope, true);

      const report = await diagnose(manifest, scope);

      if (report.issues.length === 0) {
        success(
          `healthy — ${report.targets.length} skill${
            report.targets.length === 1 ? "" : "s"
          } across ${report.installDirs.length} install dir${report.installDirs.length === 1 ? "" : "s"}`,
        );
        return;
      }

      const errors = report.issues.filter((i) => i.level === "error");
      const warnings = report.issues.filter((i) => i.level === "warning");

      heading(
        `${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${
          warnings.length === 1 ? "" : "s"
        }`,
      );
      for (const issue of report.issues) renderIssue(issue);

      if (!opts.fix) {
        info("");
        info(dim("run `spm doctor --fix` to apply what spm can repair"));
        failOnInvalidSkills(report.issues);
        return;
      }

      failOnInvalidSkills(await applyFix(manifest, scope));
    });
}

/**
 * The repair is the install pass itself: linking declared skills and pruning
 * undeclared links covers every issue doctor reports except an unreachable
 * source or a real directory squatting on a skill name, which are reported
 * (not silently overwritten) by the reconcile run.
 */
async function applyFix(
  manifest: Parameters<typeof installSkills>[1],
  scope: ReturnType<typeof scopeFrom>,
): Promise<Issue[]> {
  info("");
  heading("applying fixes");

  const { targets } = await reconcile(manifest, scope, { register: true, force: false });
  const result = installSkills(targets, manifest, scope, { force: false, prune: true });

  const changed = result.links.filter(
    (l) => l.action === "created" || l.action === "replaced",
  );
  for (const link of changed) {
    success(`${link.skillName}: ${link.action === "created" ? "linked" : "repointed"}`);
  }
  for (const item of result.removed) {
    success(`removed undeclared link ${item.skillName}`);
  }

  const blocked = result.links.filter((l) => l.action === "blocked");
  for (const link of blocked) {
    warn(`${link.skillName}: ${link.reason ?? "still blocked"}`);
  }

  if (changed.length === 0 && result.removed.length === 0 && blocked.length === 0) {
    info(dim("nothing spm can fix automatically"));
  }

  const after = await diagnose(manifest, scope);
  if (after.issues.length === 0) {
    success("all clear");
  } else {
    warn(`${after.issues.length} issue(s) remain — see above`);
  }
  return after.issues;
}

/**
 * Fails the command when a SKILL.md could not be used.
 *
 * This is the one doctor finding that also decides the exit code: the file has
 * to be fixed by hand, so a run that found one is not a healthy run. The other
 * issue classes keep the exit behaviour they had.
 */
function failOnInvalidSkills(issues: readonly Issue[]): void {
  const invalid = issues.filter((i) => i.kind === "invalid_skill");
  if (invalid.length === 0) return;
  throw new Error(
    `${invalid.length} SKILL.md file${invalid.length === 1 ? "" : "s"} skipped — see above`,
  );
}

export type { Issue };
