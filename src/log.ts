import pc from "picocolors";

/** Suppressed by --quiet. Errors and warnings always print. */
let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

/** An SGR sequence, the only escape form that survives sanitising. */
const SGR = /^\u001b\[[0-9;?]*m$/;

/**
 * Every terminal control sequence, matched in one pass.
 *
 * They are matched together on purpose: stripping them in successive passes
 * would re-scan an SGR code that an earlier pass had just reinserted, and the
 * later pass would delete it. Matching together also leaves our own styling in
 * place, because `replace` skips past a match it kept.
 */
const TERMINAL_CONTROL =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[\s\S]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Removes terminal control sequences from text that may come from a skill
 * repository, keeping the SGR codes picocolors writes so our own styling
 * survives.
 *
 * A crafted SKILL.md must not be able to move the cursor, erase a line, or set
 * the window title: `spm find` printing a skill description that clears the
 * line and paints a fake `✓` is output spoofing, not styling.
 */
export function sanitize(message: string): string {
  return message.replace(TERMINAL_CONTROL, (seq) => (SGR.test(seq) ? seq : ""));
}

/** Writes one sanitized line to stdout, regardless of --quiet. */
export function write(message: string): void {
  process.stdout.write(`${sanitize(message)}\n`);
}

export function info(message: string): void {
  if (!quiet) write(message);
}

export function success(message: string): void {
  if (!quiet) write(`${pc.green("✓")} ${message}`);
}

export function skip(message: string): void {
  if (!quiet) write(`${pc.dim("·")} ${pc.dim(message)}`);
}

export function warn(message: string): void {
  process.stderr.write(`${sanitize(`${pc.yellow("!")} ${message}`)}\n`);
}

export function error(message: string): void {
  process.stderr.write(`${sanitize(`${pc.red("✗")} ${message}`)}\n`);
}

export function hint(message: string): void {
  process.stderr.write(`${sanitize(`  ${pc.dim(message)}`)}\n`);
}

export function heading(message: string): void {
  if (!quiet) write(pc.bold(message));
}

/** Right-aligns nothing, but keeps column output readable. */
export function dim(message: string): string {
  return pc.dim(message);
}

export function bold(message: string): string {
  return pc.bold(message);
}

export function cyan(message: string): string {
  return pc.cyan(message);
}
