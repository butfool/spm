# 实现 spm：面向 AI Coding Agent 的声明式 SKILL 管理器

实现一个命令行工具 `spm`，用 TypeScript + Node 编写，代码放在你选定的目录里。

它管理 AI coding agent（Claude Code、Cursor、Codex 等）读取的 `SKILL.md` 文件，做成
**声明式依赖管理**：用户在 `skills.yaml` 里声明要哪些 skill，`spm install` 让文件系统
收敛到那个状态——幂等、可重复运行。

心智模型是 npm 的命令行加上 Gradle 的分层：**仓库的登记与依赖的声明分开**，依赖写成
`类型:仓库:技能` 的三段坐标。

读完本文即可开工。文末附完整验收标准。

---

## 1. 两种仓库

### local

本地目录，注册 = 在 `~/.config/spm/sources/local/<名字>` 建一个指向源目录的**软链接**。

```
spm repository add ~/Code/Skills/Obsidian --name Obsidian
  →  ln -s ~/Code/Skills/Obsidian  ~/.config/spm/sources/local/Obsidian
```

**源目录本身一个字节都不改。** 这是"注册"而非"拷贝"的全部意义：源仓库怎么改，
装出去的 skill 立刻跟着变。

**目录路径不能充当标识**（路径会变、会被复制到别的机器），所以注册时必须给一个名字。
名字与 `sources/local/` 下的一级目录名一一对应。

### github

github 仓库的标识就是 `owner/name` 本身，**不需要注册，注册表里也不记录**。

```
clone  →  ~/.config/spm/sources/github/<owner>/<repo>
```

```
git clone --depth 1 --single-branch https://github.com/<owner>/<repo>.git <临时目录>
```

先 clone 到临时目录，成功后 `mkdir -p` 目标父目录并 rename 到位，失败要清理临时目录。
**不带 `--branch`**：跟随远端默认分支。仓库的 `skill-repository.yaml` 里的 `name`
字段对 github 仓库没有意义，不要读取。

git 操作直接 `child_process.execFile` 调系统 git。不要引 git 库——顺带继承了用户的
凭据配置，私有仓库才能用。

**不存在版本或 ref 的钉住。** `spm update` 重新拉取默认分支即可。

---

## 2. 三个配置文件

### 2.1 `~/.config/spm/settings.yaml`（全局默认值）

```yaml
installDirs:
  - .agents/skills
  - .claude/skills
sourcesDir: sources      # 相对 SPM_HOME
```

两项都要有默认值，文件可以不存在。但**解析失败必须报错，不要静默回落**——静默回落会让
用户以为配置生效了。

`SPM_HOME` 环境变量可整体改道（测试要用），默认 `$XDG_CONFIG_HOME/spm` 或 `~/.config/spm`。

### 2.2 `skills.yaml`（清单，项目级与全局级同一套 schema）

- 项目级：`<项目根>/skills.yaml`
- 全局级：`~/.config/spm/skills.yaml`

**全局清单兼作机器级注册表**：`repositories:` 段落记录本机注册的本地仓库，`skills:`
段落记录全局安装的 skill。

```yaml
installDirs:            # 可省略；省略则继承 settings，再省略则 [".agents/skills"]
  - .agents/skills
  - .claude/skills

repositories:           # 只登记本地仓库；github 仓库不写进来
  mine:                 # key 就是注册名
    type: local         # 恒为 local；字段留着，类型在清单里处处可见
    path: ~/my-skills
  shared:
    type: local
    path: ../shared/skills

skills:                 # 依赖，写成三段坐标
  - local:mine:*
  - github:anthropics/skills:pdf-fill
```

规则：

- `repositories:` 每一项**必须**有 `type: local` 与 `path`。类型写成别的、或者缺少
  `path`，都是错误。
- `path` 相对清单所在目录解析：项目清单相对项目根，全局清单相对 `$HOME`。`~` 展开为
  `$HOME`。
- 仓库名与 skill 名会成为路径段，**必须在读取清单时就校验**（见 §5.2）。名字里带 `/`
  或 `..` 能让清单把软链接写到缓存目录之外，这是实打实的安全问题。
- `skills:` 每一项**必须**是合法坐标，读取清单时就校验，报错要说清错在第几段。
- **不含任何版本字段。** 不要设计 version / range / semver / ref。
- 项目清单只写自己需要的仓库。全局清单里已经登记的要复用它，不要重复写一遍路径。

### 2.3 `skill-repository.yaml`（仓库自描述，可选）

放在仓库根目录。因为它在仓库里、跟着仓库走，所以仓库整体挪位置不影响注册。

```yaml
name: mine       # 本地仓库注册时的默认名字
exclude:         # 发现时跳过的路径前缀（相对仓库根）
  - drafts
  - archive
maxDepth: 3      # 0 或省略 = 用默认上限
```

**只允许这三个字段。** 遇到未知字段要**忽略而非报错**，这样带旧字段的仓库不会让 spm 罢工。

> **绝对不要**在这里引入仓库 UUID 或每个 skill 的稳定 ID。
> 这个文件只解决两件事：**这个仓库叫什么**，以及**哪些内容可见**。
> skill 改名后如何追踪是作者自己的事，工具不该管。

---

## 3. 发现规则

从仓库根开始递归：

| 规则 | 说明 |
| --- | --- |
| **遇到 `SKILL.md` 就停** | 该目录**本身**是一个 skill，不再往下走 |
| 跳过目录 | `.git` `node_modules` `dist` `build` `target` `vendor` `__pycache__` `.venv` `venv` |
| 隐藏目录 | 除 `.claude` `.agents` `.cursor` `.copilot` `.codex` 外一律跳过 |
| `exclude` 前缀 | 整段匹配：等于某项，或以 `<项>/` 开头。排除 `drafts` 不得误伤 `drafts-old` |
| 深度 | `maxDepth` 为 0 时用默认上限 5 |

"遇 SKILL.md 就停"是让 `references/`、`scripts/` 不被误认成 skill 的关键。

### 3.1 SKILL.md 解析

YAML frontmatter（`---` 分隔，容忍 CRLF 和开头空行）：

| 字段 | 规则 |
| --- | --- |
| `name` | 必填，且必须合法（见下） |
| `description` | 必填；缺失时**回落到正文首段**（截断 250 字符）；再缺才算无效 |
| 其余 | 原样保留，用于展示 |

**skill 名校验**：`^[a-z0-9._-]+$`，**且不得以 `.` 开头**。

后一条不是洁癖：名字会成为 `<installDir>/<name>` 的路径段，`..` 能让清单把软链接写到
安装目录**之外**。这是实打实的安全问题。`.foo` 还会变成隐藏项，一并拒掉。

**只校验字符集是不够的。**

---

## 4. 命令面

| 命令 | 别名 | 作用 |
| --- | --- | --- |
| `spm init [dir]` | | 创建 `skills.yaml` |
| `spm add <spec...>` | | 声明并安装 |
| `spm install [spec...]` | `i` | 无参 = 按清单还原；带参 = 等价 `add` |
| `spm remove <spec...>` | `rm` | 去声明 + 删链接 |
| `spm list` | `ls` | 列出声明及链接状态 |
| `spm find [query]` | | 跨所有已注册仓库搜索 |
| `spm info <spec>` | | 单个 skill 详情 |
| `spm doctor [--fix]` | | 清单 vs 磁盘一致性检查 |
| `spm update [spec...]` | `up` | github 仓库重新拉取，然后重新链接 |
| `spm repository add <path> [--name]` | | 把本地目录登记进全局清单 |
| `spm repository remove <name>` | `rm` | 从全局清单与缓存目录中移除 |
| `spm repository list` | `ls` | 列出本机已注册的仓库 |
| `spm config` | | 打印解析后的路径与配置 |

**全局选项**：`-g/--global`（作用于 `~/.config/spm/skills.yaml`）、`-q/--quiet`。

**常用子选项**：`-f/--force`（覆盖非软链接条目、重新绑定已占用的仓库名）、`-n/--name`
（本地目录登记时使用的名字）、`--no-prune`、`--frozen`（只校验不写）、`--json`
（只读命令）。

**写入位置由命令决定**：

- `spm repository add` 只写全局清单的 `repositories:` 段落，文件不存在时创建。
- `spm add` 只写当前清单。坐标指向的本地仓库已经在全局清单里登记时，只写坐标，
  项目清单里不出现 `repositories:` 段落。
- `spm add <本地目录>` 把声明写进当前清单（项目级，或 `-g` 时的全局清单）。

### 4.1 scope 模型（关键设计）

```
project: manifestDir = cwd,        installBaseDir = cwd
global:  manifestDir = SPM_HOME,   installBaseDir = $HOME
```

**`-g` 的语义是"把 `$HOME` 当成项目根"**。两个 scope 走**完全相同**的 reconcile 流程，
只有根不同：

| | 根 | `installDirs: [.agents/skills]` 落在 |
| --- | --- | --- |
| `spm i` | `<cwd>` | `<cwd>/.agents/skills` |
| `spm i -g` | `$HOME` | `~/.agents/skills` |

> 反例：如果全局也相对 `~/.config/spm/` 解析，`.agents/skills` 会变成
> `~/.config/spm/.agents/skills`，两个 scope 反而不对称了。**不要这么做。**

`installDirs` 必须是**数组**：同一批 skill 要链接进每一个列出的目录。多个目标之间不共享
状态——所以**不需要引用计数**。

---

## 5. 坐标语法

```
<类型>:<仓库>:<技能>
```

| 段 | 取值 |
| --- | --- |
| 类型 | `local` 或 `github`，清单里必写 |
| 仓库 | `local` 是注册名；`github` 是 `owner/name` |
| 技能 | skill 名，或 `*` 表示该仓库的全部 skill |

**清单里必须是完整的三段形式**，解析失败要指出错在哪一段。三段的形状对应 Gradle 的
`group:artifact:version`，冒号是坐标分隔符。

### 5.1 命令行简写

命令行可以省掉类型段。判据确定，不靠猜测：

| 输入 | 判定 |
| --- | --- |
| `local:mine:foo`、`github:a/b:foo` | 完整坐标 |
| `local:mine`、`github:a/b` | 整个仓库（技能段按 `*` 处理） |
| `mine:foo`、`mine:*`、`mine` | 首段是已知本地仓库名 |
| `a/b:foo`、`a/b` | 首段含斜杠，按 github 解析 |
| `./path`、`~/path`、`/abs/path` | 本地目录，按需登记为本地仓库 |
| `foo` | 在所有已注册仓库里查找该 skill 名 |

写入清单的坐标**始终**是带类型的三段形式。

### 5.2 名字与类型校验

- 本地仓库名：`^[A-Za-z0-9._-]+$`，不得以 `.` 开头，**不得等于 `local` 或 `github`**
  （否则简写无法判定）。
- github 仓库：必须形如 `owner/name`。
- 类型段与实际种类必须一致：`github:` 后面写了本地仓库名、`local:` 后面写了
  `owner/name`，都直接报错。
- 无冒号的单段写法按 skill 名查找：唯一命中才安装，多处命中**列出候选后报错**。

---

## 6. 安装语义（reconcile）

### 6.1 流程

```
读清单
  → 解析每个坐标为 (仓库根, skill) 集合（整仓库条目展开为全量）
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

这一条判据取代了"物料表 + 来源表 + 引用计数"那一整套记账机制：**"这个链接是谁建的"
不再需要记录，问它指向哪里就够了。**

副产品是**安全性**：用户手工建的、指向自己工作副本的链接，因为目标不在缓存目录内，
永远不会被碰。

### 6.4 移除

`rm` 走"改清单 → 重新 reconcile"，靠 prune 删链接。

**不要写第二套删除逻辑**——两套逻辑必然漂移。

`rm` 之后，当前清单里已经没有坐标引用的**项目级**仓库声明要一并删掉，否则那个名字被
占着，用户下次想用同一个名字指向别的目录时会撞上一个莫名其妙的错误。全局清单的
`repositories:` 段落是机器级登记，`rm` **不得**触碰。

### 6.5 幂等性

同一份清单连跑两次，第二次必须**全部 unchanged、零删除**。

这是最重要的不变量，**必须有一条测试直接断言它**。

---

## 7. 注册表与生命周期

### 7.1 注册

```
spm repository add <本地目录> --name <名字>
  →  ln -s <绝对路径>  <SPM_HOME>/sources/local/<名字>
  →  在全局清单的 repositories: 段落写一条 {type: local, path: <用户输入的原文>}
```

校验目标存在且含至少一个 SKILL.md，发现放在建链接**之前**：目录不可用时不要留下垃圾链接。
`path` 原样保留用户的写法，读取时相对清单所在目录解析。

**已经存在的名字指向别处时直接报错**，只有 `--force` 才允许重新绑定。不要静默覆盖。

### 7.2 缓存目录布局

```
~/.config/spm/sources/
  local/<名字>                 →  软链接，指向本地目录
  github/<owner>/<repo>        →  git clone，跟随远端默认分支
```

两类仓库分属两个命名空间：本地名字里不含斜杠，因此不可能与 github 的 `owner`
相互碰撞。

**同一个本地目录只登记一次。** 按路径注册时，先比较 realpath：如果这个目录已经是某个
已注册仓库的根，必须**复用那个名字**，而不是按目录名再登记一遍。比较时必须用
**realpath**，注册项本身是软链接，拿链接路径和用户给的目录比永远不会相等。

若该目录是某个已注册仓库的**子目录**，报错并提示 `spm add local:<名字>:<skill>`。

### 7.3 自举（Bootstrap）

`spm i` 遇到清单里声明了、但本机还没有的仓库，必须**自动建立**：

- `local`：按 `path` 建软链接
- `github`：clone

所以一台新机器 + 一份项目清单 + 一份全局清单就能从零还原，**不需要先手动注册**。
新机器上没有全局清单时，项目清单里的 `local:<名字>` 会报错并给出 `spm repository add`
的命令，这是分层的必然代价——与 Gradle 引用 `mavenLocal()` 的处境相同。

---

## 8. 明确不做的事

做错了就会退回"不好用"的老路：

| 不做 | 原因 |
| --- | --- |
| **版本求解** | SKILL.md 之间没有依赖关系，清单是平的 |
| **ref 钉住** | github 仓库跟随默认分支即可，清单里不出现版本概念 |
| **给 github 仓库起别名** | `owner/name` 已经是唯一标识，多一层名字只会多一处不一致 |
| **github 仓库进注册表** | 路径本身就是标识，登记它等于把同一件事写两遍 |
| **数据库** | 状态 = 清单 + 磁盘上的软链接。换台机器/换个同事，`git diff` 就能看全 |
| **引用计数** | 判断"链接是不是 spm 建的"用 §6.3 那一条判据，不需要所有权表 |
| **稳定 ID / UUID** | 改名是作者自己的事 |
| **反向扫描** | 扫描已安装内容反推清单。npm 也没有，不是缺口 |
| **group / 组合概念** | 整仓库安装 + 清单本身已够表达"一套 skill" |

---

## 9. 容易做错的地方（务必注意）

### 9.1 清单写入必须"先验证，后提交"

`add` 的写入顺序**必须**是：

```
在清单的副本上暂存改动
  → 完整解析（这一步会暴露"两个仓库提供同一 skill"之类的冲突）
  → 解析通过才写盘
```

**不要先写盘再解析。** 否则一个冲突的 spec 会留下半写的清单：用户明明没加成功，
清单里却多了一条，删都删不干净。

### 9.2 整仓库条目与单条条目的关系

同一个仓库同时被整仓库条目和单条条目覆盖时（`local:mine:*` 与 `local:mine:pdf`），
后者是冗余的。加整仓库条目时**要顺手清掉**该仓库的单条条目；加单条条目时，若整仓库
条目已经覆盖它，**不要再写进去**。

### 9.3 doctor 的"链接缺失"必须由清单驱动去查

检查"每个声明的 skill 在每个 installDir 下是否都有正确的链接"时，**必须遍历清单**。

**只遍历磁盘上有什么是不够的**：被删掉的链接、被别的工具改指他处的链接，都没有目录项
可供遍历，会**完全漏报**——而这两种恰恰是最常见的故障。

### 9.4 ⚠️ TypeScript 7 的 `types` 默认值变了

TS 6/7 起，`types` 默认是 `[]`，**不再自动包含 `node_modules/@types/*` 下的所有包**。
必须在 `tsconfig.json` 里显式写：

```jsonc
{ "compilerOptions": { "types": ["node"] } }
```

漏了会得到满屏 `Cannot find name 'process'` / `Cannot find name 'node:fs'`。

**没有任何配置值表示"全部包含"**：`"*"` 不是，不设就是没有。

> 满屏这种报错时，第一反应容易怀疑是环境/二进制出了问题。**不是**——就是缺这一行。

TS7 的其他要求：`target` 最低 ES2015（`es5` 已移除）、`moduleResolution` 不能用
`node`/`node10`/`classic`、`baseUrl` 已移除、`esModuleInterop` 与 `alwaysStrict` 强制开启。

### 9.5 tsconfig 拆两份，且 `test/` 必须进类型检查

```jsonc
// tsconfig.json        检查用：noEmit，覆盖 src/ 和 test/
// tsconfig.build.json  产出用：rootDir=src, outDir=dist, declaration, sourceMap
```

只写 `include: ["src/**/*.ts"]` 的话测试文件完全不被检查——而 vitest 默认也不做类型检查，
**测试里的类型错误永远不会暴露**。

### 9.6 其他

- 清单写入要**确定性排序**（仓库名、坐标都排序），否则 `add` 会产生噪声 diff。
- **空段落不要写出来**（`repositories: {}` 就别输出），让文件保持干净。
- YAML 校验用 zod，之后再做一遍语义校验（仓库名、坐标），失败要报清楚哪个文件哪里错了。
- 命令失败时**清单要保持原样**，不要留半成品。
- 测试要同时改道 `SPM_HOME` 与 `HOME`：全局 scope 把 `$HOME` 当项目根，只改
  `SPM_HOME` 会让测试往真实的 `~/.agents/skills` 里写链接。

---

## 10. 交付物与验收

### 10.1 技术栈

| | |
| --- | --- |
| 语言 | TypeScript + Node，ESM |
| 入口 | `bin` 指向 `dist/cli.js` |
| 运行时依赖 | 只允许 4 个：`commander`、`yaml`、`zod`、`picocolors` |
| 数据库 | 无 |

### 10.2 功能验收

```bash
# 机器级登记：把本地目录登记一次
spm repository add ~/Code/Skills/Obsidian --name Obsidian
spm repository list                       # → local:Obsidian，含 skill 数量与真实路径

# 项目里只写坐标，路径不重复
# skills.yaml: skills: [local:Obsidian:*, github:vercel-labs/agent-skills:*]
spm i                                     # → 自动 clone github、建立本地链接

# 幂等：连跑两次
spm i && spm i                            # → 第二次全部 unchanged、零删除

# 多安装目录：两个目录下都出现全部 skill
# skills.yaml: installDirs: [.agents/skills, .claude/skills]

# 项目自带一个本地仓库：声明落在项目清单里
spm add ./local-skills --name local-skills

# prune：从清单删掉一条后重跑，对应链接被删除
spm rm local:Obsidian:obsidian-tasks

# 一致性
spm doctor                                # → healthy，退出码 0
```

### 10.3 doctor 必须能发现的问题

| 问题 | 级别 |
| --- | --- |
| 声明的本地仓库目录不存在（含已登记目录被删除） | error |
| 同名仓库在两层清单里指向不同路径 | error |
| 清单无法解析（坐标非法、仓库未注册） | error |
| 链接指向错误目标 | error |
| 真实目录占用了声明的 skill 名 | error |
| 安装目录不可写 | error |
| 安装目录位于缓存目录内 | error |
| **链接缺失** | warning |
| 指向缓存目录但未声明的孤儿链接 | warning |
| 安装目录尚不存在 | warning |

**一个根因只产生一条诊断**。同一件事不要被两条检查路径各报一次，否则汇总计数失真，
用户也无法判断该按哪一级处理。仓库目录已消失这一种情况，由解析阶段报（那里还知道是哪个
仓库），`doctor` 不要再单独查一遍路径。

### 10.4 必须有的测试

1. 坐标解析：三段形式、整仓库、类型与仓库不匹配、段数不足或过多、非法名字
2. 清单读写往返 + 确定性排序 + 非法坐标与非法仓库名被拒
3. 发现边界：遇 SKILL.md 停、exclude 整段匹配、跳过目录、深度上限
4. **skill 名拒绝 `..` 和点开头**
5. **安装幂等**（同清单跑两次结果一致）
6. 多 `installDirs` 下每个目录都正确落链与清理
7. prune 只删指向缓存目录的链接，**手工链接不动**
8. 冲突的 spec **不得污染清单**
9. 已有登记的路径被复用时**不产生重复声明**
10. 声明了但本机未注册的本地仓库，`spm i` 能自动建立链接
11. **全局清单里的登记能被项目直接引用**，项目清单里不出现重复路径

---

## 附：最初的需求原文

以下是最初提出这个工具时的原话，记录在此说明它为何存在。其中"local 与 github 都要注册"
"按 source 整体安装"等表述已经被上面的模型取代，**以本文正文为准**。

> 我想要让你帮我做一个类似 npm/maven 的 SKILL 管理工具.
>
> 现在这个 SKills 工具不好用.
>
> 我希望做成声明式的依赖管理工具
>
> 并且类似 maven 有全局配置和本地仓库路径(~/.config/spm/settings.yaml)
>
> local/github 两种类型的仓库都支持
>
> 但是本地的也是要注册一下才能知道这个 source 的路径的 (通过软连接进行 register 的动作)
>
> 同时支持 install 单个和一整个 source 两种方式.
>
> 命令行操作类似于 npm,比如 install/i 等等各种命令集合
