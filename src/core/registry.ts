import os from "node:os";
import path from "node:path";
import { expandPath, isInside, spmHome } from "../config.js";
import { SpmError } from "../errors.js";
import {
  upsertAlias,
  upsertRepository,
  writeManifest,
  readManifest,
  type LocalRepositoryDecl,
  type Manifest,
} from "./manifest.js";

/**
 * A local repository as declared by a manifest, with everything needed to
 * resolve its `path`.
 */
export interface DeclaredLocalRepository {
  name: string;
  /** The path exactly as written in the manifest. */
  path: string;
  /** Directory a relative `path` resolves against. */
  baseDir: string;
  origin: "project" | "global";
}

/**
 * The two places a local repository can be declared.
 *
 * A project manifest carries the repositories only it needs; the global
 * manifest doubles as the machine-level registry, so a repository registered
 * once is usable from every project without being written down again.
 */
export interface RepositoryLayers {
  /** The manifest being operated on. */
  local: Map<string, DeclaredLocalRepository>;
  /** The global manifest. Identical to `local` when the scope is global. */
  global: Map<string, DeclaredLocalRepository>;
}

export function readGlobalManifest(): Manifest | null {
  return readManifest(spmHome());
}

function toMap(
  decls: Record<string, LocalRepositoryDecl>,
  baseDir: string,
  origin: "project" | "global",
): Map<string, DeclaredLocalRepository> {
  return new Map(
    Object.entries(decls).map(([name, decl]) => [
      name,
      { name, path: decl.path, baseDir, origin },
    ]),
  );
}

/**
 * Builds the declaration layers for a scope.
 *
 * The global manifest always resolves relative paths against `$HOME`, because
 * that is the directory its manifest's skills are installed into. A project
 * manifest resolves them against its own directory, so a project moves with
 * the repositories it names.
 */
export function repositoryLayers(
  manifest: Manifest | null,
  manifestDir: string,
  global: boolean,
): RepositoryLayers {
  const globalManifest = readGlobalManifest();
  const globalDecls = globalManifest?.repositories ?? {};

  const localBaseDir = global ? os.homedir() : manifestDir;
  const localDecls = manifest?.repositories ?? {};

  return {
    local: toMap(localDecls, localBaseDir, global ? "global" : "project"),
    global: toMap(globalDecls, os.homedir(), "global"),
  };
}

/**
 * The declaration for `name`, project layer first.
 *
 * A name declared by both layers is not an error here: the project layer is
 * the more specific statement, and `spm doctor` reports the divergence.
 */
export function lookupLocalRepository(
  name: string,
  layers: RepositoryLayers,
): DeclaredLocalRepository | null {
  return layers.local.get(name) ?? layers.global.get(name) ?? null;
}

/** The absolute path a declaration points at. */
export function declarationPath(decl: DeclaredLocalRepository): string {
  return expandPath(decl.path, decl.baseDir);
}

/**
 * The path text to record for a repository at `abs`.
 *
 * The text has to read back as the same directory. A project manifest resolves
 * relative paths against its own directory, which is where the command ran, so
 * what the user typed already reads back correctly. The global manifest
 * resolves them against `$HOME`, which is rarely where the command ran, so
 * there the path is re-expressed against the directory it will be read from.
 */
export function repositoryPathText(
  spec: string,
  abs: string,
  global: boolean,
): string {
  if (!global) return spec;

  const home = os.homedir();
  if (abs === home) return "~";
  if (isInside(abs, home)) return `~/${path.relative(home, abs)}`;
  return abs;
}

/** True when both layers declare `name` at different paths. */
export function declarationConflict(
  name: string,
  layers: RepositoryLayers,
): { local: DeclaredLocalRepository; global: DeclaredLocalRepository } | null {
  const local = layers.local.get(name);
  const global = layers.global.get(name);
  if (!local || !global) return null;
  if (local.origin === "global") return null; // Same file, same statement.
  if (declarationPath(local) === declarationPath(global)) return null;
  return { local, global };
}

/** Every repository name the two layers declare. */
export function declaredNames(layers: RepositoryLayers): Set<string> {
  return new Set([...layers.global.keys(), ...layers.local.keys()]);
}

/**
 * Registers a local repository in the machine-level registry, which is the
 * global manifest. Creates the file when it doesn't exist yet.
 */
export function declareRepository(name: string, path: string): boolean {
  const manifest: Manifest = readGlobalManifest() ?? emptyManifest();

  if (!upsertRepository(manifest, name, { type: "local", path })) return false;
  writeManifest(spmHome(), manifest);
  return true;
}

/** Removes a local repository from the machine-level registry. */
export function undeclareRepository(name: string): boolean {
  const manifest = readGlobalManifest();
  if (manifest === null) return false;
  if (manifest.repositories[name] === undefined) return false;

  delete manifest.repositories[name];
  writeManifest(spmHome(), manifest);
  return true;
}

/** The machine-level registry, as name → declaration. */
export function globalRepositories(): Map<string, DeclaredLocalRepository> {
  const manifest = readGlobalManifest();
  if (manifest === null) return new Map();
  return toMap(manifest.repositories, os.homedir(), "global");
}

/**
 * A machine-level name for one skill, as the global manifest declares it.
 *
 * `baseDir` is always `$HOME`: an alias is a machine-level statement, so a
 * relative `path:` among its targets resolves against `$HOME` just as a
 * repository `path` in the global manifest does.
 */
export interface DeclaredAlias {
  name: string;
  /** The coordinate the alias names, exactly as written. */
  target: string;
  baseDir: string;
}

/** The alias table, as name → declaration. */
export function globalAliases(): Map<string, DeclaredAlias> {
  const manifest = readGlobalManifest();
  if (manifest === null) return new Map();
  return new Map(
    Object.entries(manifest.aliases).map(([name, target]) => [
      name,
      { name, target, baseDir: os.homedir() },
    ]),
  );
}

/** Defines an alias in the global manifest. Returns false when it was already there. */
export function declareAlias(name: string, target: string): boolean {
  const manifest: Manifest = readGlobalManifest() ?? emptyManifest();
  if (!upsertAlias(manifest, name, target)) return false;
  writeManifest(spmHome(), manifest);
  return true;
}

/** Removes an alias from the global manifest. */
export function undeclareAlias(name: string): boolean {
  const manifest = readGlobalManifest();
  if (manifest === null) return false;
  if (manifest.aliases[name] === undefined) return false;

  delete manifest.aliases[name];
  writeManifest(spmHome(), manifest);
  return true;
}

/**
 * The default new global manifest.
 *
 * Kept in one place because every writer has to start from the same shape:
 * building it by hand is how a section such as `aliases:` gets dropped by the
 * next write.
 */
export function emptyManifest(): Manifest {
  return { installDirs: [], repositories: {}, aliases: {}, skills: [] };
}

/** Refuses `aliases:` in a project manifest, which is where it does not belong. */
export function assertNoProjectAliases(manifest: Manifest, global: boolean): void {
  if (global) return;
  const names = Object.keys(manifest.aliases);
  if (names.length === 0) return;

  throw new SpmError(
    `this manifest declares aliases: ${names.join(", ")}`,
    "An alias is a machine-level name, so it belongs in the global skills.yaml. Move it there with `spm alias add`.",
  );
}
