# 问题

**主问题**：在「一个机器级共享存储 + 多份项目清单」的结构下，常见包管理器用什么模式判定存储中哪些条目已无人使用？哪一种模式与 spm 的既有结构相容？

**子问题**：

1. 存在哪些模式？每种模式的判定依据与根集合来源是什么？
2. 每种模式的前提条件、失效方式与适用范围是什么？
3. 哪些模式需要新增机器级状态，哪些不需要？

本调研只使用外部公开资料。spm 自身的代码与清单事实来自本 Task 的 Background 与 `docs/PROMPT.md`；对 spm 内部实现的逐行核对属于 `specool-explore` 的范围。

# 结论

1. **可靠地判定「无人使用」只有一族做法：以显式可枚举的根集合做可达性标记，再清扫未标记项。** 属于这一族的有 pnpm[^7][^8]、Nix[^16][^17]、Guix[^18]、mise[^19]、uv[^24]、Spack[^21][^22]。它们之间的差别只在「根集合从哪里来」。
2. **根集合的来源有四种**，代价与前提条件各不相同：触碰时写入的登记处、中心目录即登记处、每项一个显式请求标记、物理引用计数。见「来源分析」中的对照表。
3. **时间戳只能当宽限期，不能当判定依据。** Gradle 能用时间戳，前提是它自己记录访问[^9][^10]；NuGet 的官方文档写明了这条路的失效方式——项目 restore 输入不变时时间戳不更新，仍在使用的包会看起来像没人用，并建议「等几天」再清理[^12]；Maven 的 MNG-7389 记录了文件系统 `atime` 在 CI 上不可用的实测结论[^14]。
4. **没有任何一个包管理器会自动删除「声明」。** npm、bun、Gradle 清扫的全部是可重建的缓存，声明（`package.json`、`bun.lock`、锁文件）由项目级命令维护，全局命令从不擅自改动[^1][^4][^10]。
5. **不使用任何根集合时，唯一能判定的是「条目自身的指向已经不存在」**（断链、目标目录已被删除）。`github:` 与 `path:` 条目按设计从不登记，所以「没有声明」是它们的正常状态，靠全局清单无法判定它们是否有人使用。
6. **与 spm 结构最接近的是 mise 的模型**：记录被读取过的配置文件，再清扫未被任何已记录配置引用的条目[^19]。spm 的项目清单就是这类配置文件，而 spm 每次在项目内运行命令时都会读取它。

# 来源分析

## 模式一：全部清除（不做判定）

工具放弃判定，只提供核弹。`yarn cache clean`（Remove the shared cache files）、`go clean -modcache`、`pip cache purge`、`bun pm cache rm`、`dotnet nuget locals all --clear`、`npm cache clean --force`。

NuGet 的官方文档直说清完之后「you will need to restore your projects again to redownload all required packages」[^12]。bun 的 `bun prune` 文档也明确写「To clean the global cache instead, use `bun pm cache rm`」，并注明 `--global` 不受支持[^4][^6]。bun 的全局缓存位于 `~/.bun/install/cache`，条目按 `${name}@${version}` 命名，因此同一个包的多个版本可以并存，而清理只能整体执行[^5]。

判定依据：无。根集合来源：无。需要新增机器级状态：否。

## 模式二：项目内可达性

根集合就是当前这一份清单或锁文件，清扫范围限于该项目的安装目录。

- `npm prune`：「Extraneous packages are those present in the `node_modules` folder that are **not listed as any package's dependency list**」，并带有 `--dry-run` 与 `--json`。官方说明「In normal operation, extraneous modules are pruned automatically」[^1]。
- `bun prune`：「deletes everything in `node_modules` that the current `bun.lock` would not install: packages left behind after switching branches, removing a dependency, or installing with another package manager」，并明确列出不删除的对象：workspace 目录、仍在使用的 `.bin` 条目、`.cache` 这类点目录、普通文件，以及 `node_modules` 之外的一切[^4]。

这一族的算法与 spm 现有的链接 prune 判据一致，作用域只到项目内部，永不触碰机器级存储[^1][^4]。spm 已经具备这一层。

## 模式三：缓存自索引孤儿

根集合是缓存自身的索引，清扫对象是索引之外的数据。

npm 的缓存由 `cacache` 实现，是带索引的内容寻址缓存：`ls` 列出的是「keyed by the unique index key」的条目，特性列表包含「Garbage collection and additional offline verification」[^3]。`npm cache verify` 的职责是「Verify the contents of the cache folder, **garbage collecting any unneeded data**, and verifying the integrity of the cache index and all cached data」[^2]。npm 官方对 `npm cache clean` 的说明是「this is typically unnecessary, as npm's cache is self-healing and resistant to data corruption issues」[^2]。

判定依据与「哪个项目在用」无关，只与缓存自身的一致性有关[^2][^3]。

## 模式四：最后访问时间 TTL

根集合不存在，用条目的最后访问时间作代理。

- **Gradle**：「Gradle tracks which artifacts in the dependency cache are accessed. Based on this information, the cache is periodically scanned (no more than once every 24 hours) to identify artifacts that haven't been used in over 30 days.」[^9]。缓存里存在 `gc.properties` 文件承载这套记账，官方提示复制缓存时「Do not copy the `*.lock` or `gc.properties` files if they exist」[^9]。保留期分六类且可配置：released wrapper distributions 默认 30 天、snapshot wrapper distributions 默认 7 天、downloaded resources 默认 30 天、created resources 默认 7 天、build cache 默认 7 天、daemon logs 默认 14 天，通过 [`setRemoveUnusedEntriesAfterDays`](https://docs.gradle.org/current/kotlin-dsl/gradle/org.gradle.api.cache/-cache-resource-configuration/set-remove-unused-entries-after-days.html) 调整[^10][^11]。清理频率有三档：DEFAULT（后台每 24 小时）、DISABLED、ALWAYS（每次构建会话结束时）[^10]。
- **NuGet**：官方文档把这套做法写成两步。第一步启用 `updatePackageLastAccessTime`，「This setting will cause NuGet to update each package's `.nupkg.metadata` file when it is used in a restore」；紧接着写明失效方式——「When restore runs, but a project is considered already up to date, the package timestamps are **not** updated, so if a project's restore inputs don't change for several weeks, the `.nupkg.metadata` files will not have their timestamps updated」；第二步是「run a tool to perform the cleanup」，并说明「At this time, NuGet does not provide a tool or command to do this」，同时建议启用后「waiting a few days to make sure that all the packages you use regularly have had their timestamps updated」[^12]。NuGet 的配置项 `updatePackageLastAccessTime` 与开放的 CLI 需求见 [NuGet/Home#15000](https://github.com/NuGet/Home/issues/15000)[^13]。
- **Maven**：MNG-7389 记录了两次尝试——先试「last-accessed file timestamp」，结论是「turns out most CI filesystems are mounted without that option」，于是改用「instrumentation to record artifact access, then delete the artifacts not recorded」[^14]。

三个案例的共同点：**时间戳必须由工具自己记录，不能依赖文件系统的 `atime`**[^9][^12][^14]。

## 模式五：机器级根登记 + 可达性

这一族的判定依据统一为「从根集合出发的可达性」，差别在根集合的来源。

**5 a 触碰时写入的登记处**

- **pnpm**：项目使用 store 时被自动登记。「Projects using the store are now registered via symlinks in `{storeDir}/v10/projects/`. This enables `pnpm store prune` to track which packages are still in use by active projects and safely remove unused packages from the global virtual store.」算法三步：「1. Scans all registered projects for symlinks pointing to the store 2. Walks transitive dependencies to mark reachable packages 3. Removes any package directories not marked as reachable」，并明确覆盖 monorepo：「all `node_modules` directories within a project (including those in workspace packages) are scanned」[^8]。当前文档写作 `{storeDir}/v11/projects/`[^7]。
- **mise**：「mise tracks which config files have been used in `~/.local/state/mise/tracked-configs`. Versions which are no longer the latest specified in any of those configs are deleted.」另有 `~/.local/state/mise/tracked-stubs` 记录被执行过的 stub，被引用的版本不删。提供 `mise ls --prunable` 查询、`-n --dry-run` 预演，以及 `--dry-run-code`（有待清理项时退出码为 1）。另有 `--configs` 专门清理「tracked and trusted configuration links that point to nonexistent configurations」[^19]。
- **Nix**：根是 `prefix/nix/var/nix/gcroots` 下的符号链接，「Subdirectories of `prefix/nix/var/nix/gcroots` are searched recursively. Symlinks to store paths count as roots. **Symlinks to non-store paths are ignored**, unless the non-store path is itself a symlink to a store path.」[^17]。`nix-store --gc` 删除「all paths in the Nix store not reachable via file system references from a set of "roots"」，并提供 `--print-roots`、`--print-live`、`--print-dead` 三个查询开关[^16]。登记根的方式是 `--add-root`，它在目标位置建一个符号链接，并在 `/nix/var/nix/gcroots/auto/` 下建一个唯一命名的符号链接；**当用户删掉自己的那个链接后，`auto` 目录里的根变成悬挂符号链接，并被收集器忽略**。文档同时提示「it is not possible to move or rename GC roots, since the symlink in the `auto` directory will still point to the old location」[^16]。
- **Guix**：「The garbage collector has a set of known _roots_: any file under /gnu/store reachable from a root is considered _live_ and cannot be deleted; any other file is considered _dead_ and may be deleted.」根由 `/var/guix/gcroots` 下的符号链接表示，`guix gc --list-roots` 列出它们，另有 `--list-dead`、`--list-live`、`--references`、`--referrers`、`--requisites` 查询引用图。`--list-busy` 把「store items in use by currently running processes」也当作根。删除旧的 profile generation 用 `--delete-generations[=duration]` 在收集前执行。文档称「It is perfectly safe to run as a non-interactive periodic job」[^18]。需要注意 Guix 使用 sqlite 数据库记录 store 条目[^18]。

**5 b 中心目录即登记处**

前提是这些实体本来就集中存放。

- **Spack**：「By default, all managed environments are stored in the `$SPACK_ROOT/var/spack/environments` folder.」[^22]。根就是这些环境，`spack gc --except-any-environment` 的语义是「remove everything unless needed by an environment」，文档说明它「will find and uninstall any package versions that are no longer referenced by _any_ of your environments」。删除环境用 `spack env rm`，并明确「the packages that were installed for it remain in the Spack store. To actually remove the installations from the Spack store and free up disk space, you can run the garbage collector again」[^21]。
- **Gradle** 的版本维度同理：`caches/<GRADLE_VERSION>/` 下的版本专属缓存「are checked for whether they are still in use」，不再使用时 release 版本 30 天后删除、snapshot 版本 7 天后删除；`caches/` 下的共享缓存（例如 `jars-*`）「are checked for whether they are still in use. If no Gradle version still uses them, they are deleted」；`wrapper/dists/` 里的发行版「are checked for whether they are still in use, i.e., whether there's a corresponding version-specific cache directory」[^10]。
- **uv**：`uv cache prune` 「removes all _unused_ cache entries and all centralized project environments」，并说明「Centralized project environments are recreated as needed. `uv cache prune` is safe to run periodically」。另有面向 CI 的 `uv cache prune --ci`，删除预构建 wheel 与解压后的源码分发，保留由源码构建出的 wheel[^24]。

**5 c 每项一个显式请求标记**

- **Homebrew**：`brew autoremove` 「Uninstall formulae that were only installed as a dependency of another formula and are now no longer needed」，并带 `-n/--dry-run`。根标记存放在已安装条目的 tab 里，用 `brew tab --installed-on-request` / `--no-installed-on-request` 修改，官方说明其用途是「control whether an installed formula should be removed by `brew autoremove`」。查询用 `brew list --installed-on-request` / `--no-installed-on-request`。另有 `HOMEBREW_NO_CLEANUP_FORMULAE` 白名单与 `HOMEBREW_NO_AUTOREMOVE` 开关[^23]。

这一变体适用于「机器上只有一个全局作用域」的结构，此时「被显式请求过」这一位标记就足以充当根集合。

**5 d 物理引用计数**

- **conda**：`conda clean --packages` 「Remove unused packages from writable package caches」，官方同时警告「This does not check for packages installed using symlinks back to the package cache」；`-f/--force-pkgs-dirs` 会「Remove _all_ writable package caches」，并警告「This will break environments with packages installed using symlinks back to the package cache」。conda 提供 `-d/--dry-run` 与 `-y/--yes`[^20]。conda 判定「unused」的具体机制（统计硬链接数）见于社区资料，官方文档只给出上述关于符号链接的警告[^20][^27]。

## 模式六：不做

- **Maven**：全局 `~/.m2/repository` 没有任何内置清理。MNG-7389 的正文写道「Maven's local repository grows indefinitely on long-running CI runners, and there's no built-in way to expire artifacts that aren't needed anymore」，其提议的方案是定义一次「transaction」：「1. run command to mark start of transaction 2. run one or more maven commands 3. run command to mark end of transaction, deleting artifacts not in use」[^14]。官方插件里只有 `dependency:purge-local-repository`，其默认行为是「first resolve the entire dependency tree, then delete the contents from the local repository, and then re-resolve the dependencies from the remote repository」——先删再补，与判定后清扫无关[^15]。

## 对照表

| 模式 | 判定依据 | 根集合来源 | 代表实现 | 需要新增机器级状态 |
| --- | --- | --- | --- | --- |
| 全部清除 | 无 | 无 | yarn、Go、pip、bun、NuGet、npm | 否 |
| 项目内可达性 | 当前清单或锁文件的依赖图 | 单份清单 | npm prune、bun prune | 否 |
| 缓存自索引孤儿 | 缓存自身索引的一致性 | 缓存索引 | npm cache verify（cacache） | 否 |
| 最后访问时间 TTL | 条目最后访问时间 | 无 | Gradle 缓存内容、NuGet、cargo-cache | 是（访问记录） |
| 机器级根登记 + 可达性 | 从根集合出发的可达性 | 登记处 | pnpm、Nix、Guix、mise、uv、Spack、conda | 是 |
| 不做 | 无 | 无 | Maven | 否 |

# 适用范围

## 与 spm 结构相容的模式

spm 的结构在 Task Background 中已经确认：机器级存储是 `<SPM_HOME>/sources/`，其中 `local/<名字>` 是指向本地目录的符号链接、`github/<owner>/<repo>` 是 git clone、`path/<哈希>` 是指向 skill 目录的符号链接；缓存条目由 `spm i` 的自举过程按需建立；全局清单的 `repositories:` 与 `aliases:` 是机器级登记，而 `github:` 坐标永不登记。

在这个结构下：

**模式五与 spm 相容，且是唯一能达成 Goal 的一族。** 其中 **5 a「触碰时写入的登记处」最贴合**：mise 记录被读取过的配置文件[^19]，pnpm 记录使用过 store 的项目[^7][^8]，Nix 在 `gcroots/auto/` 下留一个随目标消失而失效的符号链接[^16]。spm 的项目清单承担的角色与 mise 的配置文件、pnpm 的项目完全对应，而 spm 每次在项目内运行命令都会读取该清单。

**Nix 的悬挂根语义可以直接借用**：登记处做成符号链接目录时，项目被删除会留下悬挂链接，收集器忽略它，不需要额外的过期逻辑[^16][^17]。

**模式二的判据在 spm 中已经存在**，作用域限于当前清单的安装目录，无法延伸到 `sources/`。

**模式三在 spm 中的对应物很窄**：spm 的缓存没有索引，条目本身就是内容。可对应的情形只有「条目自身的指向已经不存在」——`local/<名字>` 的目标目录已被删除、`path/<哈希>` 的目标已被删除、`github/...` 缺少 `.git`。这是唯一不需要根集合就能判定的子集。

**模式四不适用于 spm**。spm 的清单可以长期不变，按 NuGet 官方文档记录的情形，仍在使用的条目不会刷新时间戳[^12]；Maven 记录的 `atime` 不可用问题同样存在[^14]。要用时间戳就必须自己记录访问，而「自己记录访问」与「登记根集合」相比，判定结果更弱（会误删仍在使用的条目）。

**模式五的 5 d 变体不适用于 spm**。conda 依赖硬链接计数[^20][^27]，而 spm 的缓存条目是符号链接（`local`、`path`）与 git clone（`github`），目标目录不记录指向它的链接数量。conda 官方文档本身就警告该机制不检查符号链接式安装[^20]。

**5 c 变体不适用于 spm**，因为 spm 存在多份项目清单，「被显式请求过」这一位标记无法表达「哪一份清单在引用它」。

**5 b 变体在 spm 中只覆盖一半**：全局清单是集中存放的，可以作为机器级登记处；但项目清单散落在任意路径，不集中存放，因此 5 b 无法覆盖项目维度。

## 无需新增状态的替代路径

配置一组扫描根目录，在其中查找 `skills.yaml`。这是 knip 一类工具的做法：knip 的 workspace 集合来自 `package.json` 的 `workspaces` 数组、`pnpm-workspace.yaml` 的 `packages` 数组或 knip 配置中的 `workspaces` 对象——**依然需要一个显式的枚举来源，而不是扫描整台机器**[^25]。这条路径需要用户配置搜索范围，并且无法覆盖任意位置的清单。

## 安全边界

外部证据一致指向同一条边界：**清扫可重建的缓存，不动声明**。npm、bun、Gradle 清扫的全部是可重新下载的内容[^1][^4][^9][^10]；NuGet 明确提示清完之后需要重新 restore[^12]。对应到 spm，`sources/` 下的三类条目都可重建（本地登记与 `path:` 条目按需重建符号链接，github 克隆按需重新克隆），而全局清单的 `repositories:` 与 `aliases:` 属于声明，重新获得需要用户输入。

# 限制

1. 本调研没有覆盖 Windows 平台符号链接权限差异对登记处方案的影响。
2. conda 判定「unused」的具体机制缺少官方说明，只能依据官方关于符号链接的警告与社区资料推断[^20][^27]。
3. Gradle 的 `gc.properties` 文件格式与访问记录细节未在官方文档中说明，本调研只确认它存在并承载记账[^9]。
4. Guix 与 Nix 的完整模型依赖数据库记录引用图[^16][^18]，spm 的清单本身就包含引用关系，因此 spm 的可达性计算比它们简单，本调研未逐一比对两者的引用图构建方式。
5. 本调研未覆盖 Docker、OCI 镜像等容器运行时的同类机制，它们不属于包管理器。
6. spm 内部代码的逐行核对属于 `specool-explore` 的范围，本调研中关于 spm 结构的事实来自本 Task 的 Background 与 `docs/PROMPT.md`。

# 待确认项

以下事项需要用户确认，本调研不代替决策：

1. 是否接受新增机器级状态（项目清单的登记处，或配置一组扫描根目录）？外部证据显示，不新增状态就无法达成 Goal 中「区分仍被引用与已无人引用」的要求。
2. 判定基准取哪些清单？登记处方案下为「登记处内所有清单 + 全局清单」。
3. 是否设置宽限期？外部实现普遍设置：Gradle 7 天与 30 天两档[^10]，git 默认两周[^26]，NuGet 建议「wait a few days」[^12]。
4. 是否采用 mise 的 `--dry-run-code` 约定（有待清理项时退出码为 1，默认退出码不变）？[^19]
5. 全局清单中已无人引用的 `repositories:` 与 `aliases:` 条目是否自动删除？外部证据不支持自动删除声明[^1][^4][^10]。
6. `sources/path/<哈希>` 条目是否纳入范围？

[^1]: npm, `npm-prune`. <https://docs.npmjs.com/cli/v11/commands/npm-prune>
[^2]: npm, `npm-cache`. <https://docs.npmjs.com/cli/v12/commands/npm-cache>
[^3]: npm, `cacache` README. <https://github.com/npm/cacache>
[^4]: Bun, `bun prune`. <https://bun.com/docs/pm/cli/prune>
[^5]: Bun, `Global cache`. <https://bun.com/docs/pm/global-cache>
[^6]: Bun, `bun pm`. <https://bun.com/docs/pm/cli/pm>
[^7]: pnpm, `pnpm store`. <https://pnpm.io/cli/store>
[^8]: pnpm, `pnpm 10.27` 发布说明. <https://pnpm.io/blog/releases/10.27>
[^9]: Gradle, `Dependency Caching`. <https://docs.gradle.org/current/userguide/dependency_caching.html>
[^10]: Gradle, `Gradle-managed Directories and Caches`. <https://docs.gradle.org/current/userguide/directory_layout.html>
[^11]: Gradle, `setRemoveUnusedEntriesAfterDays`. <https://docs.gradle.org/current/kotlin-dsl/gradle/org.gradle.api.cache/-cache-resource-configuration/set-remove-unused-entries-after-days.html>
[^12]: Microsoft Learn, `How to manage the global packages, HTTP cache, temp folders in NuGet`. <https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders>
[^13]: NuGet/Home, issue 15000, `CLI command to prune the global packages folder`. <https://github.com/NuGet/Home/issues/15000>
[^14]: Apache Maven, `MNG-7389 Incremental .m2 cache cleanup for CI`. <https://issues.apache.org/jira/browse/MNG-7389>
[^15]: Apache Maven Dependency Plugin, `dependency:purge-local-repository`. <https://maven.apache.org/plugins/maven-dependency-plugin/purge-local-repository-mojo.html>
[^16]: Nix Reference Manual, `nix-store --gc`. <https://nix.dev/manual/nix/2.35/command-ref/nix-store/gc>
[^17]: NixOS/nix, `Garbage Collector Roots`. <https://github.com/NixOS/nix/blob/master/doc/manual/source/package-management/garbage-collector-roots.md>
[^18]: GNU Guix Reference Manual, `Invoking guix gc`. <https://guix.gnu.org/manual/en/html_node/Invoking-guix-gc.html>
[^19]: mise, `mise prune`. <https://mise.jdx.dev/cli/prune.html>
[^20]: conda, `conda clean`. <https://docs.conda.io/projects/conda/en/stable/commands/clean.html>
[^21]: Spack, `Spack Environments`. <https://spack.readthedocs.io/en/latest/environments_basics.html>
[^22]: Spack, `Environments (spack.yaml, spack.lock)`. <https://spack.readthedocs.io/en/latest/environments.html>
[^23]: Homebrew, `brew(1)` manpage. <https://docs.brew.sh/Manpage>
[^24]: uv, `Caching`. <https://docs.astral.sh/uv/concepts/cache/>
[^25]: Knip, `Monorepos & Workspaces`. <https://knip.dev/features/monorepos-and-workspaces>
[^26]: Git, `git-gc`. <https://git-scm.com/docs/git-gc>
[^27]: Stack Overflow, `How does conda know which packages are unused?`（社区资料，仅用于补充硬链接计数机制）. <https://stackoverflow.com/questions/70975485/how-does-conda-know-which-packages-are-unused>
