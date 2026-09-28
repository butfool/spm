---
Base:
  - Tasks
  - Specs
TaskType:
  - Feature
StartDate: 2026-09-28
EndDate: ""
Status:
  - Doing
Projects:
  - SPM
SpecStatus: Implemented
---

<!--图片资源：图片、截图和示意图统一存放在本任务目录的 Assets/ 目录，文档中使用 Markdown 图片语法按相对路径引用，例如 ![说明](Assets/文件名.png)-->

# Specify

<!--只对齐要做什么：问题、期望结果、范围和用户明确确认的硬约束；实现方案属于 Plan-->

## Summary

spm 的 source 缓存与机器级登记只增不减：清单里的坐标会让 `spm i` 自动在缓存里建立条目，而没有任何命令能回答某个条目是否仍被某份清单引用。期望：用户能看到本机哪些 source 已无人引用（含已失效的条目），并把这些条目清理掉。

## Background

- **术语**：spm 把仓库的机器级实体称为 source，缓存落在 `<SPM_HOME>/sources/` 下，分三个命名空间：`local/<名字>` 是指向本地目录的软链接，`github/<owner>/<repo>` 是 git clone，`path/<哈希>` 是指向 `path:` 坐标所指 skill 目录的软链接[^1]。
- 缓存条目是安装过程的副产物，并非用户显式登记的结果：清单声明了本机还没有的仓库时，`spm i` 会自动建立它（local 建软链接，github 执行 clone）[^2]。因此任何项目跑一次安装都会往缓存里写入条目，全局清单不参与这个决定。
- 机器级登记只有两处：全局清单的 `repositories:` 与 `aliases:`。`github:` 坐标按设计永不进入登记表，因为 `owner/name` 本身就是标识[^3]。结果是全局清单完全不知道本机存在哪些 github clone。
- 项目级 `rm` 按设计不得触碰全局清单的 `repositories:` 段落[^4]。因此登记条目只能由用户手工逐个 `spm repository remove` 清除，没有任何自动路径。
- 现有的自动清理能力全部作用在「链接」这一层：安装时的 prune 只删「目标落在 `sources/` 之内、且当前清单未声明」的软链接，作用域限于当前清单的安装目录；`spm doctor` 的 `orphan_link` 是同一判据的诊断形式[^5]。两者都只看当前清单，也不看缓存条目自身。
- `sources/path/<哈希>` 条目没有任何删除路径：`ensurePathSource` 是唯一的创建点，全仓库不存在删除该目录的代码[^6]。
- github clone 同样无法删除：`removeGithubSource` 已定义，但在 `src/` 与 `test/` 中都没有调用点[^7]。
- `spm repository list` 只能发现「全局清单声明了但本机未注册」，不能发现「已注册但没有任何清单引用」；其 `declared` 字段的含义是「写在全局清单里」，与「是否被使用」无关[^8]。
- 原始设计明确排除了数据库、引用计数、反向扫描；安装语义一节说明 prune 判据取代了「物料表 + 来源表 + 引用计数」整套记账[^9]。本任务接受新增由符号链接组成的项目清单根集合，它不引入数据库或引用计数，也不从安装结果反推清单；`docs/PROMPT.md` 需要补充这项新的机器级状态。
- 实测一：在隔离的 `SPM_HOME` 下注册一个本地仓库，在 proj1 安装 `local:Demo:skill-a`，随后删除整个 proj1。`spm repository list` 仍把它列为一条正常条目，没有任何「无人引用」标记；从 proj2 运行 `spm doctor` 输出 `healthy`，退出码 0[^10]。
- 实测二：用 `path:` 坐标安装后删除该声明并重跑 `spm i`，安装目录里的链接被 prune 删除，但 `sources/path/<哈希>` 条目留在原地；`spm repository list` 与 `spm doctor` 都不显示它[^10]。
- 实测三：删除已登记目录本身后，`spm repository list` 把该条目报成 `0 skills` 并正常退出，`spm doctor -g` 输出 `healthy`、退出码 0。只有当某份清单的 `skills:` 真正引用到它时，`spm doctor` 才报 error[^10]。

## Rules

<!--默认留空。只有用户主动提出且明确确认必须遵守的不可协商约束才能填写；不得加入 AI 推导的技术偏好-->
<!--格式要求：UnorderedList-->
<!--内容要求：只能如下场景补充：1. 用户手动补充 2. 用户要求 AI 进行补充-->

<!-- specool:example-start -->
- 没有用户明确确认的硬约束时保持为空
<!-- specool:example-end -->

## Goal

- `spm clean` 以全局清单和本机登记且仍然存在的项目清单为根集合，列出 source 缓存中每个条目的引用状态，明确区分「仍被引用」与「已无人引用」。
- `spm clean` 删除无人引用的缓存条目，且清理过程可核对：执行前后都能列出被判定为无人引用的条目。
- `spm clean --dry-run` 只预览不落盘；`spm clean --json` 提供机器可读结果并列出本次使用的根清单。
- 清理范围包含 `sources/local/`、`sources/github/` 与 `sources/path/`，并且不删除任何本地目录本身：本地仓库登记指向的目录、`path:` 坐标指向的目录，在清理后仍原样存在。
- 已失效的缓存条目能被识别：登记指向的目录已不存在、`path:` 条目的目标已不存在，或 github 缓存不再是有效的 git checkout。
- 全局清单里已无人引用的 `repositories:` 与 `aliases:` 条目只报告，不自动删除；输出给出对应的 `spm repository remove` 或 `spm alias remove` 命令。
- 没有无人引用条目时，`spm clean` 明确报告「无」并以成功状态结束；默认模式发现待清理项仍返回成功，`--dry-run-code` 在存在待清理项时返回非零退出码。
- 既有行为不回归：`spm i` 的幂等性、安装时的链接 prune 判据、`spm doctor` 现有各类诊断的数量与级别、`spm repository add/remove/list` 的现有输出，均与本次改动前一致。

## Open Questions

- [x] 判定「无人引用」要以哪些清单为基准？结论：以全局清单和本机项目清单登记处中仍然存在的全部清单为根集合；输出列出本次实际使用的根清单。
- [x] 是否接受为此新增机器级状态？结论：接受新增由符号链接组成的项目清单登记处；项目执行会改变安装状态的 spm 命令时登记其 `skills.yaml`，目标不存在的悬挂链接不再构成根。该状态不采用数据库或引用计数，也不扫描安装结果反推清单。
- [x] 全局清单里已无人引用的 `repositories:` 与 `aliases:` 条目是否要自动删除？结论：只报告，不自动删除；输出给出已有的移除命令，由用户明确执行。
- [x] `sources/path/<哈希>` 条目是否纳入本能力的范围？结论：纳入，与 `local`、`github` 缓存条目统一进行引用判定和清理。
- [x] 清理是否设置宽限期？结论：不设置宽限期；缓存条目均可按需重建，`--dry-run` 提供删除前预览，避免采用已知不可靠的访问时间判定。
- [x] 无人引用的条目是否影响命令退出码？结论：默认模式返回成功；`--dry-run-code` 在存在待清理项时返回非零退出码，供 CI 使用。

# Related

<!--历史创建的主题相关任务；条目由任意阶段根据研究主题手工补充-->
<!--格式要求：UnorderedList，每条形如 - YYYY-MM-DD：[[TaskName]]-->
<!--内容要求：仅列主题与本任务直接相关的任务；按 StartDate 倒序，最新在上；相关性来自主题判断，不要用命令按 Projects/TaskType 等元数据匹配-->

- 2026-09-18：[[FixDoctorDuplicateFindings]]

# Plan

<!--引用外部执行计划；条目由 specool task plan add / tick 维护-->
<!--格式要求：CheckList-->
<!--内容要求：目前仅仅允许单个 CheckList；不允许拆分多 PLAN-->

- [x] 实现项目根登记与 spm clean 可达性清理：[[PruneUnusedSources/Plan]]

# TestCase

<!--关联独立测试清单产物；由 specool task render testcase 维护-->
<!--格式要求：UnorderedList，仅保留单一 TestCases 链接-->

<!-- specool:example-start -->
- TestCase：`[[TestCases]]`
<!-- specool:example-end -->

# Implement

<!--真实执行过程的记录-->

## 实现问题记录

<!--方案里什么地方执行的不顺利，记录下来-->
<!--格式要求：每个问题一个H3；字段为：场景、问题、解决方案、是否需要深度调研-->

<!-- specool:example-start -->
### 方案中某细节无法实现

- **场景**：
- **问题**：
- **解决方案**：
- **是否需要深度调研**：
<!-- specool:example-end -->

## 自测问题记录

<!--方案执行完成后，用户自测的时候发现的问题，记录下来-->
<!--格式要求：每个问题一个H3；同上一章节-->

# Reference

## Explore

<!--引用外部 Explore 结果文件；条目由 specool task ref explore <Topic> 维护-->
<!--格式要求：CheckList-->

<!-- specool:example-start -->
- Topic：`[[ExploreName]]`
<!-- specool:example-end -->

## Research

<!--引用外部 Research 结果文件；条目由 specool task ref research <Topic> 维护-->
<!--格式要求：CheckList-->

- Topic：[[PruneUnusedSources/Researchs/PackageManagerStorePruning]]

[^1]: `docs/PROMPT.md` §7.2「缓存目录布局」。
[^2]: `docs/PROMPT.md` §7.3「自举（Bootstrap）」。
[^3]: `docs/PROMPT.md` §8「明确不做的事」：github 仓库进注册表。
[^4]: `docs/PROMPT.md` §6.4「移除」。
[^5]: `docs/PROMPT.md` §6.3「prune 的判据（核心设计）」；`src/core/doctor.ts` 的 `orphan_link` 分支。
[^6]: `src/core/source.ts` 的 `ensurePathSource` 是 `sources/path/` 的唯一写入点；全仓库检索 `pathCacheDir`、`pathSourceEntry`、`ensurePathSource`，只命中该文件的定义与 `src/core/resolve.ts:411` 的调用。
[^7]: `src/core/source.ts` 定义了 `removeGithubSource`；全仓库检索其调用点，只命中该定义自身与 `dist/` 中的类型声明。
[^8]: `src/cli/commands/repository.ts` 的 `repositoryList`。
[^9]: `docs/PROMPT.md` §8「明确不做的事」与 §6.3。
[^10]: 2026-09-28 在 spm v0.1.0 上实测，`SPM_HOME=/tmp/spm-gc-probe/home`，未改动任何真实配置。proj1 声明 `skills: [local:Demo:skill-a]`；proj2 先声明 `skills: [path:/tmp/spm-gc-probe/solo]`，随后改为 `skills: []` 并重跑 `spm i`。
[^11]: `src/cli/commands/doctor.ts` 的 `failOnInvalidSkills`：只有 `invalid_skill` 决定退出码，其余类别保持原有行为。
[^12]: git 文档 `git-gc(1)`：`--prune=<date>` 默认清理两周前的对象，可用 `gc.pruneExpire` 覆盖。
