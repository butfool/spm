import pc from "picocolors";

/** Suppressed by --quiet. Errors and warnings always print. */
let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function info(message: string): void {
  if (!quiet) process.stdout.write(`${message}\n`);
}

export function success(message: string): void {
  if (!quiet) process.stdout.write(`${pc.green("✓")} ${message}\n`);
}

export function skip(message: string): void {
  if (!quiet) process.stdout.write(`${pc.dim("·")} ${pc.dim(message)}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${pc.yellow("!")} ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`${pc.red("✗")} ${message}\n`);
}

export function hint(message: string): void {
  process.stderr.write(`  ${pc.dim(message)}\n`);
}

export function heading(message: string): void {
  if (!quiet) process.stdout.write(`${pc.bold(message)}\n`);
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
