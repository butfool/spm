# 实现 spm：面向 AI Coding Agent 的声明式 SKILL 管理器

实现一个命令行工具 `spm`，用 TypeScript + Node 编写，代码放在你选定的目录里。

它管理 AI coding agent（Claude Code、Cursor、Codex 等）读取的 `SKILL.md` 文件，做成
**声明式依赖管理**：用户在 `skills.yaml` 里声明要哪些 skill，`spm install` 让文件系统
收敛到那个状态——幂等、可重复运行。

心智模型是 npm 的命令行加上 Gradle 的分层：**仓库的登记与依赖的声明分开**，仓库里的依赖
写成 `类型:仓库:技能` 三段坐标；自身就是一个目录的 skill 不经过仓库，写成 `path:<目录>`
两段坐标（见 §5）。

读完本文即可开工。文末附完整验收标准。

---

## 1. 两种仓库

**Source 是「装着 skill 的目录」。** 注册一个 Source 等于把它列入默认搜索范围：`spm find`
搜的就是这些目录，裸 skill 名也只在里面查找。根目录带 `SKILL.md` 的目录**不是**仓库，
它本身就是一个 skill，不进注册表（见 §5 的 `path:` 坐标）。

### local

本地目录，注册 = 在 `~/.config/spm/sources/local/<名字>` 建一个指向源目录的**软链接**。

```
spm repository add ~/Code/Skills/Obsidian --name Obsidian
  →  ln -s ~/Code/Skills/Obsidian  ~/.config/spm/sources/local/Obsidian
```

**源目录本身一个字节都不改。** 这是"注册"而非"拷贝"的全部意义：源仓库怎么改，
装出去的 skill 立刻跟着变。

**目录路径不能充当标识**（路径会变、会被复制到别的机器），所以注册时必须给一个名字。
名字与 `sources/local/` 下的一级目录名一一对应，并且由用户确认：默认值是
`skill-repository.yaml` 的 `name`，没有则取目录名；重名或不可用时必须改名（见 §7.1）。

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

**全局清单兼作机器级注册表**：`repositories:` 段落记录本机注册的本地仓库，`aliases:`
段落记录本机给单个 skill 起的名字，`skills:` 段落记录全局安装的 skill。注册一个本地仓库
的唯一作用是把它列入默认搜索范围（`spm find` 与裸 skill 名查找），所以只要一个 skill
目录不需被搜索，就不必为它编一个仓库名——那种情况用 `path:<目录>` 坐标；如果还想让各个
项目用短名字引用它，就在 `aliases:` 里给它起一个名字，项目里写 `alias:<名字>`。

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

aliases:                # 机器级名字，只指一个 skill；本身不安装任何东西
  md-lint: path:~/Code/ButCool/md-lint/skills/md-lint
  notion-api: github:intellectronica/agent-skills:notion-api

skills:                 # 依赖，写成带类型的坐标
  - local:mine:*
  - github:anthropics/skills:pdf-fill
  - alias:md-lint
```

规则：

- `repositories:` 每一项**必须**有 `type: local` 与 `path`。类型写成别的、或者缺少
  `path`，都是错误。
- `repositories:` 的 `path` **不得**指向一个 skill 目录（根目录带 `SKILL.md` 的目录）。
  一台机器上的 Source 是「装着 skill 的目录」，一个 skill 目录用 `path:<目录>` 坐标
  （见 §5）。这类目录在登记时拒绝，并提示改用路径坐标。
- `path` 相对清单所在目录解析：项目清单相对项目根，全局清单相对 `$HOME`。`~` 展开为
  `$HOME`。`skills:` 里 `path:` 坐标的那个目录、以及 `aliases:` 里 `path:` 目标，
  沿用同一套解析规则（别名是全局清单里的东西，所以它的相对路径相对 `$HOME`）。
- `aliases:` 的键按仓库名同一套字符集校验；值**必须**是只指一个 skill 的坐标
  （`path:`、`local:<名字>:<skill>`、`github:<owner>/<repo>:<skill>`）。指整个仓库的
  `*`、或者指向另一个别名的写法，都在读取清单时拒绝。
- **`aliases:` 是机器级的，只允许出现在全局清单里。** 项目清单里写了要在读取时报错，
  否则表格根本不会被读，用户看到的会是「名字明明写对了却不生效」。
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
| `spm clean [--dry-run]` | | 按全局与项目清单根清理无人引用的 source 缓存 |
| `spm repository add <path> [--name]` | | 把本地目录登记进全局清单，名字默认取目录名并可修改 |
| `spm repository remove <name>` | `rm` | 从全局清单与缓存目录中移除 |
| `spm repository list` | `ls` | 列出本机已注册的仓库 |
| `spm alias add <name> <spec>` | | 给一个 skill 起一个机器级名字 |
| `spm alias remove <name>` | `rm` | 忘掉一个名字 |
| `spm alias list` | `ls` | 列出本机定义的名字 |
| `spm config` | | 打印解析后的路径与配置 |

**全局选项**：`-g/--global`（作用于 `~/.config/spm/skills.yaml`）、`-q/--quiet`。

**常用子选项**：`-f/--force`（覆盖非软链接条目）、`-n/--name`
（本地目录登记时使用的名字）、`--no-prune`、`--frozen`（只校验不写）、`--json`
（只读与报告命令）。`spm clean` 另有 `--dry-run`（只预览）与 `--dry-run-code`
（只预览，并在存在待清理项时返回非零退出码）。

**写入位置由命令决定**：

- `spm repository add` 只写全局清单的 `repositories:` 段落，文件不存在时创建；登记的
  名字由用户确认（见 §7.1）。
- `spm alias add` 只写全局清单的 `aliases:` 段落，文件不存在时创建。
- `spm add` 只写当前清单。坐标指向的本地仓库已经在全局清单里登记时，只写坐标，
  项目清单里不出现 `repositories:` 段落。
- `spm add <本地目录>` 把声明写进当前清单（项目级，或 `-g` 时的全局清单）。目录根下有
  `SKILL.md` 时写 `path:<目录>`，不登记任何东西；否则登记为本地仓库（名字取
  `--name`、`skill-repository.yaml` 的 `name`，再退到目录名）。

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

仓库里的 skill 用三段坐标：

```
<类型>:<仓库>:<技能>
```

| 段 | 取值 |
| --- | --- |
| 类型 | `local` 或 `github`，清单里必写 |
| 仓库 | `local` 是注册名；`github` 是 `owner/name` |
| 技能 | skill 名，或 `*` 表示该仓库的全部 skill |

三段的形状对应 Gradle 的 `group:artifact:version`，冒号是坐标分隔符。

自身就是一个目录的 skill 用两段坐标：

```
path:<目录>
alias:<名字>
```

`path:<目录>` 取首个冒号之后的全部内容（目录名里允许出现冒号），取值非空且不得是 `*`。
这条坐标只指一个「根目录带 `SKILL.md`」的目录，不登记任何东西，因此不进 `spm find`
的搜索范围；skill 名从那个 `SKILL.md` 读出。目录里装了多个 skill 时它属于仓库，
应当改用 `spm repository add` 登记，或者直接点名其中一个 skill。

`alias:<名字>` 查全局清单的 `aliases:` 表格。它和 `path:` 是同一件事的两种写法：
`path:` 直接说目录，`alias:` 说一个本机已经起好的名字，于是项目清单不必写绝对路径。
别名**不管**来源在哪里，所以它指 github 仓库也不会把类型段说错（`local:` 做不到这一点）。

**除 `path:` 和 `alias:` 之外，清单里必须是完整的三段形式**，解析失败要指出错在哪一段。

### 5.1 命令行简写

命令行可以省掉类型段。判据确定，不靠猜测：

| 输入 | 判定 |
| --- | --- |
| `local:mine:foo`、`github:a/b:foo` | 完整坐标 |
| `local:mine`、`github:a/b` | 整个仓库（技能段按 `*` 处理） |
| `path:<目录>` | 该目录本身就是一个 skill |
| `alias:<名字>` | 全局 `aliases:` 表格里的名字 |
| `mine:foo`、`mine:*`、`mine` | 首段是已知本地仓库名 |
| `a/b:foo`、`a/b` | 首段含斜杠，按 github 解析 |
| `./path`、`~/path`、`/abs/path` | 根目录带 `SKILL.md` 时是路径坐标，否则按需登记为本地仓库 |
| `foo` | 在所有已注册仓库里查找该 skill 名 |

写入清单的坐标**始终**是完整形式（`local:` / `github:` 三段，或 `path:` / `alias:` 两段）。

**`alias:` 不能省。** 别名与仓库名是两张独立的表，裸名字只查仓库：仓库名、别名、
skill 名之间不会互相遮蔽，两者叫同一个名字也不报错（`local:x` 是仓库，`alias:x` 是别名）。

### 5.2 名字与类型校验

- 本地仓库名：`^[A-Za-z0-9._-]+$`，不得以 `.` 开头，**不得等于 `local`、`github`、
  `path` 或 `alias`**（否则简写无法判定，还会和两段坐标撞名）。别名名沿用同一套规则。
- github 仓库：必须形如 `owner/name`。
- 类型段与实际种类必须一致：`github:` 后面写了本地仓库名、`local:` 后面写了
  `owner/name`，都直接报错。
- `path:` 的值只能是目录，不能是 skill 名，也不能是 `*`；别名名里不允许出现冒号。
- `aliases:` 的值必须是只指一个 skill 的坐标：指整个仓库、指向另一个别名、或者不是坐标，
  都在读取清单时报错，并说明应该改写什么。
- 无冒号的单段写法按 skill 名查找：唯一命中才安装，多处命中**列出候选后报错**。
- `skills:` 里同一个 skill 被两条坐标指向时，先比较两者的 skill 目录 realpath：指向
  同一个目录就报「同一个目录被声明了两遍」，否则报「两个仓库都提供了这个 skill」。
- 卸载按写法匹配：`rm alias:x` 只删 `alias:x`，不会顺着别名删掉它的目标坐标；反过来
  `rm path:/x` 也不会删掉声明为 `alias:x` 的那条。

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

`path:` 坐标也必须走缓存，否则这条判据就不成立：它的目录不进搜索范围，但
`SPM_HOME/sources/path/<目录的哈希>` 会建一个指向该目录的软链接，落链接时指向这个
缓存项。**不要**为了图省事直接链到用户目录，也不要改成"目标目录自称的名字与链接名相同
就算 spm 建的"——后者会把用户自己做的跨安装目录链接当成孤儿删掉。

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
spm repository add <本地目录> [--name <名字>]
  →  确认名字（见下）
  →  ln -s <绝对路径>  <SPM_HOME>/sources/local/<名字>
  →  在全局清单的 repositories: 段落写一条 {type: local, path: <按 $HOME 读回的路径>}
```

名字就是仓库的机器级标识，所以注册时由用户确认名字：默认值是
`skill-repository.yaml` 的 `name`，没有则取目录名；交互式运行时提问，回车接受默认值，
输入别的名字即改用它。传了 `--name` 表示用户已经决定，不再提问。不能提问的环境（管道、
CI）必须显式传 `--name`，否则报错退出：代替用户挑一个名字，等于没有人看过这个名字。

校验目标存在且含至少一个 SKILL.md，发现放在建链接**之前**：目录不可用时不要留下垃圾
链接，也不为一个还不是仓库的目录询问名字。目标本身带 `SKILL.md` 时**拒绝登记**，并提示改
用 `spm add path:<目录>`：一个目录不可能既是仓库又是 skill。

记录的 `path` 必须读回同一个目录：项目清单相对自身所在目录解析，用户输入的写法在那个
基准下成立，因此原样保留，项目整体移动后依然可用；全局清单相对 `$HOME` 解析（与它的
`installDirs` 同一个基准），而命令的工作目录通常是别的目录，因此登记时按 `$HOME` 重新
写成相对形式——位于 `$HOME` 之下时写作 `~/…`，否则写绝对路径。`spm repository add` 与
`spm add <本地目录> -g` 都遵守这条规则。

**已经存在的名字指向别处时直接报错，没有强制重新绑定的开关。** 名字被占用有两种情形：
缓存目录里已有 `sources/local/<名字>` 指向别的目录；全局清单的 `repositories:` 里
`<名字>` 声明了别的路径。两种情形都拒绝登记并要求改名，提示语给出
`spm repository remove <名字>` 作为忘掉旧名字的办法。交互式提问时被占用的名字连默认值
一起被拒绝，必须输入新的名字。凡是会写进 `sources/local/` 的路径都走同一条判定，
`spm add <本地目录>` 也一样。

### 7.2 缓存目录布局

```
~/.config/spm/sources/
  local/<名字>                 →  软链接，指向本地目录
  github/<owner>/<repo>        →  git clone，跟随远端默认分支
  path/<哈希>                  →  软链接，指向 `path:` 坐标说的 skill 目录
```

三类分属三个命名空间。本地名字里不含斜杠，因此不可能与 github 的 `owner` 相互碰撞；
`path/` 下面的项按目录 realpath 的哈希命名，所以同名不同地的两个 skill 目录不会撞车。

`local/` 与 `github/` 是搜索范围（`spm find`、裸 skill 名查找都只看这两处）；`path/` 不是，
没有别的代码读它，它存在只为让 prune 的判据继续成立（§6.3）。`path:` 坐标不写清单的
`repositories:` 段落，所以它不算登记。

**同一个本地目录只登记一次。** 按路径注册时，先比较 realpath：如果这个目录已经是某个
已注册仓库的根，必须**复用那个名字**，而不是按目录名再登记一遍。比较时必须用
**realpath**，注册项本身是软链接，拿链接路径和用户给的目录比永远不会相等。

若该目录是某个已注册仓库的**子目录**，要看它是不是一个 skill：是 skill 就走路径坐标
（`path:<目录>`，不必登记，也不会和已有的登记重名）；不是 skill 就报错并提示
`spm add local:<名字>:<skill>`。

### 7.3 自举（Bootstrap）

`spm i` 遇到清单里声明了、但本机还没有的仓库，必须**自动建立**：

- `local`：按 `path` 建软链接
- `github`：clone

所以一台新机器 + 一份项目清单 + 一份全局清单就能从零还原，**不需要先手动注册**。
新机器上没有全局清单时，项目清单里的 `local:<名字>` 会报错并给出 `spm repository add`
的命令，这是分层的必然代价——与 Gradle 引用 `mavenLocal()` 的处境相同。

### 7.4 `aliases:`（机器级名字）

```
spm alias add md-lint path:~/Code/ButCool/md-lint/skills/md-lint
  →  在全局清单的 aliases: 段落写一条 md-lint: path:~/Code/.../md-lint
  →  不建任何缓存软链接，不装任何东西
```

它解决的场景：**一个 skill 只想在本机登记一次，安装与否由各份项目清单自己决定**。
`repositories:` 做不到这件事，因为它只能给「装着 skill 的目录」起名字，而一个自身就是
目录的 skill 不允许登记（§2.2）。

规则：

- 只写全局清单。项目清单里出现 `aliases:` 要在读取时就报错，并指出去全局清单里写。
- `spm alias add` 先校验名字与目标形状，再写盘；`path:` 目标会展开成绝对路径后再存，
  因为表格是机器级的，相对值会相对 `$HOME` 解析，而那几乎肯定不是用户打 `./skills/x`
  时想要的。`path:` 目标还会先检查目录里有 `SKILL.md`。
- `local:` 目标要求这个名字本机已经知道；它的 skill 不在这里校验（先把名字起好、等
  `spm i` 再把仓库拉下来是合理的顺序），用到时由 `spm i` 与 `doctor` 报缺口。
  `github:` 目标不校验，否则「起个名字」会变成网络操作。
- 别名本身不安装任何东西。只有 `skills:` 里的 `alias:<名字>` 才会安装。
- 别名不进 `spm find`、不进裸 skill 名查找、不进 `spm repository list`：它不是 Source，
  「登记就是扩大搜索范围」那句话描述的是 `repositories:`。名字表用 `spm alias list` 看。
- 别名不指向整个仓库（用 `repositories:`），也不指向另一个别名（读取清单时拒绝）。
- 全局清单的 `skills:` 里还在用某个别名时，`spm alias remove` 拒绝删除并指出去掉那条
  声明：否则那份清单会变成无法解析的状态。

### 7.5 项目清单根登记

项目级安装写操作成功完成后，把该项目的 `skills.yaml` 登记为机器级清理根：

```
<SPM_HOME>/projects/<清单规范路径的哈希>  →  <项目>/skills.yaml
```

登记项是软链接，不使用数据库或引用计数。同一份清单重复安装时复用同一条链接。项目或清单
删除后链接自然悬挂，不再构成清理根，并由下一次 `spm clean` 删除。`spm list`、普通
`spm doctor` 等只读命令不登记；`spm install --frozen` 只校验，也不登记。项目级
`install`、`add`、`remove`、`update` 与 `doctor --fix` 的共享安装写路径负责登记，全局
scope 不登记。

### 7.6 source 缓存清理

`spm clean` 的根集合是全局清单加上 §7.5 中目标仍存在的全部项目清单。命令先读取并校验
全部根，再进行任何删除；任一根无效时立即失败并保持缓存原样。它只从清单坐标计算可达性，
不扫描安装结果反推清单：

- `local:<名字>:<skill>` 标记 `sources/local/<名字>`；`repositories:` 声明本身也保留对应
  local 缓存，避免自动破坏用户登记。
- `github:<owner>/<repo>:<skill>` 标记对应 clone。
- `path:<目录>` 按所属清单的路径基准计算哈希，标记对应 path 缓存。
- `alias:<名字>` 标记该全局 alias 已使用，并展开其目标坐标继续标记。

无人引用且没有声明保护的三类缓存都可删除。`local` 与 `path` 只删除缓存软链接，绝不删除
链接目标的本地目录；缓存位置出现真实文件或目录时报告为 foreign 并保留。仍有引用或声明的
失效软链接、无效 git checkout 报告为 broken 并保留。无人引用的全局 `repositories:` 和
`aliases:` 只报告，给出 `spm repository remove` 或 `spm alias remove`，不自动改写清单。

`spm clean --dry-run` 只预览；`--json` 输出根集合、每个缓存项的状态和动作；
`--dry-run-code` 隐含预览，并在存在待清理缓存或悬挂根时返回非零退出码。默认清理模式即使
发现并删除条目也成功退出。清理完成后再次执行必须零删除。

---

## 8. 明确不做的事

做错了就会退回"不好用"的老路：

| 不做 | 原因 |
| --- | --- |
| **版本求解** | SKILL.md 之间没有依赖关系，清单是平的 |
| **ref 钉住** | github 仓库跟随默认分支即可，清单里不出现版本概念 |
| **给仓库起别名** | 仓库名只来自注册名或 `owner/name`。`aliases:` 的名字指向的是**一个 skill**，不是仓库，所以不会出现「同一个仓库两个名字」；要给整个仓库起名字就登记它 |
| **github 仓库进注册表** | 路径本身就是标识，登记它等于把同一件事写两遍 |
| **数据库** | 状态 = 清单 + 磁盘上的软链接。换台机器/换个同事，`git diff` 就能看全 |
| **引用计数** | 安装链接用 §6.3 的归属判据；source 清理用 §7.5 的清单根集合做标记，不维护计数 |
| **稳定 ID / UUID** | 改名是作者自己的事 |
| **反向扫描** | 扫描已安装内容反推清单。npm 也没有，不是缺口 |
| **group / 组合概念** | 整仓库安装 + 清单本身已够表达"一套 skill" |

---

## 9. 容易做错的地方（务必注意）

### 9.0 别把别名当成第二种 Source

别名很容易被顺手当 Source 用，一当成就必须回答「它参不参与 `spm find`、参不参与裸名字、
要不要建缓存软链接」，最后长出第二套 §6.3 判据。它只是一张「名字 → 一个 skill」的表格：
只在写 `alias:<名字>` 时生效，不装任何东西，不进任何搜索范围。想扩大搜索范围就登记仓库。

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

归并只能在同一个仓库内部发生。`path:` 坐标各指一个目录，**永远不能代表另一条坐标**，
也不能被整仓库条目代掉。

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

# 不加 --name：交互式询问名字，默认取目录名或 skill-repository.yaml 的 name
# 名字已被别的目录占用时要求改名，回车不接受被占用的默认值
# 非交互环境没有 --name 则报错退出，不替用户选名字
spm repository add ~/Code/Skills/Pdf

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
| 登记指向了一个 skill 目录（旧配置，应用 `path:` 坐标取代） | error |

**一个根因只产生一条诊断**。同一件事不要被两条检查路径各报一次，否则汇总计数失真，
用户也无法判断该按哪一级处理。仓库目录已消失这一种情况，由解析阶段报（那里还知道是哪个
仓库），`doctor` 不要再单独查一遍路径。

### 10.4 必须有的测试

1. 坐标解析：三段形式、`path:` 两段形式（含目录名带冒号）、整仓库、类型与仓库不匹配、
   段数不足或过多、非法名字、`path:` 的值是 `*` 或空
2. 清单读写往返 + 确定性排序 + 非法坐标与非法仓库名被拒
3. 发现边界：遇 SKILL.md 停、exclude 整段匹配、跳过目录、深度上限
4. **skill 名拒绝 `..` 和点开头**
5. **安装幂等**（同清单跑两次结果一致）
6. 多 `installDirs` 下每个目录都正确落链与清理
7. prune 只删指向缓存目录的链接，**手工链接不动**；`path:` 坐标的链接也落在缓存里，
   所以删掉声明后能在同一条路径上被清掉
8. 冲突的 spec **不得污染清单**
9. 已有登记的路径被复用时**不产生重复声明**
10. 声明了但本机未注册的本地仓库，`spm i` 能自动建立链接
11. **全局清单里的登记能被项目直接引用**，项目清单里不出现重复路径
12. **skill 目录只能走 `path:` 坐标**：登记被拒、`spm add <目录>` 写路径坐标、
    两条坐标指同一个目录时报「同一个目录被声明了两遍」
13. `path:` 坐标不登记任何东西，`spm find` 与裸 skill 名查找看不到它；删掉声明后
    `spm i` 与 `spm doctor --fix` 都能清掉它的链接
14. **别名**：`alias:<名字>` 解析到表格里的目标、写回清单时仍是 `alias:<名字>`、
    同一个别名跑两次结果一致；未知别名报错并给出 `spm alias add`；项目清单里出现
    `aliases:` 被拒；别名不进裸名字查找也不进 `find`；别名与仓库名可以同名而不互相遮蔽
15. **项目根登记**：项目级安装写操作幂等登记；全局、只读与 `--frozen` 不登记；项目删除后
    悬挂根不参与标记并由 clean 清理；登记目录里的真实文件保持原样
16. **source clean**：多项目共享缓存只要仍有一个根引用就保留；local、github、path 三类
    无人引用缓存均清理；local/path 目标目录保持原样；全局 repository/alias 只报告；
    broken 与 foreign 条目保持原样；无效根导致零删除；dry-run、JSON、dry-run-code 与二次
    clean 的结果符合 §7.6

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
