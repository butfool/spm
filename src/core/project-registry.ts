import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectsDir } from "../config.js";
import { canonical, ensureSymlink, isSymlink, readLink } from "../fsutil.js";
import { MANIFEST_FILENAME, manifestPath } from "./manifest.js";

export interface ProjectRoot {
  entryPath: string;
  manifestPath: string;
  state: "live" | "dangling";
}

export interface ForeignProjectRoot {
  entryPath: string;
}

export interface ProjectRoots {
  roots: ProjectRoot[];
  foreign: ForeignProjectRoot[];
}

/** Records one project manifest as a machine-level clean root. */
export function registerProjectManifest(manifestDir: string): void {
  const file = manifestPath(manifestDir);
  if (!fs.existsSync(file)) return;

  const target = path.join(canonical(manifestDir), MANIFEST_FILENAME);
  const key = createHash("sha256").update(target).digest("hex").slice(0, 16);
  fs.mkdirSync(projectsDir(), { recursive: true });
  ensureSymlink(target, path.join(projectsDir(), key));
}

/** Lists project roots without following foreign entries in the registry. */
export function listProjectRoots(): ProjectRoots {
  const roots: ProjectRoot[] = [];
  const foreign: ForeignProjectRoot[] = [];

  for (const name of readNames(projectsDir())) {
    const entryPath = path.join(projectsDir(), name);
    if (!isSymlink(entryPath)) {
      foreign.push({ entryPath });
      continue;
    }

    const target = readLink(entryPath)!;
    if (path.basename(target) !== MANIFEST_FILENAME) {
      foreign.push({ entryPath });
      continue;
    }
    roots.push({
      entryPath,
      manifestPath: target,
      state: fs.existsSync(target) ? "live" : "dangling",
    });
  }

  return { roots, foreign };
}

/** Removes a dangling registry symlink after rechecking its ownership and state. */
export function removeDanglingProjectRoot(root: ProjectRoot): void {
  if (root.state !== "dangling") {
    throw new Error(`refusing to remove live project root ${root.entryPath}`);
  }
  if (path.dirname(path.resolve(root.entryPath)) !== path.resolve(projectsDir())) {
    throw new Error(`project root is outside the registry: ${root.entryPath}`);
  }
  if (!isSymlink(root.entryPath)) {
    throw new Error(`project root is no longer a symlink: ${root.entryPath}`);
  }
  if (fs.existsSync(root.manifestPath)) {
    throw new Error(`project root is no longer dangling: ${root.entryPath}`);
  }
  fs.unlinkSync(root.entryPath);
}

function readNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}
