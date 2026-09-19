import type { Issue } from "../core/doctor.js";
import { dim, hint, info, warn } from "../log.js";

/**
 * Prints one doctor issue with its suggested remedy.
 *
 * Both lines of an issue go to the same stream. stdout and stderr are buffered
 * separately, so a piped log would otherwise pair a remedy with the wrong
 * message.
 */
export function renderIssue(issue: Issue): void {
  if (issue.level === "error") {
    warn(issue.message);
    if (issue.fix) hint(issue.fix);
    return;
  }
  info(`! ${issue.message}`);
  if (issue.fix) {
    info(`  ${dim(issue.fix)}`);
  }
}
