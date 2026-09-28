import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandPath, globalManifestPath } from "../config.js";
import { SpmError } from "../errors.js";
import { canonical, exists } from "../fsutil.js";
import { parseCoordinate, type Coordinate } from "./coordinate.js";
import { manifestCoordinates, readManifest, type Manifest } from "./manifest.js";
import {
  listProjectRoots,
  removeDanglingProjectRoot,
  type ProjectRoot,
} from "./project-registry.js";
import {
  assertNoProjectAliases,
  declarationConflict,
  repositoryLayers,
} from "./registry.js";
import {
  listCachedSources,
  pathSourceEntry,
  removeCachedSource,
  type CachedSource,
  type CachedSourceKind,
} from "./source.js";

export type CleanEntryState = "referenced" | "declared" | "unused" | "broken" | "foreign";
export type CleanAction = "kept" | "would-remove" | "removed";

export interface CleanRoot {
  path: string;
  scope: "global" | "project";
}

export interface CleanEntry {
  kind: CachedSourceKind;
  id: string;
  path: string;
  target: string | null;
  state: CleanEntryState;
  action: CleanAction;
  references: string[];
  declarations: string[];
}

export interface DanglingRootResult {
  entryPath: string;
  manifestPath: string;
  action: "would-remove" | "removed";
}

export interface UnusedDeclaration {
  name: string;
  target?: string;
  command: string;
}

export interface CleanResult {
  dryRun: boolean;
  roots: CleanRoot[];
  entries: CleanEntry[];
  danglingRoots: DanglingRootResult[];
  foreignRoots: string[];
  unusedRepositories: UnusedDeclaration[];
  unusedAliases: UnusedDeclaration[];
  removed: string[];
  pending: number;
}

interface LoadedRoot extends CleanRoot {
  manifest: Manifest;
  manifestDir: string;
}

interface Marks {
  references: Map<string, Set<string>>;
  declarations: Map<string, Set<string>>;
  usedRepositories: Set<string>;
  usedAliases: Set<string>;
}

/** Analyzes all roots, then removes unreachable managed cache entries. */
export async function cleanSources(dryRun: boolean): Promise<CleanResult> {
  const projectRoots = listProjectRoots();
  const roots = loadRoots(projectRoots.roots);
  const marks = markRoots(roots);
  const cached = await listCachedSources();
  const analyzed = cached.map((source) => ({
    source,
    entry: classifySource(source, marks, dryRun),
  }));
  const entries = analyzed.map(({ entry }) => entry);
  const danglingRoots = projectRoots.roots
    .filter((root) => root.state === "dangling")
    .map((root) => ({
      entryPath: root.entryPath,
      manifestPath: root.manifestPath,
      action: dryRun ? "would-remove" as const : "removed" as const,
    }));

  const unusedRepositories = unusedGlobalRepositories(roots, marks.usedRepositories);
  const unusedAliases = unusedGlobalAliases(roots, marks.usedAliases);
  const pending = entries.filter((entry) => entry.state === "unused").length + danglingRoots.length;

  if (!dryRun) {
    for (const { source, entry } of analyzed) {
      if (entry.state === "unused") removeCachedSource(source);
    }
    for (const root of projectRoots.roots) {
      if (root.state === "dangling") removeDanglingProjectRoot(root);
    }
  }

  return {
    dryRun,
    roots: roots.map(({ path: rootPath, scope }) => ({ path: rootPath, scope })),
    entries,
    danglingRoots,
    foreignRoots: projectRoots.foreign.map((entry) => entry.entryPath),
    unusedRepositories,
    unusedAliases,
    removed: entries
      .filter((entry) => entry.action === "removed")
      .map((entry) => `${entry.kind}:${entry.id}`),
    pending,
  };
}

function loadRoots(projectRoots: ProjectRoot[]): LoadedRoot[] {
  const candidates: CleanRoot[] = [];
  const globalFile = globalManifestPath();
  if (exists(globalFile)) candidates.push({ path: globalFile, scope: "global" });

  for (const root of projectRoots) {
    if (root.state === "live") candidates.push({ path: root.manifestPath, scope: "project" });
  }

  const seen = new Set<string>();
  const loaded: LoadedRoot[] = [];
  for (const candidate of candidates) {
    const rootPath = path.resolve(candidate.path);
    const identity = canonical(rootPath);
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (!fs.existsSync(rootPath)) {
      throw new SpmError(`clean root is unavailable: ${rootPath}`);
    }
    if (!fs.statSync(rootPath).isFile()) {
      throw new SpmError(`clean root is not a file: ${rootPath}`);
    }
    const manifestDir = path.dirname(rootPath);
    const manifest = readManifest(manifestDir);
    if (manifest === null) {
      throw new SpmError(`clean root disappeared while it was being read: ${rootPath}`);
    }
    assertNoProjectAliases(manifest, candidate.scope === "global");

    if (candidate.scope === "project") {
      const layers = repositoryLayers(manifest, manifestDir, false);
      for (const name of Object.keys(manifest.repositories)) {
        const conflict = declarationConflict(name, layers);
        if (conflict === null) continue;
        throw new SpmError(
          `${rootPath} declares local repository "${name}" differently from the global manifest`,
        );
      }
    }

    loaded.push({ ...candidate, path: rootPath, manifest, manifestDir });
  }

  return loaded.sort((a, b) => a.path.localeCompare(b.path));
}

function markRoots(roots: LoadedRoot[]): Marks {
  const references = new Map<string, Set<string>>();
  const declarations = new Map<string, Set<string>>();
  const usedRepositories = new Set<string>();
  const usedAliases = new Set<string>();
  const globalManifest = roots.find((root) => root.scope === "global")?.manifest ?? null;

  for (const root of roots) {
    for (const name of Object.keys(root.manifest.repositories)) {
      addMark(declarations, sourceKey("local", name), root.path);
    }

    const baseDir = root.scope === "global" ? os.homedir() : root.manifestDir;
    for (const coordinate of manifestCoordinates(root.manifest)) {
      markCoordinate(
        coordinate,
        baseDir,
        root,
        globalManifest,
        references,
        usedRepositories,
        usedAliases,
      );
    }
  }

  return { references, declarations, usedRepositories, usedAliases };
}

function markCoordinate(
  coordinate: Coordinate,
  baseDir: string,
  root: LoadedRoot,
  globalManifest: Manifest | null,
  references: Map<string, Set<string>>,
  usedRepositories: Set<string>,
  usedAliases: Set<string>,
): void {
  if (coordinate.type === "local") {
    addMark(references, sourceKey("local", coordinate.repository), root.path);
    const projectOwnsName = root.scope === "project" &&
      root.manifest.repositories[coordinate.repository] !== undefined;
    if (!projectOwnsName && globalManifest?.repositories[coordinate.repository] !== undefined) {
      usedRepositories.add(coordinate.repository);
    }
    return;
  }

  if (coordinate.type === "github") {
    addMark(references, sourceKey("github", coordinate.repository), root.path);
    return;
  }

  if (coordinate.type === "path") {
    const absolute = expandPath(coordinate.dir, baseDir);
    addMark(references, sourceKey("path", path.basename(pathSourceEntry(absolute))), root.path);
    return;
  }

  if (coordinate.type !== "alias") {
    throw new Error(`unsupported coordinate type: ${coordinate.type}`);
  }

  usedAliases.add(coordinate.name);
  const target = globalManifest?.aliases[coordinate.name];
  if (target === undefined) {
    throw new SpmError(
      `${root.path} uses unknown alias "${coordinate.name}"`,
      `Define it with \`spm alias add ${coordinate.name} <skill>\`.`,
    );
  }
  markCoordinate(
    parseCoordinate(target),
    os.homedir(),
    root,
    globalManifest,
    references,
    usedRepositories,
    usedAliases,
  );
}

function classifySource(source: CachedSource, marks: Marks, dryRun: boolean): CleanEntry {
  const key = sourceKey(source.kind, source.id);
  const references = [...(marks.references.get(key) ?? [])].sort();
  const declarations = [...(marks.declarations.get(key) ?? [])].sort();

  let state: CleanEntryState;
  if (!source.managed) state = "foreign";
  else if (!source.healthy && (references.length > 0 || declarations.length > 0)) state = "broken";
  else if (references.length > 0) state = "referenced";
  else if (declarations.length > 0) state = "declared";
  else state = "unused";

  return {
    kind: source.kind,
    id: source.id,
    path: source.path,
    target: source.target,
    state,
    action: state === "unused" ? (dryRun ? "would-remove" : "removed") : "kept",
    references,
    declarations,
  };
}

function unusedGlobalRepositories(
  roots: LoadedRoot[],
  used: Set<string>,
): UnusedDeclaration[] {
  const manifest = roots.find((root) => root.scope === "global")?.manifest;
  if (manifest === undefined) return [];
  return Object.keys(manifest.repositories)
    .filter((name) => !used.has(name))
    .sort()
    .map((name) => ({ name, command: `spm repository remove ${name}` }));
}

function unusedGlobalAliases(roots: LoadedRoot[], used: Set<string>): UnusedDeclaration[] {
  const manifest = roots.find((root) => root.scope === "global")?.manifest;
  if (manifest === undefined) return [];
  return Object.entries(manifest.aliases)
    .filter(([name]) => !used.has(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, target]) => ({ name, target, command: `spm alias remove ${name}` }));
}

function addMark(map: Map<string, Set<string>>, key: string, root: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(root);
  map.set(key, values);
}

function sourceKey(kind: CachedSourceKind, id: string): string {
  return `${kind}:${id}`;
}
