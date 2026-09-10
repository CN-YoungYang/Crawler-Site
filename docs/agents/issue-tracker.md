# 问题追踪器（Issue）：GitHub

本仓库的问题单（Issue）和规格说明存放在 GitHub Issues 中。所有相关操作使用 `gh` 命令行工具。

## 操作约定

- **创建 Issue**：`gh issue create --title "..." --body "..."`。多行内容使用 heredoc。
- **查看 Issue**：`gh issue view <number> --comments`，必要时使用 `jq` 筛选评论并读取标签。
- **列出 Issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，并按需指定 `--label` 和 `--state`。
- **评论 Issue**：`gh issue comment <number> --body "..."`
- **添加或移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭 Issue**：`gh issue close <number> --comment "..."`

目标仓库由 `git remote -v` 推断；在本仓库副本中执行时，`gh` 会自动识别目标仓库。

## PR 是否作为分诊入口

**PR 作为需求入口：否。**（如果本仓库将外部 PR 视为功能请求，可改为 `yes`；`/triage` 会读取此配置。）

如果改为 `yes`，PR 将使用与 Issue 相同的标签和状态，并对应使用 `gh pr` 命令：

- **查看 PR**：`gh pr view <number> --comments` 和 `gh pr diff <number>`。
- **列出待分诊的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，仅保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的 PR，排除 `OWNER`、`MEMBER` 和 `COLLABORATOR`。
- **评论、管理标签或关闭 PR**：使用 `gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 Issue 和 PR 共用编号空间，因此单独看到 `#42` 时，先用 `gh pr view 42` 判断；如果不是 PR，再使用 `gh issue view 42`。

## 技能要求发布到 Issue 追踪器时

创建一个 GitHub Issue。

## 技能要求获取相关任务单时

执行 `gh issue view <number> --comments`。

## 寻路（Wayfinding）操作

供 `/wayfinder` 使用。**地图（map）**是一个 Issue，**子 Issue** 作为具体任务单。

- **地图**：创建一个带 `wayfinder:map` 标签的 Issue，内容包含备注（Notes）、截至目前的决定（Decisions-so-far）和未知信息（Fog）。命令：`gh issue create --label wayfinder:map`。
- **子任务单**：使用 GitHub 子 Issue API 将任务单关联到地图（`gh api` 的 `sub-issues` 接口）。如果仓库未启用子 Issue，则在地图正文中维护任务清单，并在子任务单正文开头写 `Part of #<map>`。标签使用 `wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。任务认领后分配给负责开发者。
- **阻塞关系**：使用 GitHub 的**原生 Issue 依赖**，这是界面可见的标准表示。通过 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加依赖；其中 `<blocker-db-id>` 是阻塞 Issue 的数字数据库 ID，可用 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取，不是 `#number` 或 `node_id`。GitHub 通过 `issue_dependencies_summary.blocked_by` 报告仍处于打开状态的阻塞项。如果不支持依赖关系，则在子任务单正文开头写 `Blocked by: #<n>, #<n>`。所有阻塞项关闭后，任务才算解除阻塞。
- **前沿任务查询**：列出地图下仍打开的子任务（使用 `gh issue list --state open`，限定到地图的子 Issue 或任务清单），排除存在打开阻塞项或已有负责人的任务，按地图中的顺序选择第一个。
- **认领任务**：`gh issue edit <n> --add-assignee @me`，这是本次会话的第一次写操作。
- **解决任务**：先执行 `gh issue comment <n> --body "<answer>"`，再执行 `gh issue close <n>`，最后将上下文指针（gist + 链接）追加到地图的“截至目前的决定”中。
