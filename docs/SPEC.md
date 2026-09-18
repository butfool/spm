# spm 实现规格

> 本文描述 `spm` 应有的**行为**，不含具体代码。配合 [`PROMPT.md`](./PROMPT.md) 使用。
> 目标是：任何人（或 AI）读完这两份文档，能独立写出一个行为等价、且能通过 § 10 验收的实现。

---

## 1. 定位

一个**声明式**的 `SKILL.md` 依赖管理器。项目里写一份 `skills.yaml` 声明要哪些 skill，
`spm install` 让文件系统收敛到该状态，**幂等**、可重复。

### 1.1 非目标（做错就退回原工具的复杂度）

| 不做 | 原因 |
| --- | --- |
| **版本求解** | SKILL.md 之间没有依赖关系，清单是平的。github 源可以钉 ref，仅为可复现，不参与求解 |
| **数据库** | 状态 = 清单 + 磁盘上的软链接。换台机器/换个同事，`git diff` 就能看全 |
| **引用计数** | 判断"这个链接是不是 spm 建的"用一条判据（见 § 6.3），不需要所有权表 |
| **稳定 ID / UUID** | 见 [`PROMPT.md` § 3](./PROMPT.md)。改名是作者自己的事 |
| **反向扫描** | 扫描已安装内容反推清单。npm 也没有，不是缺口 |
| **group / 组合概念** | 整源安装 + 清单本身已经够表达"一套 skill" |

---

## 2. 目录与文件布局

```
~/.config/spm/
├── settings.yaml      # 全局默认值
├── skills.yaml        # 全局清单
└── sources/           # source 缓存，每个别名一个条目
    ├── mine -> /Users/me/Code/my-skills   # local：软链接，源目录不动
    └── upstream/                          # github：git clone
```

`SPM_HOME` 环境变量可整体改道（测试用），默认 `$XDG_CONFIG_HOME/spm` 或 `~/.config/spm`。

### 2.1 `settings.yaml`

```yaml
installDirs:
  - .agents/skills
  - .claude/skills
sourcesDir: sources      # 相对 SPM_HOME
defaultRef: main         # github 源的默认分支
```

三项都有默认值，文件可以不存在。**解析失败要报错，不要静默回落**——静默回落会让人
以为配置生效了。

### 2.2 `skills.yaml`（项目清单 / 全局清单，同一套 schema）

```yaml
installDirs:            # 可省略，省略则继承 settings，再省略则 [".agents/skills"]
  - .agents/skills

sources:                # 让清单自描述，新机器能自举
  mine:
    path: ~/Code/my-skills
  upstream:
    repo: anthropics/skills
    ref: main

skills:
  - mine/*              # 整源
  - upstream/pdf        # 单个
```

- 每个 source 恰好有 `path` 或 `repo` 之一，二者都有或都没有都是错误。
- `ref` 只对 github 有意义。
- `skills` 条目可以是字符串，也可以是对象 `{path|repo, ref?, skill?}`（手写清单用）。

### 2.3 `skill-repository.yaml`（source 自描述，可选）

放在 source 根目录，跟着仓库走，所以仓库整体挪位置不影响注册。

```yaml
name: mine       # 也是注册时的默认别名来源
exclude:         # 发现时跳过的路径前缀（相对仓库根）
  - drafts
  - archive
maxDepth: 3      # 0 或省略 = 用默认上限
```

**只有这三个字段。** 未知字段要**忽略**而不是报错——这样旧的 `id` / `skills.*.id`
写法不会让 spm 罢工。

---

## 3. 发现规则

从 source 根开始递归：

| 规则 | 说明 |
| --- | --- |
| **遇到 `SKILL.md` 就停** | 该目录**本身**是一个 skill，不再往下走。这是让 `references/`、`scripts/` 不被误认成 skill 的关键 |
| 跳过目录 | `.git` `node_modules` `dist` `build` `target` `vendor` `__pycache__` `.venv` `venv` |
| 隐藏目录 | 除 `.claude` `.agents` `.cursor` `.copilot` `.codex` 外一律跳过 |
| `exclude` 前缀 | 整段匹配：等于某项，或以 `<项>/` 开头。所以排除 `drafts` 不会误伤 `drafts-old` |
| 深度 | `maxDepth` 为 0 时用默认上限 5 |

### 3.1 SKILL.md 解析

YAML frontmatter（`---` 分隔，容忍 CRLF 和开头空行）：

- **`name`** 必填，且必须合法（见下）
- **`description`** 必填；缺失时**回落到正文首段**（截断 250 字符），再缺才算无效
- 其余字段原样保留，用于展示

**skill 名校验**：`^[a-z0-9._-]+$`，**且不得以 `.` 开头**。

> 后一条不是洁癖。名字会成为 `<installDir>/<name>` 的路径段，`..` 能让清单把软链接写到
> 安装目录之外——这是实打实的安全问题。`.foo` 同时还会变成隐藏项，一并拒掉。
> 只校验字符集是不够的。

---

## 4. 命令面

| 命令 | 别名 | 作用 |
| --- | --- | --- |
| `spm init [dir]` | | 创建 `skills.yaml` |
| `spm add <spec...>` | | 声明并安装 |
| `spm install [spec...]` | `i` | 无参 = 按清单还原；带参 = 等价 `add` |
| `spm remove <spec...>` | `rm` `un` `uninstall` | 去声明 + 删链接 |
| `spm list` | `ls` | 列出声明及链接状态 |
| `spm find [query]` | | 跨所有已注册 source 搜索 |
| `spm info <spec>` | | 单个 skill 详情 |
| `spm doctor [--fix]` | | 清单 vs 磁盘一致性检查 |
| `spm update [spec...]` | `up` | github 源重新 fetch，然后重新链接 |
| `spm source add\|remove\|list\|refresh` | | source 管理 |
| `spm config` | | 打印解析后的路径与配置 |

**全局选项**：`-g/--global`（作用于 `~/.config/spm/skills.yaml`）、`-q/--quiet`。

**常用子选项**：`-f/--force`（覆盖非软链接条目）、`--no-prune`、`--frozen`（只校验不写）、
`--json`（只读命令）。

### 4.1 scope 模型（关键）

```
project: manifestDir = cwd,        installBaseDir = cwd
global:  manifestDir = SPM_HOME,   installBaseDir = $HOME
```

**`-g` 的语义是"把 `$HOME` 当成项目根"**，两个 scope 走**完全相同**的 reconcile 流程，
只有根不同。于是：

| | 根 | `installDirs: [.agents/skills]` 落在 |
| --- | --- | --- |
| `spm i` | `<cwd>` | `<cwd>/.agents/skills` |
| `spm i -g` | `$HOME` | `~/.agents/skills` |

> 反例：如果全局也相对 `~/.config/spm/` 解析，`.agents/skills` 会变成
> `~/.config/spm/.agents/skills`，两个 scope 反而不对称了。**别这么做。**

`installDirs` 是**数组**：同一批 skill 会链接进每一个列出的目录。多个目标之间不共享状态，
所以不需要引用计数。

---

## 5. spec 语法

| 写法 | 含义 |
| --- | --- |
| `alias` | **整源**（推荐形式，见下） |
| `alias/*` | 整源（需引号） |
| `alias/skill` | 单个 |
| `./path` `~/path` `/abs/path` | 本地目录 = 整源，按需注册 |
| `owner/repo` | github 仓库 = 整源 |
| `owner/repo/skill` | github 单个 |
| `owner/repo#tag` | 钉住 github 的 tag/branch |
| `skill-name` | 在所有已注册 source 里查找 |

### 5.1 解析优先级

```
1. 以 ./ ../ / ~ 开头或等于 . / ..        → 本地路径
2. 首段是已知别名（manifest.sources 有，或 sources/ 下已注册） → 按别名解析
3. 单段（无斜杠）                          → 别名优先，其次按 skill 名全局查找
4. 其余                                    → github owner/repo[/skill]
```

### 5.2 为什么要有裸别名形式

`*` 由 **shell 先行展开**，spm 根本收不到：

```
$ spm add mine/*
(eval):14: no matches found: mine/*        # zsh 默认 nomatch
```

更糟的是当前目录**恰好有** `mine/` 目录时，它会静默展开成那个目录里的文件名。
所以 `spm add mine` 是首选写法：无通配符、不需要引号、不可能被误读。

裸词解析"别名优先于 skill 名"，且安装输出**必须列出展开后的每个 skill**，让结果无歧义。

### 5.3 别名冲突

注册别名时优先级：`--alias` 参数 > `skill-repository.yaml` 的 `name` > 目录名 / repo 名。

别名已存在且指向别处时**报错**，列出当前绑定，要求 `--force` 才重绑。不要静默覆盖。

### 5.4 已有注册的复用

按路径注册时，若该目录**已经是某个已注册 source 的根**（realpath 比较，因为注册项是软链接），
必须**复用那个别名**，而不是按目录名再注册一遍——后者会把同一个源的全部 skill
往清单里塞第二遍，然后报一个莫名其妙的"两个源提供同一个 skill"。

若该目录是某个已注册 source 的**子目录**，报错并提示 `spm add <别名>/<skill>`。

---

## 6. 安装（reconcile）

### 6.1 流程

```
读清单
  → 解析每个条目为 (sourceRoot, skill) 集合（`alias/*` 展开为全量）
  → 对每个 installDir × skill：落链接
  → prune：删掉不再声明的链接
```

### 6.2 单个链接的动作

| 磁盘现状 | 动作 |
| --- | --- |
| 软链接且指向正确 | **不动**（幂等的关键） |
| 软链接但指向别处 | 重指 |
| 不存在 | 创建（先 `mkdir -p` 父目录） |
| **真实目录或文件** | **拒绝并报告**，`--force` 才覆盖 |

目标为空时**不要删目录本身**。

### 6.3 prune 的判据（核心设计）

> **只删"目标落在 `SPM_HOME/sources/` 之内、且当前清单未声明"的软链接。**

这一条判据同时取代了老实现里的 `skill_materializations` + `materialization_origins` 两张表：
"这个链接是谁建的"不再需要记录，问它指向哪里就够了。

副产品是**安全性**：用户手工建的、指向自己工作副本的链接，因为目标不在 source 缓存内，
永远不会被碰。

### 6.4 清单写入必须"先验证后提交"

`add` 的写入顺序：

```
在清单的副本上暂存改动
  → 完整解析（会暴露"两个源提供同一 skill"之类的冲突）
  → 解析通过才写盘
```

**不能先写盘再解析**。否则一个冲突的 spec 会留下半写的清单——我实现时先写后验，
一条 `spm add ./subdir` 就把 `alpha/*` 留在了清单里，删都删不干净。

### 6.5 幂等性

同一份清单连跑两次，第二次必须**全部 `unchanged`、零删除**。这是最重要的不变量，
应当有测试直接断言。

### 6.6 移除

`rm` 走"改清单 → 重新 reconcile"这一条路，靠 prune 删链接。**不要**写第二套删除逻辑——
两套逻辑必然漂移。

---

## 7. source 生命周期

### 7.1 local

```
spm source add ./path  →  ln -s <abs>  ~/.config/spm/sources/<alias>
```

**只建软链接，源目录一个字节都不改。** 这正是"注册"而非"拷贝"的意义：源仓库怎么改，
装出去的 skill 立刻跟着变。

### 7.2 github

```
git clone --depth 1 --branch <ref> --single-branch https://github.com/<owner>/<repo>.git <tmp>
  → 读 <tmp>/skill-repository.yaml 拿 name
  → rename 到 sources/<alias>
```

**先 clone 到临时目录再改名**，否则拿不到仓库自己声明的名字。失败要清理临时目录。

别名规则同 § 5.3。`refresh` = `git fetch --depth 1 origin <ref> && git checkout --force FETCH_HEAD`。

### 7.3 自举（Bootstrap）

**这是全局清单存在的全部理由。** `spm i` 遇到清单里声明了但本地没有的 source，
必须**自动注册**（local 建链接 / github clone），然后继续安装。

所以一台新机器 + 一份 `skills.yaml` 就能从零还原，不需要先手动 `source add`。

已验证：清空 `~/.config/spm/sources/` 后 `spm i` 能自动恢复本地链接与 github clone。

---

## 8. 应借鉴的既有领域细节

参考实现位于 `~/Code/ButCool/skills`（Go）：

| 需要什么 | 参考位置 |
| --- | --- |
| XDG 配置目录解析 | `internal/config/config.go` |
| `skill-repository.yaml` 读写（**去掉 id**） | `internal/core/repository/manifest.go` |
| SKILL.md frontmatter 解析 | `internal/core/discover/discover.go:231` |
| 递归发现边界（遇 SKILL.md 停） | `internal/core/discover/discover.go:107,181` |
| exclude 前缀匹配语义 | `internal/core/discover/discover.go:193` |
| symlink 物化的幂等处理 | `internal/core/install/install.go:791` |
| 默认安装路径 `.agents/skills` 优先 | `internal/core/pathconfig/pathconfig.go:37` |

**不要借鉴**：SQLite schema、group、ref_count、doctor 的 16 种 issue kind、
internal skill（DB 内联存储）、UUID 身份体系、Web UI。

---

## 9. 实现约束与陷阱

### 9.1 技术栈

TypeScript + Node（ESM，`bin` 入口指向 `dist/cli.js`）。

依赖只保留四个：`commander`（CLI）、`yaml`、`zod`（清单/settings 校验）、`picocolors`（着色）。
git 操作直接 `child_process.execFile` 调系统 git——不引 git 库，顺带继承用户的凭据配置，
私有仓库才能用。

### 9.2 ⚠️ TypeScript 7 的 `types` 默认值变了

TS 6/7 起，`types` 默认是 `[]`，**不再自动包含 `node_modules/@types/*` 下的所有包**。
必须在 `tsconfig.json` 里显式写：

```jsonc
{ "compilerOptions": { "types": ["node"] } }
```

漏了会得到满屏 `Cannot find name 'process'` / `Cannot find name 'node:fs'`。
**没有任何配置值表示"全部包含"**：`"*"` 不是，不设就是没有。

> 我因为这个把整个项目降级到了 TS 5，是错的——正解就是加这一行。
> 更详细的踩坑记录见 git log `0cffd26`。

另外 TS7 要求：`target` 最低 ES2015（`es5` 已移除）、`moduleResolution` 不能用 `node`/`node10`/`classic`、
`baseUrl` 已移除、`esModuleInterop` 和 `alwaysStrict` 强制开启。

### 9.3 tsconfig 拆两份

```jsonc
// tsconfig.json        检查用：noEmit，覆盖 src/ 和 test/
// tsconfig.build.json  产出用：rootDir=src, outDir=dist, declaration, sourceMap
```

**`test/` 必须进类型检查。** 只写 `include: ["src/**/*.ts"]` 的话测试文件完全不被检查，
而 vitest 默认也不做类型检查——测试里的类型错误永远不会暴露。这个坑值得专门写一条测试。

### 9.4 其他

- **清单写入要确定性排序**（别名、条目都排序），否则 `add` 会产生噪声 diff。
- **空段落不要写出来**（`sources: {}` 就别输出），让文件保持干净。
- **YAML 校验用 zod**，失败要报清楚哪个文件哪一行，不要静默回落默认值。

---

## 10. 验收标准

### 10.1 功能验收

```bash
# 自举：只有清单，什么都没有
spm i -g                          # → 自动注册 source、创建链接

# 幂等：连跑两次
spm i && spm i                    # 第二次全部 unchanged、零删除

# 整源
spm add mine                      # 裸别名
spm add /another/repo             # 本地路径

# 多安装目录
# skills.yaml: installDirs: [.agents/skills, .claude/skills]
# → 两个目录下都出现全部 skill

# prune：从清单删掉一条后重跑
spm i                             # → 对应链接被删除

# 一致性
spm doctor                        # → healthy，退出码 0
```

### 10.2 doctor 必须能发现的问题

| kind | 级别 |
| --- | --- |
| 声明的 skill 源目录不存在 | error |
| 链接指向错误目标 | error |
| 真实目录占用了声明的 skill 名 | error |
| 安装目录不可写 / 位于 source 缓存内 | error |
| 清单无法解析（source 不可达、声明冲突） | error |
| **链接缺失** | warning |
| 已声明但未注册的 source | warning |
| 指向 source 缓存但未声明的孤儿链接 | warning |
| 安装目录尚不存在 | warning |

> "链接缺失"必须**由清单驱动**去查。只遍历磁盘上有什么的话，被删掉/被别的工具改掉的
> 链接没有目录项可遍历，会完全漏报——我实现时就这么错过一次。

### 10.3 必须有的测试

1. 清单读写往返 + 确定性排序
2. spec 解析（每种形式各一条）
3. 发现边界：遇 SKILL.md 停、exclude、跳过目录、深度上限
4. **skill 名拒绝 `..` 和点开头**
5. **安装幂等**（同清单跑两次结果一致）
6. 多 `installDirs` 下每个目录都正确落链与清理
7. prune 只删指向 source 缓存的链接，手工链接不动
8. 冲突的 spec **不得污染清单**
9. 已有注册的路径被复用时**不产生重复条目**

### 10.4 参考实现的规模

28 个 `src/**/*.ts`（`core/` 8 + `cli/` 15 + 顶层 5），4 个测试文件，56 个用例，全绿。
