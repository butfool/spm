import fs from "node:fs";
import path from "node:path";
import { spmHome } from "../config.js";
import { SpmError } from "../errors.js";

/**
 * The machine-level write lock.
 *
 * Two spm processes reconciling the same manifests and source cache at once
 * would race: one could unlink a link the other just created, and a
 * read-modify-write of a manifest could drop the other's change. The lock is
 * one file holding the owner's pid, so a process that died without releasing
 * it is taken over rather than blocking the machine forever.
 */
let held: string | null = null;

function lockFile(): string {
  return path.join(spmHome(), ".lock");
}

/** Takes the write lock, or reports that another process holds it. */
export function acquireLock(): void {
  if (held !== null) return; // Already held by this process.

  const file = lockFile();
  fs.mkdirSync(spmHome(), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      held = file;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === 0 && isStale(file)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      throw new SpmError(
        "another spm process is writing to this machine's configuration",
        `Wait for it to finish, or delete ${file} if no spm is running.`,
      );
    }
  }
}

/** Releases the write lock. Safe to call when nothing is held. */
export function releaseLock(): void {
  if (held === null) return;
  try {
    fs.rmSync(held, { force: true });
  } catch {
    // A lock that cannot be removed is still reclaimed by the stale check.
  }
  held = null;
}

/** Whether the pid in `file` is gone, so the lock may be taken over. */
function isStale(file: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;

  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // ESRCH means no such process; EPERM means it lives under another user.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
