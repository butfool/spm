# 原始提示词与拍板记录

> 这份文档是 `spm` 的**需求源头**。把它整份交给一个 AI agent，它应当能产出一个行为等价的 `spm`。
> 实现规格见 [`SPEC.md`](./SPEC.md)；本文只记录"当初是怎么提的、怎么定的"。

---

## 一、最初的提示词（逐字）

```
/Users/butcool/Code/ButCool/spm
我想要让你帮我做一个类似 npm/maven 的 SKILL 管理工具.

现在这个 SKills 工具不好用.

我希望做成声明式的依赖管理工具

并且类似 maven 有全局配置和本地仓库路径(~/.config/spm/settings.yaml)

local/github 两种类型的仓库都支持

但是本地的也是要注册一下才能知道这个 source 的路径的 (通过软连接进行 register 的动作)

同时支持 install 单个和一整个 source 两种方式.

命令行操作类似于 npm,比如 install/i 等等各种命令集合
```

**背景**：`~/Code/ButCool/skills` 是一个已有的 Go + SQLite 实现，管的是同一批 `SKILL.md`。
新项目不是它的重构，是**另起炉灶**，只在领域细节上参考它（见 [`SPEC.md` § 8](./SPEC.md)）。

---

## 二、追问与拍板（逐字）

原始提示词留了几处关键歧义，以下是逐轮澄清的原话。**这些回答和提示词本身同等重要**——没有它们，实现会走向完全不同的方向。

### 第 1 轮

| 问题 | 回答 |
| --- | --- |
| spm 和现有 skills 工具的关系？ | **全新 nodejs 项目!** |
| "声明式依赖管理"具体到哪一层？ | **清单,但是不提供版本的概念!配置文件名字叫 skills.yaml 吧** |
| 本地和 github source 的"版本/引用"怎么定义？ | **路径 / git tag+commit（推荐）** |

### 第 2 轮

| 问题 | 回答 |
| --- | --- |
| Node 项目具体用什么？ | **TypeScript + Node（推荐）** |
| 本地 source 的 "register（软链接）" 具体怎么做？ | **软链接到 spm 仓库目录（推荐）** |
| skills.yaml 放哪里、装到哪里？ | **全局的话, 应该是在 `~/.config/spm/skills.yaml` 中才对! 另外, 项目自行指定 SKILL 的安装目录, 比如 `./claude/skills` 或者 `./.agents/skills` 默认就是后者** |

### 计划评审阶段的两条否决

1. **安装目标必须是数组**

   > `installDir` 应该是一个数组列表!

2. **仓库自描述文件要极简，不要 ID 体系**

   > alias 冲突的问题可以参考本项目的处理, 本地目录中都有一个 `/Users/butcool/Code/ButCool/skills/skills/skill-repository.yaml` 类似这种的文件来定义都支持哪些 SKILL; 这样可以解决路径移动的问题.
   >
   > **注意不要再用 复杂的 hash-id 了, 这个文件仅仅为了解决仓库名称的问题, 以及 ignore 之类的可见范围, 不解决 skill 名称变动之类的问题! 那种要交给他自己维护!**

### 实现过程中确认的两点

1. **全局清单机制保留（不学 npm）**

   > 没事的, 我们这一点可以不学习 npm (我是说 `npm i -g` 应该仅仅安装吧, 没有清单机制, 但是我觉得我们的 spm 如果有这个机制还挺好的)

2. **整源安装的写法**

   > 看你的语法, 如果安装某一个 Source 的全部 SKILL, 写法是怎么样的啊?

   → 原实现只有 `alias/*`，实测发现 `*` 会被 shell 抢先展开（zsh 默认 `nomatch` 直接报
   `no matches found`；当前目录若有同名文件夹则静默展开成该目录内容）。
   因此新增**裸别名**形式：`spm add mine`。详见 [`SPEC.md` § 5](./SPEC.md)。

---

## 三、必须避开的东西

上面第 2 条否决点是最容易做错的。总结成一句：

> **不要为了"追踪身份"引入任何形式的稳定 ID。**

现有 `skills` 工具的 `skill-repository.yaml` 长这样：

```yaml
# ❌ 不要这样做
id: 7f89021c-13d7-4f70-8c26-ae983922324e        # 仓库 UUID
name: skills
skills:
    obsidian-workflow-import-files:
        id: 9e717835-2d98-4cfc-929c-d36899ec8d8b  # 每个 skill 一个 UUID
    skills-dev:
        id: e5796ec3-17eb-499a-9108-25ed3deb7a0a
```

`spm` 只要这一半：

```yaml
# ✅ 只解决"这个仓库叫什么"和"哪些内容可见"
name: mine
exclude:
  - drafts
maxDepth: 3
```

`id` 的存在意义是"skill 改名后还能认出是同一个"，这是**作者自己的事**，工具不该管。

---

## 四、规模参考

一个能跑的实现大约：

| | 数量 |
| --- | --- |
| `src/**/*.ts` | 28 个 |
| `test/` 文件 | 4 个 |
| 测试用例 | 56 |
| 运行时依赖 | 4 个（`commander` / `yaml` / `zod` / `picocolors`） |
| 数据库 | 无 |

验收方式见 [`SPEC.md` § 10](./SPEC.md)。
