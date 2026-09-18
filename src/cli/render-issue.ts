import type { Issue } from "../core/doctor.js";
import { dim, info, warn } from "../log.js";

/** Prints one doctor issue with its suggested remedy. */
export function renderIssue(issue: Issue): void {
  if (issue.level === "error") {
    warn(issue.message);
  } else {
    info(`! ${issue.message}`);
  }
  if (issue.fix) {
    info(`  ${dim(issue.fix)}`);
  }
}
