import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/index.js";
import { clearHome, tmpdir, useTempHome, writeSkill } from "./helpers.js";

let home: string;

/** Runs one git subcommand, failing loudly with git's own stderr. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

/**
 * Builds a bare repository holding one commit, so a source cache can be
 * pointed at it without touching the network.
 */
function makeRemote(name: string): { remote: string; work: string } {
  const remote = tmpdir(`spm-${name}-remote`);
  git(remote, "init", "--bare", "--quiet");
  const work = tmpdir(`spm-${name}-work`);
  git(work, "init", "--quiet");
  return { remote, work };
}

/** Commits everything in the working copy. */
function commit(work: string, message: string): void {
  git(work, "add", "-A");
  git(work, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message);
}

/** Commits the working copy and pushes it onto the bare remote. */
function publish(work: string, remote: string, message: string): void {
  commit(work, message);
  git(work, "push", "--quiet", "--force", `file://${remote}`, "HEAD:refs/heads/main");
}

/**
 * Puts a checkout of `remote` where spm looks for a github source cache, so
 * `spm update` finds something to fetch without cloning anything.
 */
function seedCache(repo: string, remote: string): string {
  const dest = path.join(home, "sources", "github", repo);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(path.dirname(dest), "clone", "--quiet", "--depth", "1", `file://${remote}`, dest);
  return dest;
}

async function spm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];

  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

  const savedIsTTY = process.stdin.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = false;

  try {
    const code = await run(["node", "spm", ...args]);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

function writeGlobalManifest(body: string): void {
  fs.writeFileSync(path.join(home, "skills.yaml"), body, "utf8");
}

beforeEach(() => {
  ({ home } = useTempHome());
});

afterEach(() => {
  clearHome();
});

describe("spm update", () => {
  it("reports a dead remote and still refreshes and relinks the others", async () => {
    // A live remote whose cache checkout is one commit behind.
    const { remote, work } = makeRemote("live");
    writeSkill(work, "live-skill", "live-skill", "v1");
    publish(work, remote, "v1");
    const cache = seedCache("owner/live", remote);
    writeSkill(work, "live-skill", "live-skill", "v2");
    publish(work, remote, "v2");

    // A cache whose origin no longer exists, the shape of a deleted repository.
    const broken = tmpdir("spm-broken");
    git(broken, "init", "--quiet");
    writeSkill(broken, "gone-skill", "gone-skill");
    commit(broken, "v1");
    const brokenCache = path.join(home, "sources", "github", "owner/gone");
    fs.mkdirSync(path.dirname(brokenCache), { recursive: true });
    fs.renameSync(broken, brokenCache);
    git(brokenCache, "remote", "add", "origin", `file://${path.join(home, "no-such-remote.git")}`);

    writeGlobalManifest(
      [
        "installDirs:",
        "  - .agents/skills",
        "skills:",
        "  - github:owner/gone:gone-skill",
        "  - github:owner/live:live-skill",
        "",
      ].join("\n"),
    );

    const result = await spm("-g", "update");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("owner/live: fetched");
    expect(result.stderr).toContain("owner/gone:");
    expect(result.stderr).toContain("repository failed to fetch: owner/gone");

    // The live repository really moved to the newer commit.
    expect(fs.readFileSync(path.join(cache, "live-skill", "SKILL.md"), "utf8")).toContain("description: v2");

    // Relinking ran after the failure, for both repositories.
    expect(fs.readdirSync(path.join(home, ".agents", "skills")).sort()).toEqual(["gone-skill", "live-skill"]);
  });

  it("exits zero when every fetch succeeds", async () => {
    const { remote, work } = makeRemote("only");
    writeSkill(work, "only-skill", "only-skill", "v1");
    publish(work, remote, "v1");
    seedCache("owner/only", remote);

    writeGlobalManifest(["installDirs:", "  - .agents/skills", "skills:", "  - github:owner/only:only-skill", ""].join("\n"));

    const result = await spm("-g", "update");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("owner/only: fetched");
    expect(result.stderr).toBe("");
  });
});
