# spm

> Declarative SKILL.md manager for AI coding agents.

`spm` treats agent skills like dependencies. You declare which ones you want in
a `skills.yaml`, and `spm install` makes the filesystem match — idempotently,
every time.

```
$ spm repository add ~/Code/Skills/Obsidian --name Obsidian
✓ registered Obsidian → ~/Code/Skills/Obsidian
  recorded in the global skills.yaml
  8 skills: obsidian-icon-config, obsidian-mermaid, obsidian-note-style, …

$ spm add local:Obsidian:*
✓ obsidian-tasks linked → .agents/skills/obsidian-tasks
· 7 already up to date
```

There is no database. The state is the manifests plus the symlinks on disk, so
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

**Repository** — a directory of skills. There are two kinds, and the difference
decides whether it needs registering:

| Kind | Identity | Registered? |
| --- | --- | --- |
| `local` | a directory on this machine, under a name you give it | yes — a path is not an identity |
| `github` | `owner/name` | no — the path already identifies it |

The **global manifest doubles as the machine-level registry**: a local
repository registered once is usable from every project without being written
down again. `spm repository add` writes there; `spm add` writes only the
project manifest. A project that needs a repository nobody else has declares it
in its own `repositories:` section.

Registering a local repository symlinks it into
`~/.config/spm/sources/local/<name>`; the directory itself is never modified. A
github repository is cloned into `~/.config/spm/sources/github/<owner>/<repo>`,
following the remote's default branch, and needs no declaration at all.

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
| `spm find [query]` | | Search every registered repository |
| `spm info <spec>` | | Details for one skill |
| `spm doctor [--fix]` | | Check the manifest against disk |
| `spm update [spec...]` | `up` | Re-fetch github repositories, then relink |
| `spm repository add\|remove\|list` | `repo` | Manage the machine-level registry |
| `spm config` | | Show resolved paths and settings |

Useful flags: `-g/--global`, `-f/--force`, `-n/--name` (the name to register a
local directory under), `--frozen` (verify without writing), `--json` on the
read-only commands.

## Coordinates

A skill is named by three colon-separated segments, the way Gradle names a
dependency:

```
<type>:<repository>:<skill>
```

| Form | Meaning |
| --- | --- |
| `local:mine:pdf-fill` | one skill from a registered local repository |
| `local:mine:*` | every skill in that repository |
| `github:owner/repo:pdf-fill` | one skill from a github repository |
| `github:owner/repo:*` | every skill in that github repository |

The type segment is what keeps the two kinds apart: a repository name can never
contain a slash, so `local:Obsidian:x` and `github:a/b:x` cannot be confused,
and a mistyped type is an error rather than a surprise.

The command line accepts a shortened form, because `owner/repo` carries a slash
a repository name never has, and a bare name is only treated as a repository
when this machine already knows it:

| Input | Resolved as |
| --- | --- |
| `Obsidian:pdf-fill`, `Obsidian:*`, `Obsidian` | local repository (when the name is known) |
| `owner/repo:pdf-fill`, `owner/repo:*`, `owner/repo` | github repository |
| `./path`, `~/path`, `/abs/path` | a local directory, registered on the fly |
| `pdf-fill` | a skill looked up across every registered repository |

Whatever you type, the manifest gets the full three-segment form. A bare skill
name that matches in more than one repository is an error listing the
candidates, rather than a guess.

## skills.yaml

The global manifest, which is also the machine-level registry:

```yaml
repositories:
  Obsidian:
    type: local
    path: ~/Code/Skills/Obsidian
  iWhaleCloud:
    type: local
    path: ~/Code/iWhaleCloud/Skills
```

A project manifest names the skills it wants. Shared repositories are already
registered, so they are not repeated:

```yaml
# Where declared skills get linked, relative to this file.
installDirs:
  - .agents/skills
  - .claude/skills

# Only the repositories this project alone needs.
repositories:
  shared:
    type: local
    path: ../shared/skills

skills:
  - github:vercel-labs/agent-skills:vercel-react-best-practices
  - local:iWhaleCloud:*
  - local:Obsidian:*
  - local:shared:*
```

`installDirs` is a list because one skill usually needs to be visible to
several agents at once. Every declared skill is linked into every listed
directory.

A local `path` resolves against the directory its manifest sits in, so a
project moves together with the repositories it names. `~` expands to `$HOME`.

There is **no version solving**, and no ref pinning: SKILL.md files don't
depend on each other, so the manifest is a flat list, and a github repository
follows its default branch. `spm update` re-fetches it.

### skill-repository.yaml

A repository may describe itself, so a directory can move without breaking
anything:

```yaml
name: my-skills      # also the default name when registering the directory
exclude:             # path prefixes hidden from discovery
  - drafts
  - archive
maxDepth: 3
```

`name` only matters for local repositories. A github repository is identified
by its path, so nothing there is read.

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
- `spm repository add` does not report success for a directory that exposes no
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

Tests write to a temp `SPM_HOME` and `HOME`, never your real ones.

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
