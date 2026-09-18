# 问题追踪器（Issue）：本地 Markdown

本仓库的问题单（Issue）和规格说明存放在 `.scratch/` 下的 Markdown 文件中。

## 操作约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 规格说明为 `.scratch/<feature-slug>/spec.md`
- 实现任务单为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起编号，不要合并成单个 tickets 文件
- 分诊状态写在每个任务单文件顶部附近的 `Status:` 行
- 评论和讨论追加到文件末尾的 `## Comments` 标题下

## 技能要求发布到 Issue 追踪器时

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在则创建）。

## 技能要求获取相关任务单时

读取引用路径上的文件。用户通常会直接给出路径或任务单编号。

## 寻路（Wayfinding）操作

供 `/wayfinder` 使用。**地图（map）**是一个文件，**子任务单**各占一个文件。

- **地图**：`.scratch/<effort>/map.md`（备注 / 截至目前的决定 / 未知信息）。
- **子任务单**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 起编号，正文写问题。`Type:` 记录类型（`research` / `prototype` / `grilling` / `task`）；`Status:` 记录 `claimed` / `resolved`。
- **阻塞关系**：文件顶部附近写 `Blocked by: NN, NN`。所列文件全部为 `resolved` 后，任务才算解除阻塞。
- **前沿任务**：扫描 `.scratch/<effort>/issues/`，选出仍打开、未阻塞、未认领的文件，按编号取第一个。
- **认领任务**：先把 `Status:` 改为 `claimed` 并保存，再开始工作。
- **解决任务**：在 `## Answer` 标题下追加答案，将 `Status:` 设为 `resolved`，再把上下文指针追加到 `map.md` 的「截至目前的决定」。
