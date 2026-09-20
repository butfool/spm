import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Creates a unique temp directory that the OS cleans up. */
export function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Writes a SKILL.md into `<root>/<relDir>/SKILL.md`. */
export function writeSkill(root: string, relDir: string, name: string, description = "d"): string {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return dir;
}

/**
 * Writes literal SKILL.md content into `<root>/<relDir>/SKILL.md`, for fixtures
 * whose frontmatter is meant to be unusable.
 */
export function writeSkillFile(root: string, relDir: string, content: string): string {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
  return dir;
}

/**
 * Points SPM_HOME and HOME at a fresh directory for the duration of a test, so
 * nothing touches the developer's real ~/.config/spm or ~/.agents/skills.
 *
 * HOME matters as well: the global scope treats $HOME as the project root, so
 * `spm add -g` would otherwise link into the real home directory.
 */
export function useTempHome(): { home: string; sources: string } {
  const home = tmpdir("spm-home");
  savedHome = process.env["HOME"];
  process.env["SPM_HOME"] = home;
  process.env["HOME"] = home;
  const sources = path.join(home, "sources");
  fs.mkdirSync(sources, { recursive: true });
  return { home, sources };
}

export function clearHome(): void {
  delete process.env["SPM_HOME"];
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
}

let savedHome: string | undefined;

/** Lists directory entries, sorted, hiding dotfiles. */
export function entries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}
