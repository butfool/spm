# spm

> Declarative SKILL.md manager for AI coding agents.

`spm` treats agent skills like dependencies. You declare which ones you want in
a `skills.yaml`, and `spm install` makes the filesystem match — idempotently,
every time.

```
$ spm add anthropics/skills
$ spm i
3 skills → ~/.agents/skills
✓ pdf-fill    linked → ~/.agents/skills/pdf-fill
✓ pdf-extract linked → ~/.agents/skills/pdf-extract
· 1 already up to date
```

There is no database. The state is the manifest plus the symlinks on disk, so
`git diff` shows exactly what a teammate will get.

📄 [`docs/PROMPT.md`](docs/PROMPT.md) is the complete brief this project was built
from — hand it to an AI and it will produce an equivalent tool.

## Install

```bash
git clone <this repo> && cd spm
npm install
npm run build
npm link        # or: npm install -g .
```

## Concepts

**Manifest** — `skills.yaml`, either in a project (alongside `package.json`) or
global at `~/.config/spm/skills.yaml`. `-g` selects the global one.

**Source** — a directory of skills, either a local path or a github repo.
Registering a local source symlinks it into `~/.config/spm/sources/<alias>`;
the source directory itself is never modified. A source may carry a
[`skill-repository.yaml`](#skill-repositoryyaml) naming it and hiding parts of it.

**Skills are leaves.** A directory containing `SKILL.md` *is* a skill, and
discovery stops there — a skill's own `references/` or `scripts/` folders are
content, never skills.

## Commands

| Command | Aliases | What it does |
| --- | --- | --- |
| `spm init [dir]` | | Create a `skills.yaml` |
| `spm add <spec...>` | | Declare skills and install them |
| `spm install [spec...]` | `i` | Restore the manifest; with specs, same as `add` |
| `spm remove <spec...>` | `rm`, `un`, `uninstall` | Drop declarations and unlink |
| `spm list` | `ls` | Show declared skills and whether they're linked |
| `spm find [query]` | | Search every registered source |
| `spm info <spec>` | | Details for one skill |
| `spm doctor [--fix]` | | Check the manifest against disk |
| `spm update [spec...]` | `up` | Re-fetch github sources, then relink |
| `spm source add\|remove\|list\|refresh` | | Manage sources |
| `spm config` | | Show resolved paths and settings |

Useful flags: `-g/--global`, `-f/--force`, `--frozen` (verify without writing),
`--json` on the read-only commands.

### Specifiers

| Form | Meaning |
| --- | --- |
| `alias/skill` | One skill from a registered source |
| `alias` | **Every skill in that source** |
| `alias/*` | Same, but quote it — see below |
| `./path`, `~/path`, `/abs/path` | A local directory (all of it), registered on the fly |
| `owner/repo` | A github repo, all skills |
| `owner/repo/skill` | One skill from a github repo |
| `owner/repo#v1.2.3` | Pin a github repo to a tag or branch |
| `skill-name` | Looked up across every registered source |

**Prefer the bare alias over `alias/*`.** A `*` is expanded by the shell before
spm ever sees it, so `spm add mine/*` in zsh (whose default `nomatch` mode
rejects unmatched globs) fails with `no matches found` — and in a directory
that *does* contain a `mine/` folder, it silently expands to whatever is in
there instead. `spm add mine` needs no quoting and can't be misread.

A bare word is resolved as a source alias first, and only then as a skill name.
So if an alias and a skill elsewhere share a name, the alias wins; the install
output names every skill it expanded, so what happened is never ambiguous.

A bare name that matches in more than one source is an error listing the
candidates, rather than a guess.

## skills.yaml

```yaml
# Where declared skills get linked, relative to this file.
installDirs:
  - .agents/skills
  - .claude/skills

# Where each alias comes from, so a fresh clone can bootstrap with `spm i`.
sources:
  mine:
    path: ~/my-skills
  upstream:
    repo: anthropics/skills
    ref: main

skills:
  - mine/*
  - upstream/pdf-fill
```

`installDirs` is a list because one skill usually needs to be visible to
several agents at once. Every declared skill is linked into every listed
directory.

There is **no version solving**. Skills don't depend on each other, so the
manifest is a flat list; the only reproducibility lever is pinning a github
`ref`.

### skill-repository.yaml

A source may describe itself, so the repository can move without breaking
anything:

```yaml
name: my-skills      # also the default alias when registering
exclude:             # path prefixes hidden from discovery
  - drafts
  - archive
maxDepth: 3
```

Deliberately minimal — no UUIDs, no per-skill identity. Renaming a skill is the
author's problem, not the tool's.

## Configuration

`~/.config/spm/settings.yaml` supplies defaults for manifests that don't
declare their own:

```yaml
installDirs:
  - .agents/skills
  - .claude/skills
sourcesDir: sources
defaultRef: main
```

Set `SPM_HOME` to relocate the whole thing (used by the test suite).

## How reconciliation works

`spm install` computes the target set from the manifest and, for every
`installDir × skill` pair:

- correct symlink already there → untouched
- symlink pointing elsewhere → repointed
- nothing there → created
- **a real file or directory is there** → reported, not clobbered (`--force` overrides)

Then it removes any symlink under an install directory that points into the spm
source cache but is no longer declared. A link you made by hand, pointing at
your own working copy, is outside that rule and is left alone.

That's the whole model: no ref-counting, no ownership table. "Is this link
spm's?" is answered by asking whether its target lives in the source cache.

## When a SKILL.md can't be used

A `SKILL.md` is only a skill when its `name` works as a path segment
(lowercase letters, digits, dots, dashes and underscores, not starting with a
dot) and it carries a `description`, either in frontmatter or as the opening
paragraph of the body. Anything else is **skipped**, and skipping is never
silent:

- every command that discovers skills prints each skipped file and its reason
  to stderr, then exits non-zero. The install itself still runs, so the usable
  part of a repository stays available
- `spm source add` does not report success for a directory that exposes no
  usable skill at all
- `spm doctor` lists every skipped file as an `error`

Those lines go to stderr, so `--json` output on stdout stays parseable and
`--quiet` still explains why a command failed.

## Development

```bash
npm run dev        # run from source via tsx
npm run typecheck  # checks src/ and test/ together
npm test           # vitest
npm run build      # emit to dist/ (src only)
```

Tests write to a temp `SPM_HOME`, never your real one.

Two configs, deliberately split:

- `tsconfig.json` — check-only (`noEmit`), covering `src/` **and** `test/`, so a
  type error in a test is a type error.
- `tsconfig.build.json` — what actually emits, restricted to `src/`.

This project is on **TypeScript 7**, the native compiler. The one thing that
bites on migration: `types` now defaults to `[]` instead of auto-including
every `@types/*` package, so `tsconfig.json` names `["node"]` explicitly.
Omit it and every `process` and `node:fs` reference becomes an error. There is
no "include everything" value — `"*"` isn't it, and unset means none.
Files under `src/` therefore have to `import` what they use rather than lean on
ambient types.
