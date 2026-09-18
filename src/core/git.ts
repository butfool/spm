import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SpmError } from "../errors.js";

const execFileAsync = promisify(execFile);

/**
 * Runs a git command, surfacing stderr on failure. Shelling out to git keeps
 * spm free of a git library and inherits the user's credential setup, which
 * matters for private repositories.
 */
async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string };
    if (e.code === "ENOENT") {
      throw new SpmError(
        "git is not installed or not on PATH",
        "Install git to use github sources.",
      );
    }
    const detail = (e.stderr ?? e.message ?? "").trim();
    throw new SpmError(
      `git ${args[0]} failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function isGitAvailable(): boolean {
  return true; // Resolved lazily; a missing git surfaces as SpmError from git().
}

/** Shallow-clones `owner/name` at `ref` into `dest`. */
export async function clone(
  repo: string,
  dest: string,
  ref: string,
): Promise<void> {
  await git([
    "clone",
    "--depth",
    "1",
    "--branch",
    ref,
    "--single-branch",
    githubUrl(repo),
    dest,
  ]);
}

/** Fetches and fast-forwards the checkout in `dir` to the remote `ref`. */
export async function pull(dir: string, ref: string): Promise<void> {
  await git(["fetch", "--depth", "1", "origin", ref], dir);
  await git(["checkout", "--force", "FETCH_HEAD"], dir);
}

/** Current commit SHA of the checkout in `dir`, or null if unavailable. */
export async function currentCommit(dir: string): Promise<string | null> {
  try {
    return await git(["rev-parse", "--short", "HEAD"], dir);
  } catch {
    return null;
  }
}

/** The `origin` remote URL of the checkout in `dir`, or null. */
export async function remoteUrl(dir: string): Promise<string | null> {
  try {
    return await git(["remote", "get-url", "origin"], dir);
  } catch {
    return null;
  }
}

/**
 * Extracts `owner/name` from any of the URL shapes git accepts:
 * https, ssh scp-style, and ssh:// URLs.
 */
export function parseGithubRepo(url: string): string | null {
  const scp = /^[^@/]+@[^:]+:(.+?)(?:\.git)?$/.exec(url);
  if (scp) return cleanRepoPath(scp[1]!);

  try {
    const parsed = new URL(url);
    return cleanRepoPath(parsed.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

function cleanRepoPath(p: string): string | null {
  const trimmed = p.replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? trimmed : null;
}

export function githubUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
