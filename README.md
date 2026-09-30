# spm

Declarative skill management for AI coding agents.

`spm` keeps the skills used by Claude Code, Codex, Cursor, and other coding
agents in a small `skills.yaml` file. Add a skill once, commit the manifest,
and let every checkout recreate the same symlinks with `spm install`.

```console
$ spm add github:vercel-labs/agent-skills:vercel-react-best-practices
1 skill → .agents/skills
✓ vercel-react-best-practices linked → .agents/skills/vercel-react-best-practices

$ spm install
1 skill → .agents/skills
· 1 already up to date
```

- **Declarative** — `skills.yaml` is the source of truth.
- **Agent-friendly** — install the same skills into one or several agent directories.
- **Local and remote** — use local folders, registered collections, or GitHub repositories.
- **Safe to repeat** — installation is idempotent and preserves unrelated files and links.
- **Easy to inspect** — state lives in YAML manifests and filesystem symlinks, with no database.

## Requirements

- Node.js 20.19 or newer
- Git, when installing skills from GitHub

## Installation

Once the package is published:

```bash
npm install -g @butcool/spm
```

From a checkout:

```bash
git clone https://github.com/butfool/spm.git
cd spm
npm ci
npm run build
npm link
```

Verify the command is available:

```bash
spm --version
```

## Quick start

### Create a project manifest

Run this from the project directory:

```bash
spm init
```

This creates a `skills.yaml` file with `.agents/skills` as the default install
directory.

### Add a skill

Install one skill from GitHub:

```bash
spm add github:owner/repository:skill-name
```

Install every skill from a GitHub repository:

```bash
spm add github:owner/repository:*
```

Install a standalone skill directory from your machine:

```bash
spm add path:~/Code/skills/my-skill
```

`spm add` updates `skills.yaml` and creates the required symlinks immediately.

### Share the manifest

Commit `skills.yaml` with the project. Other contributors can restore the same
skills after cloning:

```bash
spm install
```

> [!TIP]
> Use `spm install --frozen` in continuous integration to verify that every
> declared skill is available and correctly linked without fetching or writing
> anything.

## Using local skill repositories

A local repository is a directory containing one or more skill directories.
Register it once on the machine:

```bash
spm repository add ~/Code/Skills/Obsidian --name Obsidian
```

Search its skills:

```bash
spm find obsidian
```

Add one skill or the complete repository to the current project:

```bash
spm add local:Obsidian:obsidian-tasks
spm add local:Obsidian:*
```

The project manifest stores the repository name. Its filesystem path stays in
the machine-level manifest at `~/.config/spm/skills.yaml`.

> [!NOTE]
> A directory containing `SKILL.md` at its root is a standalone skill. Add it
> with `spm add path:<directory>`. Register its parent directory when the parent
> contains a collection of skills.

## Manifest format

A typical project manifest looks like this:

```yaml
installDirs:
  - .agents/skills
  - .claude/skills

skills:
  - github:vercel-labs/agent-skills:vercel-react-best-practices
  - local:Obsidian:obsidian-tasks
  - path:../shared/skills/team-conventions
```

Every declared skill is linked into every `installDirs` entry. Relative paths
resolve from the directory containing `skills.yaml`.

An install directory must stay inside the directory containing `skills.yaml`;
for the global manifest, inside your home directory. A manifest that points
somewhere else is refused, so a committed `skills.yaml` cannot make `spm install`
write links elsewhere on the machine. An install directory may also not contain,
or sit inside, the source cache.

Projects can also declare a repository that belongs only to that project:

```yaml
installDirs:
  - .agents/skills

repositories:
  shared:
    type: local
    path: ../shared/skills

skills:
  - local:shared:*
```

Running `spm install` creates the repository registration and installs its
skills from this manifest.

## Skill specifiers

| Specifier | Selects |
| --- | --- |
| `github:owner/repository:skill` | One skill from GitHub |
| `github:owner/repository:*` | Every skill from a GitHub repository |
| `local:name:skill` | One skill from a registered local repository |
| `local:name:*` | Every skill from a registered local repository |
| `path:../path/to/skill` | One standalone skill directory |
| `alias:name` | One machine-level skill alias |

The command line also accepts shorter forms:

```bash
spm add owner/repository:skill-name  # GitHub repository
spm add Obsidian:obsidian-tasks      # known local repository
spm add ./skills/my-skill            # local path
spm add skill-name                   # unique match in registered repositories
```

Canonical coordinates are always written to `skills.yaml`, which keeps the
manifest explicit and predictable.

## Common commands

| Command | Description |
| --- | --- |
| `spm init [dir]` | Create a project manifest |
| `spm add <spec...>` | Declare and install skills |
| `spm install` | Restore everything declared by the manifest |
| `spm remove <spec...>` | Remove declarations and their managed links |
| `spm list` | Show declared skills and link status |
| `spm find [query]` | Search registered repositories |
| `spm info <spec>` | Show details for one skill |
| `spm doctor [--fix]` | Diagnose and repair manifest/link problems |
| `spm update [spec...]` | Refresh GitHub repositories and relink skills |
| `spm clean [--dry-run]` | Remove unreferenced source-cache entries |
| `spm repository add\|remove\|list` | Manage local repositories |
| `spm alias add\|remove\|list` | Manage machine-level names for single skills |
| `spm config` | Show resolved configuration and paths |

Useful options:

- `-g, --global` operates on `~/.config/spm/skills.yaml` and installs relative
  to your home directory.
- `-f, --force` replaces a real file or directory that blocks an installation.
- `--no-prune` keeps managed links that the manifest no longer declares.
- `--json` provides machine-readable output on reporting commands.
- `-q, --quiet` prints errors only.

Run `spm <command> --help` for the complete options of a command.

## Global skills and aliases

Install a skill for your user account with the global scope:

```bash
spm add -g github:owner/repository:skill-name
```

With the default configuration, global skills are linked into
`~/.agents/skills`.

Aliases give a standalone skill a reusable machine-level name:

```bash
spm alias add md-lint path:~/Code/md-lint/skills/md-lint
spm add alias:md-lint
```

Aliases define names only. Each project still decides whether to install them
through its own `skills.yaml`.

## Configuration

Optional machine-level defaults live in `~/.config/spm/settings.yaml`:

```yaml
installDirs:
  - .agents/skills
  - .claude/skills
sourcesDir: sources
```

Set `SPM_HOME` to move the complete spm home directory. Without this variable,
spm uses `$XDG_CONFIG_HOME/spm` or `~/.config/spm`.

`sourcesDir` must resolve inside the spm home directory. A settings
`installDirs` value is confined like a manifest's: it must stay inside the tree
of whichever scope reads it, so `spm init` refuses an inherited default that a
project could not install into.

A local repository can include `skill-repository.yaml` at its root:

```yaml
name: my-skills
exclude:
  - drafts
  - archive
maxDepth: 3
```

This file provides the suggested registration name and controls skill
discovery inside that repository.

## Filesystem behavior

`spm install` reconciles every declared skill across every install directory:

- correct symlinks remain unchanged;
- missing symlinks are created;
- incorrect symlinks at declared skill paths are repointed;
- undeclared managed symlinks are removed;
- real files and directories are preserved unless `--force` is provided.

Install directories are confined to the manifest's own tree, and `--force`
never lifts that confinement: it decides whether a blocking entry may be
replaced, not where the install may write.

Commands that write take a machine-level lock at `<SPM_HOME>/.lock` for the
duration of the run, so two spm processes cannot reconcile the same manifests
and cache at once. A lock left behind by a process that has exited is taken
over automatically. Manifests are replaced through a temporary file, so a
reader never sees a half-written file.

`spm doctor` exits non-zero when it reports an error, which is what makes it
usable as a continuous-integration gate. Warnings alone leave the run
successful.

Sources are cached below `~/.config/spm/sources/`. Local source entries are
symlinks to your working directories, so edits become available immediately.
GitHub sources are shallow clones that follow each repository's default branch.

> [!WARNING]
> `--force` can replace an existing real file or directory at a skill install
> path. Review the reported path before using it.

Preview source-cache cleanup before deleting anything:

```bash
spm clean --dry-run
spm clean
```

Cleanup removes cache entries that no live global or project manifest uses. It
never deletes the local directories targeted by `local:` or `path:` sources.

## Valid skills

A discovered skill directory must contain `SKILL.md` with frontmatter similar
to:

```markdown
---
name: my-skill
description: Explain when and how an agent should use this skill.
---

# My skill
```

Skill names may contain lowercase letters, digits, dots, dashes, and
underscores. A skill name cannot begin with a dot. Discovery stops at a skill
directory, so its nested `references/` and `scripts/` directories remain part
of that skill.

Invalid `SKILL.md` files are reported with their paths and reasons. Commands
return a non-zero status so skipped skills remain visible in scripts and
continuous integration.

## Development

```bash
npm run dev -- --help
npm run typecheck
npm test
npm run build
```

Tests use isolated temporary home directories and never write to your real spm
configuration.

The complete design brief and acceptance criteria are available in
[`docs/PROMPT.md`](docs/PROMPT.md).
