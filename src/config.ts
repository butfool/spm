import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { SpmError } from "./errors.js";

/**
 * Global configuration, stored at <SPM_HOME>/settings.yaml.
 *
 * `installDirs` is a list because the same skill often needs to be visible to
 * several agents at once (`.agents/skills` for the open convention,
 * `.claude/skills` for Claude Code). Relative entries resolve against $HOME
 * for the global manifest and against the manifest's own directory for a
 * project manifest.
 */
export const SettingsSchema = z.object({
  installDirs: z.array(z.string().min(1)).default([".agents/skills"]),
  /** Where registered sources live, relative to SPM_HOME. */
  sourcesDir: z.string().min(1).default("sources"),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** Absolute path of the spm home directory. Overridable for tests. */
export function spmHome(): string {
  const override = process.env.SPM_HOME;
  if (override && override.length > 0) return path.resolve(override);
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "spm");
}

export function settingsPath(): string {
  return path.join(spmHome(), "settings.yaml");
}

export function globalManifestPath(): string {
  return path.join(spmHome(), "skills.yaml");
}

/** Absolute path of the directory holding all registered sources. */
export function sourcesDir(settings?: Settings): string {
  const s = settings ?? readSettings();
  return path.resolve(spmHome(), s.sourcesDir);
}

export function readSettings(): Settings {
  const file = settingsPath();
  if (!fs.existsSync(file)) return DEFAULT_SETTINGS;

  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (err) {
    throw new SpmError(
      `settings.yaml is not valid YAML: ${(err as Error).message}`,
      `Fix ${file} or delete it to fall back to defaults.`,
    );
  }

  const result = SettingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new SpmError(
      `settings.yaml is invalid: ${z.prettifyError(result.error)}`,
      `Fix ${file} or delete it to fall back to defaults.`,
    );
  }
  return result.data;
}

export function writeSettings(settings: Settings): void {
  ensureHomeDirs();
  fs.writeFileSync(settingsPath(), stringifyYaml(settings, { lineWidth: 0 }), "utf8");
}

/** Creates SPM_HOME and the sources directory if they don't exist yet. */
export function ensureHomeDirs(): void {
  fs.mkdirSync(spmHome(), { recursive: true });
  fs.mkdirSync(sourcesDir(), { recursive: true });
}

/**
 * Expands `~`, `~/x` and relative paths into an absolute path anchored at
 * `baseDir`. Absolute inputs are returned cleaned.
 */
export function expandPath(input: string, baseDir: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(baseDir, trimmed);
}

/**
 * Resolves a manifest's installDirs into absolute paths, preserving order and
 * dropping duplicates. Falls back to the global settings, then to the
 * built-in default, so callers always get at least one directory.
 */
export function resolveInstallDirs(
  declared: string[] | undefined,
  baseDir: string,
): string[] {
  const source =
    declared && declared.length > 0 ? declared : readSettings().installDirs;
  const effective = source.length > 0 ? source : DEFAULT_SETTINGS.installDirs;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of effective) {
    const abs = expandPath(raw, baseDir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
